param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$PidFile
)

$ErrorActionPreference = 'Stop'
if ($env:RUNNER_OS -ne 'Windows' -or !$env:RUNNER_TEMP) {
    throw 'The update launcher requires an isolated Windows runner.'
}
$Executable = [IO.Path]::GetFullPath($Executable)
$PidFile = [IO.Path]::GetFullPath($PidFile)
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (![IO.Path]::GetFileName($Executable).Equals('serial-workbench.exe', [StringComparison]::OrdinalIgnoreCase) -or
    !$Executable.StartsWith($runnerRoot, [StringComparison]::OrdinalIgnoreCase) -or
    !$PidFile.StartsWith($runnerRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The test executable and receipt must be in the runner fixture.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class UpdateFixtureJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job, int kind, ref ExtendedLimits limits, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    public static SafeFileHandle Enter()
    {
        const int ExtendedLimitInformation = 9;
        const uint BreakawayOk = 0x800;
        var job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        if (job.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create updater fixture Job");

        // The launcher, both desktops and the coordinator inherit this owned Job.
        // The Host uses the production CREATE_BREAKAWAY_FROM_JOB path explicitly.
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = BreakawayOk;
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, GetCurrentProcess()))
        {
            var error = Marshal.GetLastWin32Error();
            job.Dispose();
            throw new Win32Exception(error, "Cannot configure updater fixture Job");
        }
        return job;
    }
}
'@

$job = [UpdateFixtureJob]::Enter()
$desktop = $null
try {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.UseShellExecute = $false
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($Executable)
    $desktop = [Diagnostics.Process]::Start($start)
    [IO.File]::WriteAllText($PidFile, $desktop.Id.ToString([Globalization.CultureInfo]::InvariantCulture))
    $desktop.WaitForExit()
    $exitCode = $desktop.ExitCode
}
finally {
    if ($desktop) { $desktop.Dispose() }
    $job.Dispose()
}
exit $exitCode

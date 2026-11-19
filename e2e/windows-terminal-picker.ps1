param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][uint32]$ApplicationPid,
    [Parameter(Mandatory = $true)][ValidateSet('Open', 'Save')][string]$Action,
    [Parameter(Mandatory = $true)][string]$FilePath
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'The native picker probe requires the independent Windows CI desktop.'
}
if (![IO.Path]::IsPathRooted($FilePath)) {
    throw 'A full fixture path is required.'
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class TerminalPickerWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
}
'@

function Test-ApplicationWindow([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    [uint32]$windowPid = 0
    [void][TerminalPickerWindow]::GetWindowThreadProcessId($Handle, [ref]$windowPid)
    return $windowPid -eq $ApplicationPid
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$dialog = $null
while ($clock.Elapsed.TotalSeconds -lt 15) {
    $handle = [TerminalPickerWindow]::GetForegroundWindow()
    if (Test-ApplicationWindow $handle) {
        $owner = [TerminalPickerWindow]::GetWindow($handle, 4)
        if (Test-ApplicationWindow $owner) {
            $candidate = [Windows.Automation.AutomationElement]::FromHandle($handle)
            if ($candidate.Current.ClassName -eq '#32770') {
                $dialog = $candidate
                break
            }
        }
    }
    Start-Sleep -Milliseconds 50
}
if (!$dialog) { throw "No foreground $Action file dialog owned by application $ApplicationPid." }

$scope = [Windows.Automation.TreeScope]::Descendants
$id = [Windows.Automation.AutomationElement]::AutomationIdProperty
$fileName = $dialog.FindFirst($scope, [Windows.Automation.PropertyCondition]::new($id, '1148'))
if ($fileName -and $fileName.Current.ControlType -ne [Windows.Automation.ControlType]::Edit) {
    $edit = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [Windows.Automation.ControlType]::Edit
    )
    $fileName = $fileName.FindFirst($scope, $edit)
}
$confirm = $dialog.FindFirst($scope, [Windows.Automation.PropertyCondition]::new($id, '1'))
if (!$fileName -or !$confirm -or $confirm.Current.Name.Replace('&', '') -ne $Action) {
    throw "Unexpected controls in the foreground $Action file dialog."
}
$fileName.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($FilePath)
$confirm.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()

$clock.Restart()
while ($clock.Elapsed.TotalSeconds -lt 5) {
    if (![TerminalPickerWindow]::IsWindow($handle) -and [TerminalPickerWindow]::GetForegroundWindow() -eq $owner) {
        [ordered]@{
            action = $Action
            applicationPid = $ApplicationPid
            dialog = $handle.ToInt64()
            owner = $owner.ToInt64()
            path = $FilePath
            returnedFocus = $true
        } | ConvertTo-Json -Compress
        exit 0
    }
    Start-Sleep -Milliseconds 50
}
throw "The $Action dialog did not close and return foreground focus to its owner."

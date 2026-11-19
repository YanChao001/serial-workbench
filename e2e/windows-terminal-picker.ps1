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

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class TerminalPickerWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    private delegate bool EnumerateWindow(IntPtr window, IntPtr extra);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumerateWindow callback, IntPtr extra);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr WriteText(IntPtr window, uint message, UIntPtr size, string value, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr ReadText(IntPtr window, uint message, UIntPtr size, StringBuilder value, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true, SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, UIntPtr parameter, IntPtr extra);

    public static string WindowClass(IntPtr window) {
        var name = new StringBuilder(64);
        return GetClassName(window, name, name.Capacity) == 0 ? "" : name.ToString();
    }

    public static bool ClickButton(IntPtr window) {
        const uint buttonClick = 0x00F5;
        return PostMessage(window, buttonClick, UIntPtr.Zero, IntPtr.Zero);
    }

    public static IntPtr FileNameEdit(IntPtr dialog, uint applicationPid, bool captureSave) {
        const int fileNameComboId = 1148;
        const int fileNameEditId = 1152;
        IntPtr result = IntPtr.Zero;
        IntPtr suggestedName = IntPtr.Zero;
        int suggestedNames = 0;
        var name = new StringBuilder(32);
        EnumChildWindows(dialog, (child, extra) => {
            uint pid;
            GetWindowThreadProcessId(child, out pid);
            if (pid != applicationPid || GetClassName(child, name, name.Capacity) == 0 || name.ToString() != "Edit") {
                return true;
            }
            for (IntPtr control = child; control != dialog && control != IntPtr.Zero; control = GetParent(control)) {
                int id = GetDlgCtrlID(control);
                if (id == fileNameComboId || id == fileNameEditId) {
                    result = child;
                    return false;
                }
            }
            if (captureSave && Regex.IsMatch(ReadFileName(child, 256), @"\A[0-9]{8}T[0-9]{6}Z_.+_[0-9a-f]{12}(\.swb)?\z")) {
                suggestedName = child;
                suggestedNames++;
            }
            return true;
        }, IntPtr.Zero);
        if (result != IntPtr.Zero) return result;
        return suggestedNames == 1 ? suggestedName : IntPtr.Zero;
    }

    public static string NativeInputControls(IntPtr dialog, uint applicationPid) {
        var inputs = new List<string>();
        EnumChildWindows(dialog, (child, extra) => {
            uint pid;
            GetWindowThreadProcessId(child, out pid);
            if (pid == applicationPid) {
                string name = WindowClass(child);
                if (name.IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("combo", StringComparison.OrdinalIgnoreCase) >= 0) {
                    inputs.Add(name + "/" + GetDlgCtrlID(child) + "/" + GetDlgCtrlID(GetParent(child)));
                }
            }
            return inputs.Count < 16;
        }, IntPtr.Zero);
        return string.Join(" | ", inputs);
    }

    private static string ReadFileName(IntPtr edit, int capacity) {
        const uint abortIfHung = 2;
        const uint getText = 0x000D;
        UIntPtr result;
        var actual = new StringBuilder(capacity);
        return ReadText(edit, getText, new UIntPtr((uint)capacity), actual, abortIfHung, 1000, out result) == IntPtr.Zero
            ? "" : actual.ToString();
    }

    public static bool SetFileName(IntPtr edit, string path) {
        const uint abortIfHung = 2;
        const uint setText = 0x000C;
        UIntPtr result;
        if (WriteText(edit, setText, UIntPtr.Zero, path, abortIfHung, 1000, out result) == IntPtr.Zero || result == UIntPtr.Zero) {
            return false;
        }
        return HasFileName(edit, path);
    }

    public static bool QueueFileNameCharacters(IntPtr edit, string path) {
        const uint selectText = 0x00B1;
        const uint keyboardCharacter = 0x0102;
        if (!PostMessage(edit, selectText, UIntPtr.Zero, new IntPtr(-1))) return false;
        foreach (char character in path) {
            if (!PostMessage(edit, keyboardCharacter, new UIntPtr((uint)character), new IntPtr(1))) return false;
        }
        return true;
    }

    public static bool HasFileName(IntPtr edit, string path) {
        return ReadFileName(edit, path.Length + 2) == path;
    }
}
'@

function Test-ApplicationWindow([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    [uint32]$windowPid = 0
    [void][TerminalPickerWindow]::GetWindowThreadProcessId($Handle, [ref]$windowPid)
    return $windowPid -eq $ApplicationPid
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$handle = [IntPtr]::Zero
[Console]::Error.WriteLine("Waiting for the owned native $Action dialog")
while ($clock.Elapsed.TotalSeconds -lt 15) {
    $candidate = [TerminalPickerWindow]::GetForegroundWindow()
    if ((Test-ApplicationWindow $candidate) -and [TerminalPickerWindow]::WindowClass($candidate) -eq '#32770') {
        $owner = [TerminalPickerWindow]::GetWindow($candidate, 4)
        if (Test-ApplicationWindow $owner) {
            $handle = $candidate
            break
        }
    }
    Start-Sleep -Milliseconds 50
}
if ($handle -eq [IntPtr]::Zero) { throw "No foreground $Action file dialog owned by application $ApplicationPid." }
[Console]::Error.WriteLine("Found owned native $Action dialog")
$nativeEdit = [IntPtr]::Zero
$buttonReady = $false
do {
    $nativeEdit = [TerminalPickerWindow]::FileNameEdit($handle, $ApplicationPid, $Action -eq 'Save')
    $buttonHandle = [TerminalPickerWindow]::GetDlgItem($handle, 1)
    $buttonReady = (Test-ApplicationWindow $buttonHandle) -and [TerminalPickerWindow]::WindowClass($buttonHandle) -eq 'Button'
    if ($nativeEdit -ne [IntPtr]::Zero -and $buttonReady) { break }
    Start-Sleep -Milliseconds 50
} while ($clock.Elapsed.TotalSeconds -lt 15 -and [TerminalPickerWindow]::GetForegroundWindow() -eq $handle)
if ($nativeEdit -eq [IntPtr]::Zero -or !$buttonReady) {
    $nativeInputs = [TerminalPickerWindow]::NativeInputControls($handle, $ApplicationPid)
    throw "The owned $Action dialog did not expose a filename edit and confirmation button. Native inputs: $nativeInputs"
}
[Console]::Error.WriteLine("Found $Action filename edit and confirmation button")
if ([TerminalPickerWindow]::GetForegroundWindow() -ne $handle -or
    [TerminalPickerWindow]::GetWindow($handle, 4) -ne $owner -or !(Test-ApplicationWindow $nativeEdit)) {
    throw "The owned $Action dialog lost foreground focus before entering the path."
}
if ($Action -eq 'Save') {
    # Typing notifies the Save dialog of edits to its prefilled filename.
    if (![TerminalPickerWindow]::QueueFileNameCharacters($nativeEdit, $FilePath)) {
        throw "The owned $Action dialog could not queue the filename characters."
    }
    $entry = [Diagnostics.Stopwatch]::StartNew()
    do {
        $entered = [TerminalPickerWindow]::HasFileName($nativeEdit, $FilePath)
        if ($entered) { break }
        Start-Sleep -Milliseconds 50
    } while ($entry.Elapsed.TotalSeconds -lt 2 -and [TerminalPickerWindow]::GetForegroundWindow() -eq $handle)
    if (!$entered) { throw "The owned $Action dialog did not receive the typed filename." }
    $input = 'native-characters'
} else {
    if (![TerminalPickerWindow]::SetFileName($nativeEdit, $FilePath)) {
        throw "The owned $Action dialog did not retain its filename."
    }
    $input = 'native-edit'
}
if ([TerminalPickerWindow]::GetForegroundWindow() -ne $handle -or !(Test-ApplicationWindow $buttonHandle) -or
    ![TerminalPickerWindow]::IsWindowEnabled($buttonHandle)) {
    throw "The owned $Action dialog lost foreground focus or its confirmation button became unavailable."
}
[Console]::Error.WriteLine("Verified $Action filename")
if (![TerminalPickerWindow]::ClickButton($buttonHandle)) {
    throw "The owned $Action dialog could not queue its native confirmation."
}
[Console]::Error.WriteLine("Queued $Action confirmation")

$clock.Restart()
while ($clock.Elapsed.TotalSeconds -lt 5) {
    if (![TerminalPickerWindow]::IsWindowVisible($handle) -and [TerminalPickerWindow]::GetForegroundWindow() -eq $owner) {
        [ordered]@{
            action = $Action
            applicationPid = $ApplicationPid
            dialog = $handle.ToInt64()
            owner = $owner.ToInt64()
            path = $FilePath
            input = $input
            confirmation = 'native-button'
            returnedFocus = $true
        } | ConvertTo-Json -Compress
        exit 0
    }
    Start-Sleep -Milliseconds 50
}
$foreground = [TerminalPickerWindow]::GetForegroundWindow()
$visible = [TerminalPickerWindow]::IsWindowVisible($handle)
$live = [TerminalPickerWindow]::IsWindow($handle)
$isOwner = $foreground -eq $owner
$foregroundClass = [TerminalPickerWindow]::WindowClass($foreground)
throw "The $Action dialog did not close with focus returned. dialogExists=$live; dialogVisible=$visible; ownerForeground=$isOwner; foregroundClass=$foregroundClass."

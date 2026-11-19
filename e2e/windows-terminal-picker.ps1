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
$edit = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty,
    [Windows.Automation.ControlType]::Edit
)
function Find-DialogItem([string]$Id) {
    $property = [Windows.Automation.AutomationElement]::AutomationIdProperty
    $item = $dialog.FindFirst($scope, [Windows.Automation.PropertyCondition]::new($property, $Id))
    if ($item) { return $item }
    $controlId = 0
    if ([int]::TryParse($Id, [ref]$controlId)) {
        $child = [TerminalPickerWindow]::GetDlgItem($handle, $controlId)
        if ($child -ne [IntPtr]::Zero) {
            return [Windows.Automation.AutomationElement]::FromHandle($child)
        }
    }
}

# A filename host can expose Value directly without exposing a child edit.
$fileValue = $null
foreach ($key in 'FileNameControlHost', '1148', '1152') {
    $fileName = Find-DialogItem $key
    if (!$fileName) { continue }
    if ($fileName.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$fileValue)) { break }
    $nested = $fileName.FindFirst($scope, $edit)
    if ($nested -and $nested.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$fileValue)) { break }
}
if (!$fileValue) {
    foreach ($candidate in $dialog.FindAll($scope, $edit)) {
        if ($candidate.Current.Name -match '^File name\s*:?\s*$' -and
            $candidate.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$fileValue)) { break }
    }
}

$confirm = Find-DialogItem '1'
$confirmAction = $null
if (!$confirm -or !$confirm.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$confirmAction)) {
    $name = [Windows.Automation.AutomationElement]::NameProperty
    $confirm = $dialog.FindFirst($scope, [Windows.Automation.PropertyCondition]::new($name, $Action))
    if ($confirm) {
        [void]$confirm.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$confirmAction)
    }
}
$nativeEdit = [IntPtr]::Zero
if (!$fileValue) {
    # The Save dialog can expose a different native tree. Match the app's prefilled capture name.
    do {
        $nativeEdit = [TerminalPickerWindow]::FileNameEdit($handle, $ApplicationPid, $Action -eq 'Save')
        if ($nativeEdit -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 50
    } while ($clock.Elapsed.TotalSeconds -lt 15 -and [TerminalPickerWindow]::GetForegroundWindow() -eq $handle)
}
if ((!$fileValue -and $nativeEdit -eq [IntPtr]::Zero) -or !$confirmAction) {
    $controls = $dialog.FindAll($scope, [Windows.Automation.Condition]::TrueCondition) | Where-Object {
        $_.Current.AutomationId -notlike 'System.*' -and
            $_.Current.ControlType -in [Windows.Automation.ControlType]::Edit, [Windows.Automation.ControlType]::ComboBox, [Windows.Automation.ControlType]::Button
    } | Select-Object -Last 16 | ForEach-Object {
        '{0}/{1}/{2}' -f $_.Current.ControlType.ProgrammaticName, $_.Current.AutomationId, $_.Current.Name
    }
    $nativeInputs = [TerminalPickerWindow]::NativeInputControls($handle, $ApplicationPid)
    throw "The owned $Action dialog did not expose Value=$([bool]$fileValue) NativeEdit=$($nativeEdit -ne [IntPtr]::Zero) Invoke=$([bool]$confirmAction). Controls: $($controls -join ' | '). Native inputs: $nativeInputs"
}
if ([TerminalPickerWindow]::GetForegroundWindow() -ne $handle) {
    throw "The owned $Action dialog lost foreground focus before entering the path."
}
if ($fileValue) {
    $fileValue.SetValue($FilePath)
} elseif (![TerminalPickerWindow]::SetFileName($nativeEdit, $FilePath)) {
    throw "The owned $Action dialog did not retain its filename."
}
if ([TerminalPickerWindow]::GetForegroundWindow() -ne $handle) {
    throw "The owned $Action dialog lost foreground focus before confirmation."
}
$confirmation = 'automation-invoke'
$buttonHandle = [TerminalPickerWindow]::GetDlgItem($handle, 1)
if ($nativeEdit -ne [IntPtr]::Zero -and (Test-ApplicationWindow $buttonHandle) -and
    [TerminalPickerWindow]::WindowClass($buttonHandle) -eq 'Button') {
    if (![TerminalPickerWindow]::ClickButton($buttonHandle)) {
        throw "The owned $Action dialog could not queue its native confirmation."
    }
    $confirmation = 'native-button'
} else {
    $confirmAction.Invoke()
}

$clock.Restart()
while ($clock.Elapsed.TotalSeconds -lt 5) {
    if (![TerminalPickerWindow]::IsWindowVisible($handle) -and [TerminalPickerWindow]::GetForegroundWindow() -eq $owner) {
        [ordered]@{
            action = $Action
            applicationPid = $ApplicationPid
            dialog = $handle.ToInt64()
            owner = $owner.ToInt64()
            path = $FilePath
            input = if ($fileValue) { 'automation-value' } else { 'native-edit' }
            confirmation = $confirmation
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
throw "The $Action dialog did not close with focus returned. Confirmation=$confirmation; dialogExists=$live; dialogVisible=$visible; ownerForeground=$isOwner; foregroundClass=$foregroundClass."

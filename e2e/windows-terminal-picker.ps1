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
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
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
if (!$fileValue -or !$confirmAction) {
    $controls = $dialog.FindAll($scope, [Windows.Automation.Condition]::TrueCondition) | Where-Object {
        $_.Current.AutomationId -notlike 'System.*' -and
            $_.Current.ControlType -in [Windows.Automation.ControlType]::Edit, [Windows.Automation.ControlType]::ComboBox, [Windows.Automation.ControlType]::Button
    } | Select-Object -Last 16 | ForEach-Object {
        '{0}/{1}/{2}' -f $_.Current.ControlType.ProgrammaticName, $_.Current.AutomationId, $_.Current.Name
    }
    throw "The owned $Action dialog did not expose Value=$([bool]$fileValue) Invoke=$([bool]$confirmAction). Controls: $($controls -join ' | ')"
}
$fileValue.SetValue($FilePath)
if ([TerminalPickerWindow]::GetForegroundWindow() -ne $handle) {
    throw "The owned $Action dialog lost foreground focus before confirmation."
}
$confirmAction.Invoke()

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

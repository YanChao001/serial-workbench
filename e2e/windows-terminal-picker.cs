using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class TerminalPickerWindow
{
    private const uint OwnerWindow = 4;
    private const int ConfirmButtonId = 1;

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
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
    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)]
    private static extern bool PostMessage(IntPtr window, uint message, UIntPtr parameter, IntPtr extra);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--check")
            {
                WriteReceipt(new { ready = true });
                return 0;
            }
            if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
                Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows")
                throw new InvalidOperationException("The native picker probe requires the independent Windows CI desktop.");

            uint pid;
            if (args.Length != 3 || !uint.TryParse(args[0], out pid) || pid == 0 ||
                (args[1] != "Open" && args[1] != "Save") || !Path.IsPathRooted(args[2]))
                throw new ArgumentException("Expected application PID, Open or Save, and an absolute fixture path.");

            Drive(pid, args[1], args[2]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static void WriteReceipt(object receipt)
    {
        using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
            writer.WriteLine(new JavaScriptSerializer().Serialize(receipt));
    }

    private static void Drive(uint pid, string action, string path)
    {
        bool save = action == "Save";
        var observation = Stopwatch.StartNew();
        Console.Error.WriteLine("Waiting for the owned native " + action + " dialog");
        IntPtr owner = IntPtr.Zero;
        IntPtr dialog = IntPtr.Zero;
        while (observation.Elapsed.TotalSeconds < 15)
        {
            IntPtr foreground = GetForegroundWindow();
            if (BelongsTo(foreground, pid) && WindowClass(foreground) == "#32770")
            {
                owner = GetWindow(foreground, OwnerWindow);
                if (BelongsTo(owner, pid))
                {
                    dialog = foreground;
                    break;
                }
            }
            Thread.Sleep(50);
        }
        if (dialog == IntPtr.Zero)
            throw new InvalidOperationException("No foreground " + action + " file dialog owned by application " + pid);
        Console.Error.WriteLine("Found owned native " + action + " dialog");

        IntPtr edit = IntPtr.Zero;
        IntPtr button = IntPtr.Zero;
        do
        {
            edit = FileNameEdit(dialog, pid, save);
            button = GetDlgItem(dialog, ConfirmButtonId);
            if (edit != IntPtr.Zero && BelongsTo(button, pid) && WindowClass(button) == "Button") break;
            button = IntPtr.Zero;
            Thread.Sleep(50);
        } while (observation.Elapsed.TotalSeconds < 15 && GetForegroundWindow() == dialog);
        if (button == IntPtr.Zero)
            throw new InvalidOperationException("Missing filename edit or confirmation button. Native inputs: " + NativeInputControls(dialog, pid));
        Console.Error.WriteLine("Found " + action + " filename edit and confirmation button");

        if (GetForegroundWindow() != dialog || GetWindow(dialog, OwnerWindow) != owner || !BelongsTo(edit, pid))
            throw new InvalidOperationException("The owned " + action + " dialog lost foreground focus before entering the path.");
        EnterPath(dialog, edit, save, path);
        if (GetForegroundWindow() != dialog || GetDlgItem(dialog, ConfirmButtonId) != button || !IsWindowEnabled(button))
            throw new InvalidOperationException("The owned " + action + " dialog lost focus or its confirmation button became unavailable.");
        Console.Error.WriteLine("Verified " + action + " filename");
        const uint buttonClick = 0x00F5;
        if (!PostMessage(button, buttonClick, UIntPtr.Zero, IntPtr.Zero))
            throw new InvalidOperationException("The owned " + action + " dialog could not queue its native confirmation.");
        Console.Error.WriteLine("Queued " + action + " confirmation");

        observation.Restart();
        while (observation.Elapsed.TotalSeconds < 5)
        {
            if (!IsWindowVisible(dialog) && GetForegroundWindow() == owner)
            {
                WriteReceipt(new {
                    action, applicationPid = pid, dialog = dialog.ToInt64(), owner = owner.ToInt64(), path,
                    input = save ? "native-characters" : "native-edit", confirmation = "native-button", returnedFocus = true,
                });
                return;
            }
            Thread.Sleep(50);
        }
        IntPtr lastForeground = GetForegroundWindow();
        throw new InvalidOperationException(string.Format(
            "The {0} dialog did not close with focus returned. dialogVisible={1}; ownerForeground={2}; foregroundClass={3}",
            action, IsWindowVisible(dialog), lastForeground == owner, WindowClass(lastForeground)));
    }

    private static bool BelongsTo(IntPtr window, uint applicationPid)
    {
        uint pid;
        return window != IntPtr.Zero && GetWindowThreadProcessId(window, out pid) != 0 && pid == applicationPid;
    }

    private static string WindowClass(IntPtr window)
    {
        var name = new StringBuilder(64);
        return GetClassName(window, name, name.Capacity) == 0 ? "" : name.ToString();
    }

    private static IntPtr FileNameEdit(IntPtr dialog, uint applicationPid, bool save)
    {
        const int fileNameComboId = 1148;
        const int fileNameEditId = 1152;
        IntPtr result = IntPtr.Zero;
        IntPtr suggestedName = IntPtr.Zero;
        int suggestedNames = 0;
        EnumChildWindows(dialog, (child, extra) => {
            if (!BelongsTo(child, applicationPid) || WindowClass(child) != "Edit") return true;
            for (IntPtr control = child; control != dialog && control != IntPtr.Zero; control = GetParent(control))
            {
                int id = GetDlgCtrlID(control);
                if (id == fileNameComboId || id == fileNameEditId)
                {
                    result = child;
                    return false;
                }
            }
            if (save && Regex.IsMatch(ReadFileName(child, 256), @"\A[0-9]{8}T[0-9]{6}Z_.+_[0-9a-f]{12}(\.swb)?\z"))
            {
                suggestedName = child;
                suggestedNames++;
            }
            return true;
        }, IntPtr.Zero);
        if (result != IntPtr.Zero) return result;
        return suggestedNames == 1 ? suggestedName : IntPtr.Zero;
    }

    private static string NativeInputControls(IntPtr dialog, uint applicationPid)
    {
        var inputs = new List<string>();
        EnumChildWindows(dialog, (child, extra) => {
            if (BelongsTo(child, applicationPid))
            {
                string name = WindowClass(child);
                if (name.IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("combo", StringComparison.OrdinalIgnoreCase) >= 0)
                    inputs.Add(name + "/" + GetDlgCtrlID(child) + "/" + GetDlgCtrlID(GetParent(child)));
            }
            return inputs.Count < 16;
        }, IntPtr.Zero);
        return string.Join(" | ", inputs);
    }

    private static string ReadFileName(IntPtr edit, int capacity)
    {
        const uint abortIfHung = 2;
        const uint getText = 0x000D;
        UIntPtr result;
        var actual = new StringBuilder(capacity);
        return ReadText(edit, getText, new UIntPtr((uint)capacity), actual, abortIfHung, 1000, out result) == IntPtr.Zero
            ? "" : actual.ToString();
    }

    private static void EnterPath(IntPtr dialog, IntPtr edit, bool save, string path)
    {
        if (!save)
        {
            const uint abortIfHung = 2;
            const uint setText = 0x000C;
            UIntPtr result;
            if (WriteText(edit, setText, UIntPtr.Zero, path, abortIfHung, 1000, out result) != IntPtr.Zero &&
                result != UIntPtr.Zero && ReadFileName(edit, path.Length + 2) == path) return;
            throw new InvalidOperationException("The owned Open dialog did not retain its filename.");
        }

        // 字符输入让 Save 对话框收到文件名修改通知。
        const uint selectText = 0x00B1;
        const uint keyboardCharacter = 0x0102;
        if (!PostMessage(edit, selectText, UIntPtr.Zero, new IntPtr(-1)))
            throw new InvalidOperationException("Could not select the suggested filename.");
        foreach (char character in path)
            if (!PostMessage(edit, keyboardCharacter, new UIntPtr((uint)character), new IntPtr(1)))
                throw new InvalidOperationException("Could not queue the filename characters.");
        var entry = Stopwatch.StartNew();
        do
        {
            if (ReadFileName(edit, path.Length + 2) == path) return;
            Thread.Sleep(50);
        } while (entry.Elapsed.TotalSeconds < 2 && GetForegroundWindow() == dialog);
        throw new InvalidOperationException("The owned Save dialog did not receive the typed filename.");
    }
}

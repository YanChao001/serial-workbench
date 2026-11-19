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
    private const uint KeyUp = 2;
    private const uint Unicode = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Key, ScanCode;
        public uint Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint MouseData, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputData
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputData Data;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    private delegate bool EnumerateWindow(IntPtr window, IntPtr extra);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumerateWindow callback, IntPtr extra);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr ReadText(IntPtr window, uint message, UIntPtr size, StringBuilder value, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr parameter, IntPtr extra);

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
        EnterPath(dialog, edit, path);
        if (!HasFocus(dialog, edit) || GetDlgItem(dialog, ConfirmButtonId) != button || !IsWindowEnabled(button))
            throw new InvalidOperationException("The owned " + action + " dialog lost focus or its confirmation button became unavailable.");
        Console.Error.WriteLine("Verified " + action + " filename");
        const ushort enter = 0x0D;
        SendKeys(new[] { Key(enter, 0, 0), Key(enter, 0, KeyUp) });
        Console.Error.WriteLine("Queued " + action + " confirmation");

        observation.Restart();
        while (observation.Elapsed.TotalSeconds < 5)
        {
            if (!IsWindowVisible(dialog) && GetForegroundWindow() == owner)
            {
                WriteReceipt(new {
                    action, applicationPid = pid, dialog = dialog.ToInt64(), owner = owner.ToInt64(), path,
                    input = "keyboard", confirmation = "enter", returnedFocus = true,
                });
                return;
            }
            Thread.Sleep(50);
        }
        IntPtr lastForeground = GetForegroundWindow();
        throw new InvalidOperationException(string.Format(
            "The {0} dialog did not close with focus returned. dialogVisible={1}; ownerForeground={2}; dialogForeground={3}; foregroundClass={4}",
            action, IsWindowVisible(dialog), lastForeground == owner, lastForeground == dialog, WindowClass(lastForeground)));
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

    private static bool HasFocus(IntPtr dialog, IntPtr edit)
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(dialog, out pid);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
        return GetForegroundWindow() == dialog && thread != 0 && GetGUIThreadInfo(thread, ref info) &&
            info.Active == dialog && info.Focus == edit;
    }

    private static Input Key(ushort key, ushort scanCode, uint flags)
    {
        const uint keyboard = 1;
        return new Input {
            Type = keyboard,
            Data = new InputData { Keyboard = new KeyboardInput { Key = key, ScanCode = scanCode, Flags = flags } },
        };
    }

    private static void SendKeys(Input[] inputs)
    {
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
            throw new InvalidOperationException("Windows did not accept all file dialog keystrokes.");
    }

    private static void EnterPath(IntPtr dialog, IntPtr edit, string path)
    {
        if (!HasFocus(dialog, edit))
        {
            const uint focusDialogControl = 0x0028;
            if (!PostMessage(dialog, focusDialogControl, edit, new IntPtr(1)))
                throw new InvalidOperationException("Could not queue focus for the filename edit.");
            var focus = Stopwatch.StartNew();
            while (!HasFocus(dialog, edit) && GetForegroundWindow() == dialog && focus.Elapsed.TotalSeconds < 2)
                Thread.Sleep(50);
        }
        if (!HasFocus(dialog, edit))
            throw new InvalidOperationException("The filename edit did not receive keyboard focus.");

        const ushort control = 0x11;
        var inputs = new List<Input>(4 + path.Length * 2) {
            Key(control, 0, 0), Key('A', 0, 0), Key('A', 0, KeyUp), Key(control, 0, KeyUp),
        };
        foreach (char character in path)
        {
            inputs.Add(Key(0, character, Unicode));
            inputs.Add(Key(0, character, Unicode | KeyUp));
        }
        if (!HasFocus(dialog, edit))
            throw new InvalidOperationException("The filename edit lost keyboard focus before typing.");
        SendKeys(inputs.ToArray());
        var entry = Stopwatch.StartNew();
        do
        {
            if (ReadFileName(edit, path.Length + 2) == path) return;
            Thread.Sleep(50);
        } while (entry.Elapsed.TotalSeconds < 2 && GetForegroundWindow() == dialog);
        throw new InvalidOperationException("The owned dialog did not receive the typed filename.");
    }
}

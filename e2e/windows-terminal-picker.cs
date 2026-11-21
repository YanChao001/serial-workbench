using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
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

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowRect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out WindowRect rect);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    private delegate bool EnumerateWindow(IntPtr window, IntPtr extra);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumerateWindow callback, IntPtr extra);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr ReadText(IntPtr window, uint message, UIntPtr size, StringBuilder value, uint flags, uint timeout, out UIntPtr result);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--check")
            {
                if (!MatchesSuggestedFileName("chart.svg", "chart.svg") ||
                    !MatchesSuggestedFileName("chart", "chart.svg") ||
                    MatchesSuggestedFileName("other.svg", "chart.svg") ||
                    !MatchesSuggestedFileName("20261121T051200Z_Virtual_0123456789ab.swb", null))
                    throw new InvalidOperationException("The expected native save filenames were not recognized.");
                WriteReceipt(new { ready = true });
                return 0;
            }
            if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
                Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows")
                throw new InvalidOperationException("The native picker probe requires the independent Windows CI desktop.");

            uint pid;
            if (args.Length >= 3 && args[1].StartsWith("Zoom", StringComparison.Ordinal))
            {
                long handle;
                if (!uint.TryParse(args[0], out pid) || pid == 0 || !long.TryParse(args[2], out handle) || handle <= 0)
                    throw new ArgumentException("Expected an owned application PID and a window handle.");
                DriveZoom(pid, new IntPtr(handle), args);
                return 0;
            }
            if ((args.Length != 3 && args.Length != 4) || !uint.TryParse(args[0], out pid) || pid == 0 ||
                (args[1] != "Open" && args[1] != "Save") || !Path.IsPathRooted(args[2]) ||
                (args.Length == 4 && (args[1] != "Save" || args[3].Length == 0 || Path.GetFileName(args[3]) != args[3])))
                throw new ArgumentException("Expected application PID, Open or Save, an absolute fixture path, and an optional suggested save filename.");

            Drive(pid, args[1], args[2], args.Length == 4 ? args[3] : null);
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

    private static void DriveZoom(uint pid, IntPtr window, string[] args)
    {
        var observation = Stopwatch.StartNew();
        while (GetForegroundWindow() != window && observation.Elapsed.TotalSeconds < 8)
            Thread.Sleep(50);
        if (!BelongsTo(window, pid) || GetForegroundWindow() != window)
            throw new InvalidOperationException("The expected application window is not in the foreground.");

        if (args[1] == "ZoomCapture" && args.Length == 4 && Path.IsPathRooted(args[3]))
        {
            SetProcessDPIAware();
            WindowRect rect;
            if (!GetWindowRect(window, out rect))
                throw new InvalidOperationException("Cannot capture the foreground window bounds.");
            using (var image = new Bitmap(rect.Right - rect.Left, rect.Bottom - rect.Top))
            using (var graphics = Graphics.FromImage(image))
            {
                graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, image.Size);
                image.Save(args[3], ImageFormat.Png);
            }
            return;
        }

        if (args.Length != 3 || (args[1] != "ZoomIn" && args[1] != "ZoomReset"))
            throw new ArgumentException("Expected ZoomIn, ZoomReset, or ZoomCapture with an absolute destination.");
        const ushort control = 0x11;
        ushort key = args[1] == "ZoomIn" ? (ushort)0xBB : (ushort)'0';
        SendKeys(new[] { Key(control, 0, 0), Key(key, 0, 0), Key(key, 0, KeyUp), Key(control, 0, KeyUp) });
    }

    private static void Drive(uint pid, string action, string path, string suggestedFileName)
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
            edit = FileNameEdit(dialog, pid, save, suggestedFileName);
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
        edit = EnterPath(dialog, edit, pid, path);
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

    private static bool IsFileNameEdit(IntPtr dialog, IntPtr edit, uint applicationPid)
    {
        const int fileNameComboId = 1148;
        const int fileNameEditId = 1152;
        if (!BelongsTo(edit, applicationPid) || !IsChild(dialog, edit) || WindowClass(edit) != "Edit")
            return false;
        for (IntPtr control = edit; control != dialog && control != IntPtr.Zero; control = GetParent(control))
        {
            int id = GetDlgCtrlID(control);
            if (id == fileNameComboId || id == fileNameEditId) return true;
        }
        return false;
    }

    private static IntPtr FileNameEdit(IntPtr dialog, uint applicationPid, bool save, string suggestedFileName)
    {
        // 文件对话框可能保留多个同一 ID 的控件，优先使用已获焦的文件名框。
        IntPtr focused = FocusedControl(dialog);
        if (IsFileNameEdit(dialog, focused, applicationPid)) return focused;
        IntPtr result = IntPtr.Zero;
        IntPtr suggestedName = IntPtr.Zero;
        int suggestedNames = 0;
        EnumChildWindows(dialog, (child, extra) => {
            if (!BelongsTo(child, applicationPid) || WindowClass(child) != "Edit") return true;
            if (IsFileNameEdit(dialog, child, applicationPid))
            {
                result = child;
                return false;
            }
            if (save && MatchesSuggestedFileName(ReadFileName(child, 256), suggestedFileName))
            {
                suggestedName = child;
                suggestedNames++;
            }
            return true;
        }, IntPtr.Zero);
        if (result != IntPtr.Zero) return result;
        return suggestedNames == 1 ? suggestedName : IntPtr.Zero;
    }

    private static bool MatchesSuggestedFileName(string actual, string expected)
    {
        if (expected == null)
            return Regex.IsMatch(actual, @"\A[0-9]{8}T[0-9]{6}Z_.+_[0-9a-f]{12}(\.swb)?\z");
        return string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(actual, Path.GetFileNameWithoutExtension(expected), StringComparison.OrdinalIgnoreCase);
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

    private static IntPtr FocusedControl(IntPtr dialog)
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(dialog, out pid);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
        return GetForegroundWindow() == dialog && thread != 0 && GetGUIThreadInfo(thread, ref info)
            ? info.Focus : IntPtr.Zero;
    }

    private static bool HasFocus(IntPtr dialog, IntPtr edit)
    {
        IntPtr focus = FocusedControl(dialog);
        return focus == edit || (WindowClass(focus) == "ComboBox" && IsChild(dialog, focus) && IsChild(focus, edit));
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

    private static IntPtr EnterPath(IntPtr dialog, IntPtr edit, uint applicationPid, string path)
    {
        if (!HasFocus(dialog, edit))
        {
            if (GetForegroundWindow() != dialog)
                throw new InvalidOperationException("The owned dialog lost foreground focus before selecting its filename field.");
            const ushort alt = 0x12;
            // 英文系统文件对话框用 Alt+N 聚焦文件名控件。
            SendKeys(new[] { Key(alt, 0, 0), Key('N', 0, 0), Key('N', 0, KeyUp), Key(alt, 0, KeyUp) });
            var focus = Stopwatch.StartNew();
            while (!HasFocus(dialog, edit) && GetForegroundWindow() == dialog && focus.Elapsed.TotalSeconds < 2)
            {
                IntPtr focused = FocusedControl(dialog);
                if (IsFileNameEdit(dialog, focused, applicationPid))
                {
                    edit = focused;
                    break;
                }
                Thread.Sleep(50);
            }
        }
        if (!HasFocus(dialog, edit))
        {
            IntPtr focused = FocusedControl(dialog);
            throw new InvalidOperationException("The filename edit did not receive keyboard focus. Focus class=" +
                WindowClass(focused) + "; control ID=" + GetDlgCtrlID(focused));
        }

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
            if (ReadFileName(edit, path.Length + 2) == path) return edit;
            Thread.Sleep(50);
        } while (entry.Elapsed.TotalSeconds < 2 && GetForegroundWindow() == dialog);
        throw new InvalidOperationException("The owned dialog did not receive the typed filename.");
    }
}

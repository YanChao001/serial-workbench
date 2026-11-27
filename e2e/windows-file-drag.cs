// SPDX-License-Identifier: Apache-2.0
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class FileDrag
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public MouseInput Mouse;
    }

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] input, int size);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (Environment.GetEnvironmentVariable("STARTER_E2E_PHASE") != "fresh" || args.Length < 3)
                throw new InvalidOperationException("The file drag requires the isolated desktop E2E and fixture paths.");
            SetProcessDPIAware();
            var workbench = GetForegroundWindow();
            var title = new StringBuilder(256);
            GetWindowText(workbench, title, title.Capacity);
            if (!title.ToString().StartsWith("Serial Workbench", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Serial Workbench is not the foreground window.");
            var destination = new Point(int.Parse(args[0]), int.Parse(args[1]));
            if (!ClientToScreen(workbench, ref destination))
                throw new InvalidOperationException("Could not locate the workbench client area.");
            var files = new string[args.Length - 2];
            Array.Copy(args, 2, files, 0, files.Length);
            foreach (var file in files)
                if (!File.Exists(file)) throw new FileNotFoundException("Missing file drag fixture", file);
            Drag(files, destination);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void Drag(string[] files, Point destination)
    {
        var workArea = Screen.FromPoint(destination).WorkingArea;
        using (var source = new Form {
            Text = "Serial Workbench E2E file source",
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual,
            Location = new Point(workArea.Left + 20, workArea.Top + 30),
            ClientSize = new Size(180, 64),
            TopMost = true,
            ShowInTaskbar = false
        })
        {
            var data = new DataObject(DataFormats.FileDrop, files);
            Exception pointerError = null;
            Thread pointer = null;
            source.MouseDown += (sender, eventArgs) => {
                if (eventArgs.Button != MouseButtons.Left) return;
                Console.WriteLine("file-drag-started");
                var effect = source.DoDragDrop(data, DragDropEffects.Copy);
                if ((effect & DragDropEffects.Copy) != 0) Console.WriteLine("file-data-accepted");
                source.Close();
            };
            source.Shown += (sender, eventArgs) => {
                var start = source.PointToScreen(new Point(64, 32));
                var handle = source.Handle;
                if (source.Bounds.Contains(destination))
                    throw new InvalidOperationException("The source window overlaps the drop target.");
                pointer = new Thread(() => {
                    try
                    {
                        Thread.Sleep(120);
                        if (WindowFromPoint(start) != handle)
                            throw new InvalidOperationException("The file source is obscured.");
                        Move(start);
                        Button(0x0002); // left down
                        try
                        {
                            Thread.Sleep(180);
                            Move(new Point(start.X + 32, start.Y));
                            Thread.Sleep(140);
                            Move(destination);
                            Thread.Sleep(420);
                        }
                        finally { Button(0x0004); } // left up
                    }
                    catch (Exception error)
                    {
                        pointerError = error;
                        source.BeginInvoke(new Action(source.Close));
                    }
                }) { IsBackground = true };
                pointer.Start();
            };
            Application.Run(source);
            if (pointer != null) pointer.Join();
            if (pointerError != null) throw pointerError;
        }
    }

    private static void Move(Point point)
    {
        if (!SetCursorPos(point.X, point.Y))
            throw new InvalidOperationException("Could not move the desktop pointer.");
    }

    private static void Button(uint flags)
    {
        var input = new Input { Mouse = new MouseInput { Flags = flags } };
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
            throw new InvalidOperationException("Could not send the desktop mouse button event.");
    }
}

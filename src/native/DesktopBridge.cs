using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class DesktopBridge
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ShellFileInfo
    {
        public IntPtr Icon;
        public int IconIndex;
        public uint Attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string TypeName;
    }

    private delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(string path, uint attributes, out ShellFileInfo info, uint size, uint flags);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string className, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    private static IntPtr DesktopIcons()
    {
        IntPtr view = FindWindowEx(FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
        if (view == IntPtr.Zero)
        {
            EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                view = FindWindowEx(window, IntPtr.Zero, "SHELLDLL_DefView", null);
                return view == IntPtr.Zero;
            }, IntPtr.Zero);
        }
        return view == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(view, IntPtr.Zero, "SysListView32", null);
    }

    private static void SetVisible(IntPtr window, bool visible)
    {
        if (window == IntPtr.Zero) throw new InvalidOperationException("Windows desktop view was not found");
        ShowWindowAsync(window, visible ? 5 : 0);
        Stopwatch timer = Stopwatch.StartNew();
        while (IsWindowVisible(window) != visible && timer.ElapsedMilliseconds < 2000) Thread.Sleep(20);
        if (IsWindowVisible(window) != visible) throw new InvalidOperationException("Windows desktop visibility did not change");
    }

    internal static string FileIcon(string path)
    {
        ShellFileInfo info;
        if (SHGetFileInfo(path, 0, out info, (uint)Marshal.SizeOf(typeof(ShellFileInfo)), 0x100) == IntPtr.Zero || info.Icon == IntPtr.Zero)
            throw new IOException("Windows could not extract the file icon");
        try
        {
            using (Icon icon = Icon.FromHandle(info.Icon))
            using (Bitmap bitmap = icon.ToBitmap())
            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        }
        finally { DestroyIcon(info.Icon); }
    }

    private static void ReadIcons()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] fields = line.Split(new char[] { '\t' }, 2);
            if (fields.Length != 2) continue;
            try
            {
                string path = Encoding.UTF8.GetString(Convert.FromBase64String(fields[1]));
                Console.WriteLine(fields[0] + "\t" + FileIcon(path));
            }
            catch { Console.WriteLine(fields[0] + "\t"); }
        }
    }

    private static int GuardDesktop(int processId)
    {
        bool owner;
        using (Mutex mutex = new Mutex(true, "Local\\QXDesktopVisibilityGuard", out owner))
        {
            if (!owner) throw new InvalidOperationException("Desktop is already managed");
            try
            {
                using (Process parent = Process.GetProcessById(processId))
                using (ManualResetEvent restore = new ManualResetEvent(false))
                {
                    if (parent.HasExited) return 0;
                    IntPtr processHandle = parent.Handle;
                    IntPtr window = DesktopIcons();
                    if (window == IntPtr.Zero) throw new InvalidOperationException("Windows desktop view was not found");
                    bool originalVisible = IsWindowVisible(window);
                    TaskbarVisibility taskbar = new TaskbarVisibility();
                    WindowEmbedder embedder = new WindowEmbedder();
                    ShellFlashWatcher flashes = new ShellFlashWatcher();
                    flashes.Start();
                    ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
                    Thread reader = new Thread(delegate() {
                        try
                        {
                            string line;
                            while ((line = Console.ReadLine()) != null)
                            {
                                if (line == "restore") break;
                                commands.Enqueue(line);
                            }
                        }
                        catch { }
                        try { restore.Set(); } catch (ObjectDisposedException) { }
                    });
                    reader.IsBackground = true;
                    reader.Start();
                    try
                    {
                        SetVisible(window, false);
                        Console.WriteLine("READY\t" + (originalVisible ? "1" : "0"));
                        while (!parent.HasExited && !restore.WaitOne(200))
                        {
                            IntPtr current = DesktopIcons();
                            if (current != IntPtr.Zero && IsWindowVisible(current)) SetVisible(current, false);
                            // Titles change while QX runs; refresh them so the QX
                            // taskbar button can be located again after a retitle.
                            string ownerTitle = OwnerTitle(parent);
                            string ownerExecutable = OwnerExecutable(parent);
                            string command;
                            while (commands.TryDequeue(out command))
                            {
                                if (command == "taskbar-hide" || command == "taskbar-show" || command == "taskbar-own")
                                    UpdateTaskbar(taskbar, command, ownerTitle, ownerExecutable);
                                else if (command.StartsWith("embed-", StringComparison.Ordinal))
                                    HandleEmbed(embedder, command, processId);
                            }
                            // A re-created QX window (for example after a GPU restart)
                            // gets a new handle, so resolve it every tick.
                            IntPtr ownerWindow = OwnerWindow(parent);
                            foreach (WindowEmbedder.Lost ended in embedder.Tick(ownerWindow))
                                Console.WriteLine("EMBED-LOST\t" + ended.Handle.ToInt64() + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(ended.Reason ?? "")));
                            long flashHandle;
                            bool flashOn;
                            while (flashes.TryRead(out flashHandle, out flashOn))
                            {
                                if (!embedder.Contains(flashHandle)) continue;
                                Console.WriteLine("EMBED-FLASH\t" + flashHandle + "\t" + (flashOn ? "1" : "0"));
                            }
                            if (taskbar.Hidden)
                            {
                                try { taskbar.Reapply(ownerTitle, ownerExecutable); }
                                catch (Exception error)
                                {
                                    taskbar.Restore();
                                    ReportTaskbar(false, error.Message);
                                }
                            }
                        }
                    }
                    finally
                    {
                        try { flashes.Dispose(); } catch { }
                        try { embedder.RestoreAll(); }
                        finally { try { taskbar.Restore(); }
                        finally
                        {
                            IntPtr current = DesktopIcons();
                            if (current != IntPtr.Zero) SetVisible(current, originalVisible);
                        } }
                        try { Console.WriteLine("RESTORED"); } catch (IOException) { }
                    }
                }
                return 0;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private static void ReportTaskbar(bool hidden, string error)
    {
        Console.WriteLine("TASKBAR\t" + (hidden ? "1" : "0") + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(error ?? "")));
    }

    private static int Number(string value)
    {
        int number;
        if (!Int32.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out number)) throw new InvalidOperationException("无效的内嵌位置");
        return number;
    }

    private static long Handle(string value)
    {
        long handle;
        if (!Int64.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out handle)) throw new InvalidOperationException("无效的应用窗口标识");
        return handle;
    }

    private static void HandleEmbed(WindowEmbedder embedder, string command, int processId)
    {
        string[] fields = command.Split('\t');
        if (fields.Length < 2 || fields[1].Length == 0) return;
        string error = null;
        try
        {
            if (fields[0] == "embed-attach")
            {
                if (fields.Length != 7) throw new InvalidOperationException("无效的内嵌请求");
                embedder.Attach(Handle(fields[2]), Number(fields[3]), Number(fields[4]), Number(fields[5]), Number(fields[6]), processId);
            }
            else if (fields[0] == "embed-bounds")
            {
                if (fields.Length != 7) throw new InvalidOperationException("无效的内嵌位置");
                embedder.Bounds(Handle(fields[2]), Number(fields[3]), Number(fields[4]), Number(fields[5]), Number(fields[6]));
            }
            else if (fields[0] == "embed-show")
            {
                if (fields.Length != 3) throw new InvalidOperationException("无效的内嵌显示请求");
                embedder.Show(Handle(fields[2]));
            }
            else if (fields[0] == "embed-hide")
            {
                if (fields.Length != 3) throw new InvalidOperationException("无效的内嵌隐藏请求");
                embedder.Hide(Handle(fields[2]));
            }
            else if (fields[0] == "embed-detach")
            {
                if (fields.Length != 3) throw new InvalidOperationException("无效的内嵌关闭请求");
                embedder.Detach(Handle(fields[2]));
            }
            else throw new InvalidOperationException("未知的内嵌操作");
        }
        catch (Exception failure) { error = failure.Message; }
        Console.WriteLine("EMBED\t" + fields[1] + "\t" + (error == null ? "1" : "0") + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(error ?? "")));
    }

    private static IntPtr OwnerWindow(Process parent)
    {
        try
        {
            IntPtr handle = parent.MainWindowHandle;
            if (handle != IntPtr.Zero) return handle;
        }
        catch { }
        int pid;
        try { pid = parent.Id; } catch { return IntPtr.Zero; }
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint ownerPid;
            GetWindowThreadProcessId(window, out ownerPid);
            if (ownerPid != (uint)pid || !IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static string OwnerTitle(Process parent)
    {
        try { return parent.MainWindowTitle ?? ""; }
        catch { return ""; }
    }

    private static string OwnerExecutable(Process parent)
    {
        try { return parent.MainModule.FileName ?? ""; }
        catch { return ""; }
    }

    private static void UpdateTaskbar(TaskbarVisibility taskbar, string command, string ownerTitle, string ownerExecutable)
    {
        try
        {
            if (command == "taskbar-hide") taskbar.Hide();
            else if (command == "taskbar-own") taskbar.ShowOnly(ownerTitle, ownerExecutable);
            else taskbar.Restore();
            ReportTaskbar(taskbar.Hidden, null);
        }
        catch (Exception error)
        {
            taskbar.Restore();
            ReportTaskbar(false, error.Message);
        }
    }

    private static void EnableDpiAwareness()
    {
        // UIA reports physical pixels; ScreenToClient must use the same space so the
        // taskbar clipping region stays aligned on scaled displays.
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; // PER_MONITOR_AWARE_V2
        }
        catch (EntryPointNotFoundException) { }
        try { SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { }
    }

    private static int Main(string[] args)
    {
        try
        {
            EnableDpiAwareness();
            // Detached processes have pipes but no console code page to configure.
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            if (args.Length == 1 && args[0] == "icons") { ReadIcons(); return 0; }
            if (args.Length == 2 && args[0] == "guard") return GuardDesktop(int.Parse(args[1]));
            if (args.Length == 2 && args[0] == "dock") return TaskbarDock.Run(int.Parse(args[1]));
            if (args.Length == 1 && args[0] == "desktop-state")
            {
                IntPtr window = DesktopIcons();
                Console.WriteLine(window.ToInt64() + "\t" + (window != IntPtr.Zero && IsWindowVisible(window) ? "1" : "0"));
                return window == IntPtr.Zero ? 1 : 0;
            }
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}

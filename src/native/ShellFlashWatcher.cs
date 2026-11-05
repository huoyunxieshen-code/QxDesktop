using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Listens to the shell's attention notifications. Windows posts HSHELL_FLASH
// for every flash toggle of a taskbar window, so the mirror can stop blinking
// when the app stops; the handle is the flashing window.
internal sealed class ShellFlashWatcher : IDisposable
{
    internal struct Event
    {
        internal long Handle;
        internal bool Flashing;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        internal IntPtr Handle;
        internal uint Message;
        internal IntPtr WParam;
        internal IntPtr LParam;
        internal uint Time;
        internal int X;
        internal int Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        internal uint Size;
        internal uint Style;
        internal IntPtr WindowProc;
        internal int ClassExtra;
        internal int WindowExtra;
        internal IntPtr Instance;
        internal IntPtr Icon;
        internal IntPtr Cursor;
        internal IntPtr Background;
        [MarshalAs(UnmanagedType.LPWStr)] internal string MenuName;
        [MarshalAs(UnmanagedType.LPWStr)] internal string ClassName;
        internal IntPtr SmallIcon;
    }

    private delegate IntPtr WndProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private const int HSHELL_WINDOWACTIVATED = 4;
    private const int HSHELL_RUDEAPPACTIVATED = unchecked((int)0x8004);
    private const int HSHELL_FLASH = unchecked((int)0x8006);
    private const uint WM_QUIT = 0x0012;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassEx(ref WNDCLASSEX info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowEx(int exStyle, string className, string title, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll")] private static extern bool RegisterShellHookWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool DeregisterShellHookWindow(IntPtr window);
    [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private readonly ConcurrentQueue<Event> events = new ConcurrentQueue<Event>();
    private readonly ManualResetEvent started = new ManualResetEvent(false);
    private readonly WndProc callback;
    private readonly uint shellHook;
    private Thread thread;
    private uint threadId;
    private IntPtr window;
    private volatile bool running;

    internal ShellFlashWatcher()
    {
        callback = WindowProc;
        shellHook = RegisterWindowMessage("SHELLHOOK");
    }

    internal void Start()
    {
        if (thread != null || shellHook == 0) return;
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Name = "QX shell flash";
        thread.Start();
        // A missing shell hook only disables the tab blink; startup must not wait long.
        started.WaitOne(600);
    }

    private void Run()
    {
        threadId = GetCurrentThreadId();
        try
        {
            WNDCLASSEX info = new WNDCLASSEX();
            info.Size = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
            info.WindowProc = Marshal.GetFunctionPointerForDelegate(callback);
            info.Instance = GetModuleHandle(null);
            info.ClassName = "QXDesktopShellFlash";
            if (RegisterClassEx(ref info) == 0) return;
            // A hidden top-level window (not message-only) is the form the shell
            // hook API has been reliable with across Windows versions.
            window = CreateWindowEx(WS_EX_TOOLWINDOW, info.ClassName, "", unchecked((int)0x80000000), 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, info.Instance, IntPtr.Zero);
            if (window == IntPtr.Zero) return;
            if (!RegisterShellHookWindow(window)) return;
            running = true;
        }
        finally { started.Set(); }
        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        running = false;
        if (window != IntPtr.Zero)
        {
            DeregisterShellHookWindow(window);
            DestroyWindow(window);
            window = IntPtr.Zero;
        }
    }

    private IntPtr WindowProc(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (running && message == shellHook)
        {
            int code = wParam.ToInt32();
            long target = lParam.ToInt64();
            if (target > 0 && (code == HSHELL_FLASH || code == HSHELL_WINDOWACTIVATED || code == HSHELL_RUDEAPPACTIVATED))
                events.Enqueue(new Event { Handle = target, Flashing = code == HSHELL_FLASH });
        }
        return DefWindowProc(handle, message, wParam, lParam);
    }

    internal bool TryRead(out long handle, out bool flashing)
    {
        Event value;
        if (!events.TryDequeue(out value))
        {
            handle = 0;
            flashing = false;
            return false;
        }
        handle = value.Handle;
        flashing = value.Flashing;
        return true;
    }

    public void Dispose()
    {
        if (thread == null) return;
        if (running) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        thread.Join(500);
        thread = null;
    }
}

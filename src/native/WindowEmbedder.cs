using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// Keeps other applications' windows as frameless overlays above the QX window.
// The guard owns every embed so a crash or a normal exit always restores the
// original frame, size and visibility instead of leaving a broken window behind.
internal sealed class WindowEmbedder
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        internal int Left, Top, Right, Bottom;
        internal int Width { get { return Right - Left; } }
        internal int Height { get { return Bottom - Top; } }
    }

    internal struct Lost
    {
        internal IntPtr Handle;
        internal string Reason;
    }

    private sealed class Entry
    {
        internal IntPtr Handle;
        internal long Style, ExStyle;
        internal Rect Original, Target;
        internal Rect Clip;
        internal bool Clipped;
        internal bool Visible, Maximized;
        internal bool Shown = true;
        internal bool Suspended;
        internal int StyleFights;
    }

    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_CAPTION = 0x00C00000L;
    private const long WS_THICKFRAME = 0x00040000L;
    private const long WS_SYSMENU = 0x00080000L;
    private const long WS_MINIMIZEBOX = 0x00020000L;
    private const long WS_MAXIMIZEBOX = 0x00010000L;
    private const long WS_POPUP = unchecked((long)0x80000000L);
    private const long WS_VISIBLE = 0x10000000L;
    private const long WS_EX_TOPMOST = 0x00000008L;
    private const uint GA_ROOT = 2;
    private const uint GW_HWNDPREV = 3;
    private const int SW_HIDE = 0;
    private const int SW_SHOWNOACTIVATE = 4;
    private const int SW_SHOWMAXIMIZED = 3;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint SWP_ASYNCWINDOWPOS = 0x4000;

    private static readonly HashSet<string> Unsupported = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        // UWP shells host their content in another process; their frame cannot be
        // resized or restyled the way a classic desktop window can.
        "ApplicationFrameWindow", "Windows.UI.Core.CoreWindow", "Windows.Internal.Shell.TabProxyWindow",
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "TaskListThumbnailWnd",
        "MultitaskingViewFrame", "ForegroundStaging", "XamlExplorerHostIslandWindow",
        "TopLevelWindowForOverflowXamlIsland", "NotifyIconOverflowWindow", "#32768"
    };

    private readonly Dictionary<long, Entry> entries = new Dictionary<long, Entry>();

    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong32(IntPtr window, int index, int value);

    private static long GetLong(IntPtr window, int index)
    {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(window, index).ToInt64() : GetWindowLong32(window, index);
    }

    private static void SetLong(IntPtr window, int index, long value)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(window, index, new IntPtr(value));
        else SetWindowLong32(window, index, unchecked((int)value));
    }

    private static string ClassName(IntPtr window)
    {
        StringBuilder name = new StringBuilder(256);
        return GetClassName(window, name, name.Capacity) > 0 ? name.ToString() : "";
    }

    private static bool Same(Rect left, Rect right)
    {
        return Math.Abs(left.Left - right.Left) <= 1 && Math.Abs(left.Top - right.Top) <= 1 &&
            Math.Abs(left.Right - right.Right) <= 1 && Math.Abs(left.Bottom - right.Bottom) <= 1;
    }

    private static void Move(IntPtr window, Rect rect, uint extra)
    {
        SetWindowPos(window, IntPtr.Zero, rect.Left, rect.Top, Math.Max(1, rect.Width), Math.Max(1, rect.Height),
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS | extra);
    }

    private static Rect Intersect(Rect left, Rect right)
    {
        return new Rect {
            Left = Math.Max(left.Left, right.Left),
            Top = Math.Max(left.Top, right.Top),
            Right = Math.Min(left.Right, right.Right),
            Bottom = Math.Min(left.Bottom, right.Bottom)
        };
    }

    // Applications such as QT-based ones may keep their minimum window height,
    // leaving the extra part outside the panel over the footer or taskbar. Clip
    // the window to the application-space rectangle so nothing escapes it.
    private static void ClipToTarget(Entry entry)
    {
        Rect current;
        if (!GetWindowRect(entry.Handle, out current)) return;
        // An asynchronous move may not be applied yet; the guard tick retries.
        if (Math.Abs(current.Left - entry.Target.Left) > 1 || Math.Abs(current.Top - entry.Target.Top) > 1) return;
        Rect visible = Intersect(current, entry.Target);
        bool needed = visible.Width > 0 && visible.Height > 0 && !Same(current, visible);
        if (!needed)
        {
            if (!entry.Clipped) return;
            entry.Clipped = false;
            SetWindowRgn(entry.Handle, IntPtr.Zero, true);
            return;
        }
        Rect local = new Rect {
            Left = visible.Left - current.Left,
            Top = visible.Top - current.Top,
            Right = visible.Right - current.Left,
            Bottom = visible.Bottom - current.Top
        };
        if (entry.Clipped && Same(entry.Clip, local)) return;
        IntPtr region = CreateRectRgn(local.Left, local.Top, local.Right, local.Bottom);
        if (region == IntPtr.Zero) return;
        if (SetWindowRgn(entry.Handle, region, true) == 0)
        {
            DeleteObject(region);
            return;
        }
        entry.Clip = local;
        entry.Clipped = true;
    }

    internal static void Validate(IntPtr window, int qxPid)
    {
        if (!IsWindow(window)) throw new InvalidOperationException("应用窗口已关闭，请重新打开后再试");
        if (GetAncestor(window, GA_ROOT) != window || (GetLong(window, GWL_STYLE) & WS_CHILD) != 0)
            throw new InvalidOperationException("该窗口不是独立应用窗口，暂不支持内嵌");
        if (Unsupported.Contains(ClassName(window)))
            throw new InvalidOperationException("该应用使用系统托管窗口，暂不支持内嵌，已保留原窗口");
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid == 0 || pid == (uint)qxPid) throw new InvalidOperationException("不能内嵌 QX桌面自身的窗口");
        if (IsIconic(window)) throw new InvalidOperationException("应用窗口已最小化，请先恢复窗口再拖入");
        if (!IsWindowVisible(window)) throw new InvalidOperationException("应用窗口当前不可见，请先打开窗口再拖入");
    }

    internal void Attach(long handle, int left, int top, int right, int bottom, int qxPid)
    {
        IntPtr window = new IntPtr(handle);
        if (entries.ContainsKey(handle)) throw new InvalidOperationException("该窗口已经内嵌");
        Validate(window, qxPid);
        Rect target = new Rect { Left = left, Top = top, Right = right, Bottom = bottom };
        if (target.Width < 80 || target.Height < 80) throw new InvalidOperationException("内嵌区域太小，暂时无法显示应用");
        Rect original;
        if (!GetWindowRect(window, out original) || original.Width < 60 || original.Height < 60)
            throw new InvalidOperationException("无法读取应用窗口位置，暂不支持内嵌");
        Entry entry = new Entry {
            Handle = window, Original = original, Target = target,
            Style = GetLong(window, GWL_STYLE), ExStyle = GetLong(window, GWL_EXSTYLE),
            Visible = IsWindowVisible(window), Maximized = IsZoomed(window)
        };
        if (entry.Style == 0 && entry.ExStyle == 0)
            throw new InvalidOperationException("该应用不允许窗口内嵌，已保留原窗口");
        entries[handle] = entry;
        try
        {
            ApplyFrame(entry, true);
            Move(window, target, SWP_FRAMECHANGED);
            ClipToTarget(entry);
        }
        catch
        {
            entries.Remove(handle);
            Restore(entry);
            throw new InvalidOperationException("该应用不允许窗口内嵌，已保留原窗口");
        }
    }

    private static void ApplyFrame(Entry entry, bool force)
    {
        long style = GetLong(entry.Handle, GWL_STYLE);
        if (!force && (style & WS_CAPTION) == 0 && (style & WS_THICKFRAME) == 0) return;
        long frame = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CHILD;
        long nextStyle = (style & ~frame) | WS_POPUP | WS_VISIBLE;
        // The extended style is left untouched: stripping the taskbar button
        // (WS_EX_TOOLWINDOW) makes Windows drop FlashWindowEx attention requests,
        // so the embedded tab could no longer mirror the app's flashing.
        SetLong(entry.Handle, GWL_STYLE, nextStyle);
        SetWindowPos(entry.Handle, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        long applied = GetLong(entry.Handle, GWL_STYLE);
        if ((applied & WS_CAPTION) != 0 || (applied & WS_CHILD) != 0)
            throw new InvalidOperationException("该应用不允许窗口内嵌，已保留原窗口");
    }

    internal void Bounds(long handle, int left, int top, int right, int bottom)
    {
        Entry entry = Find(handle);
        entry.Target = new Rect { Left = left, Top = top, Right = right, Bottom = bottom };
        Move(entry.Handle, entry.Target, 0);
        ClipToTarget(entry);
    }

    internal void Show(long handle)
    {
        Entry entry = Find(handle);
        entry.Shown = true;
        entry.Suspended = false;
        Move(entry.Handle, entry.Target, 0);
        ClipToTarget(entry);
        ShowWindowAsync(entry.Handle, SW_SHOWNOACTIVATE);
    }

    internal void Hide(long handle)
    {
        Entry entry = Find(handle);
        entry.Shown = false;
        ShowWindowAsync(entry.Handle, SW_HIDE);
    }

    internal void Detach(long handle)
    {
        Entry entry = Find(handle);
        entries.Remove(handle);
        Restore(entry);
    }

    internal bool Contains(long handle)
    {
        return entries.ContainsKey(handle);
    }

    private Entry Find(long handle)    {
        Entry entry;
        if (!entries.TryGetValue(handle, out entry)) throw new InvalidOperationException("该标签的内嵌窗口已失效");
        if (!IsWindow(entry.Handle))
        {
            entries.Remove(handle);
            throw new InvalidOperationException("应用窗口已关闭");
        }
        return entry;
    }

    private static void Restore(Entry entry)
    {
        if (!IsWindow(entry.Handle)) return;
        ShowWindowAsync(entry.Handle, SW_HIDE);
        if (entry.Clipped)
        {
            entry.Clipped = false;
            SetWindowRgn(entry.Handle, IntPtr.Zero, true);
        }
        SetLong(entry.Handle, GWL_STYLE, entry.Style);
        SetLong(entry.Handle, GWL_EXSTYLE, entry.ExStyle);
        SetWindowPos(entry.Handle, IntPtr.Zero, entry.Original.Left, entry.Original.Top,
            Math.Max(1, entry.Original.Width), Math.Max(1, entry.Original.Height),
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        if (entry.Visible) ShowWindowAsync(entry.Handle, entry.Maximized ? SW_SHOWMAXIMIZED : SW_SHOWNOACTIVATE);
    }

    // Runs on the guard thread every tick. It keeps overlays glued to the QX
    // window region without activating them, and hides them whenever QX itself
    // is minimized so nothing floats over the desktop.
    internal List<Lost> Tick(IntPtr qxWindow)
    {
        List<Lost> lost = new List<Lost>();
        if (entries.Count == 0) return lost;
        bool qxUsable = qxWindow != IntPtr.Zero && IsWindow(qxWindow) && IsWindowVisible(qxWindow) && !IsIconic(qxWindow);
        IntPtr foreground = GetForegroundWindow();
        List<long> gone = new List<long>();
        foreach (KeyValuePair<long, Entry> pair in entries)
        {
            Entry entry = pair.Value;
            if (!IsWindow(entry.Handle))
            {
                gone.Add(pair.Key);
                lost.Add(new Lost { Handle = entry.Handle, Reason = "应用窗口已关闭，已退出内嵌" });
                continue;
            }
            if (!qxUsable)
            {
                if (entry.Shown && !entry.Suspended)
                {
                    entry.Suspended = true;
                    ShowWindowAsync(entry.Handle, SW_HIDE);
                }
                continue;
            }
            if (entry.Suspended)
            {
                entry.Suspended = false;
                if (entry.Shown) ShowWindowAsync(entry.Handle, SW_SHOWNOACTIVATE);
            }
            if (!entry.Shown) continue;
            try
            {
                long style = GetLong(entry.Handle, GWL_STYLE);
                if ((style & WS_CAPTION) != 0 || (style & WS_THICKFRAME) != 0)
                {
                    if (++entry.StyleFights > 12)
                    {
                        gone.Add(pair.Key);
                        lost.Add(new Lost { Handle = entry.Handle, Reason = "该应用拒绝以无边框方式内嵌，已恢复原窗口" });
                        continue;
                    }
                    ApplyFrame(entry, true);
                }
                else entry.StyleFights = 0;
            }
            catch
            {
                gone.Add(pair.Key);
                lost.Add(new Lost { Handle = entry.Handle, Reason = "该应用拒绝以无边框方式内嵌，已恢复原窗口" });
                continue;
            }
            Rect current;
            if (GetWindowRect(entry.Handle, out current))
            {
                // The renderer reports the panel rectangle; anything else (the app
                // resizing itself, a restored window) is pulled back.
                if (!Stuck(entry, current)) Move(entry.Handle, entry.Target, 0);
                ClipToTarget(entry);
            }
            if (foreground == entry.Handle || foreground == qxWindow) KeepAbove(entry.Handle, qxWindow);
        }
        foreach (long handle in gone)
        {
            Entry entry = entries[handle];
            entries.Remove(handle);
            Restore(entry);
        }
        return lost;
    }

    private static bool Stuck(Entry entry, Rect current)
    {
        return Same(current, entry.Target);
    }

    private static bool IsTopmost(IntPtr window)
    {
        return (GetLong(window, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    }

    private static void KeepAbove(IntPtr window, IntPtr qxWindow)
    {
        // Inserting behind a topmost window would make the overlay topmost too,
        // which lets a taller-than-panel app cover the taskbar.
        if (IsTopmost(window))
            SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
        IntPtr above = GetWindow(qxWindow, GW_HWNDPREV);
        while (above != IntPtr.Zero && IsTopmost(above)) above = GetWindow(above, GW_HWNDPREV);
        if (above == window) return;
        SetWindowPos(window, above, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    }

    internal void RestoreAll()
    {
        foreach (Entry entry in entries.Values) Restore(entry);
        entries.Clear();
    }
}

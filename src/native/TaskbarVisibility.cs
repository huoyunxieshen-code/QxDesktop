using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal sealed class TaskbarVisibility
{
    private sealed class SavedView
    {
        internal IntPtr Handle;
        internal uint ProcessId;
        internal bool Visible;
        internal int ScreenLeft;
        internal int ScreenTop;
        internal bool ShiftSet;
        internal int Shift;
    }

    private sealed class OwnedView
    {
        internal IntPtr Handle;
        internal RECT Rect;
        internal int OwnerLeft;
        internal int LeftmostLeft;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        internal int X;
        internal int Y;
    }

    [ComImport, Guid("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomation
    {
        void CompareElements();
        void CompareRuntimeIds();
        void GetRootElement();
        IUIAutomationElement ElementFromHandle(IntPtr handle);
        void ElementFromPoint();
        void GetFocusedElement();
        void GetRootElementBuildCache();
        void ElementFromHandleBuildCache();
        void ElementFromPointBuildCache();
        void GetFocusedElementBuildCache();
        void CreateTreeWalker();
        void GetControlViewWalker();
        void GetContentViewWalker();
        void GetRawViewWalker();
        void GetRawViewCondition();
        void GetControlViewCondition();
        void GetContentViewCondition();
        void CreateCacheRequest();
        [return: MarshalAs(UnmanagedType.Interface)] object CreateTrueCondition();
    }

    [ComImport, Guid("D22108AA-8AC5-49A5-837B-37BBB3D7591E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationElement
    {
        void SetFocus();
        [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] int[] GetRuntimeId();
        void FindFirst();
        IUIAutomationElementArray FindAll(int scope, [MarshalAs(UnmanagedType.Interface)] object condition);
        void FindFirstBuildCache();
        void FindAllBuildCache();
        void BuildUpdatedCache();
        [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int property);
        void GetCurrentPropertyValueEx();
        void GetCachedPropertyValue();
        void GetCachedPropertyValueEx();
        void GetCurrentPatternAs();
        void GetCachedPatternAs();
        [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int pattern);
    }

    [ComImport, Guid("14314595-B4BC-4055-95F2-58F2E42C9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationElementArray
    {
        int Length { get; }
        IUIAutomationElement GetElement(int index);
    }

    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref POINT point);
    [DllImport("user32.dll")] private static extern bool MapWindowPoints(IntPtr from, IntPtr to, ref POINT points, uint count);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("user32.dll")] private static extern int GetWindowRgnBox(IntPtr window, out RECT box);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);

    private readonly Dictionary<IntPtr, SavedView> saved = new Dictionary<IntPtr, SavedView>();
    private readonly Dictionary<IntPtr, RECT> regions = new Dictionary<IntPtr, RECT>();
    // A non-empty region keeps the toolbar's UIA tree alive; an empty region makes
    // the shell hide every taskbar button from automation, so the QX button could
    // no longer be located before clipping.
    private static readonly RECT HiddenRegion = new RECT { Left = -20000, Top = -20000, Right = -19960, Bottom = -19960 };
    private readonly Stopwatch ownRetry = Stopwatch.StartNew();
    private object automationHost;
    private object trueCondition;
    private int mode; // 0 = visible, 1 = hidden, 2 = own only
    private bool ownFallback;

    internal bool Hidden { get { return mode != 0; } }

    private static string ClassName(IntPtr window)
    {
        StringBuilder name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        return name.ToString();
    }

    internal static List<IntPtr> Views()
    {
        List<IntPtr> views = new List<IntPtr>();
        bool unsupported = false;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            string name = ClassName(window);
            if (name != "Shell_TrayWnd" && name != "Shell_SecondaryTrayWnd") return true;
            int before = views.Count;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                if (ClassName(child) == "MSTaskListWClass") views.Add(child);
                return true;
            }, IntPtr.Zero);
            if (views.Count == before) unsupported = true;
            return true;
        }, IntPtr.Zero);
        if (unsupported || views.Count == 0) throw new InvalidOperationException("当前任务栏不支持只隐藏应用图标，已保留系统任务栏");
        return views;
    }

    private static bool OwnVisible(IntPtr window)
    {
        // IsWindowVisible also includes ancestors, which breaks restoration of auto-hidden taskbars.
        return (GetWindowLong(window, -16) & 0x10000000) != 0;
    }

    private static void SetVisible(IntPtr window, bool visible)
    {
        if (OwnVisible(window) == visible) return;
        ShowWindowAsync(window, visible ? 8 : 0);
        Stopwatch timer = Stopwatch.StartNew();
        while (IsWindow(window) && OwnVisible(window) != visible && timer.ElapsedMilliseconds < 1500) Thread.Sleep(20);
        if (IsWindow(window) && OwnVisible(window) != visible) throw new InvalidOperationException("任务栏应用图标显示状态未能恢复或更新");
    }

    private void Remember(List<IntPtr> views)
    {
        foreach (IntPtr view in views)
        {
            uint processId;
            GetWindowThreadProcessId(view, out processId);
            SavedView original;
            if (!saved.TryGetValue(view, out original) || original.ProcessId != processId)
            {
                RECT rect;
                GetWindowRect(view, out rect);
                saved[view] = new SavedView { Handle = view, ProcessId = processId, Visible = OwnVisible(view), ScreenLeft = rect.Left, ScreenTop = rect.Top };
            }
        }
    }

    private static bool MatchesExecutable(string automationId, string executable)
    {
        if (automationId.Length == 0 || executable.Length == 0) return false;
        string id = automationId;
        if (id.StartsWith("Appid:", StringComparison.OrdinalIgnoreCase)) id = id.Substring(6).Trim();
        if (String.Equals(id, executable, StringComparison.OrdinalIgnoreCase)) return true;
        // Some shell versions expose only the file name or an executable-relative id.
        bool looksLikePath = id.IndexOf('\\') >= 0 || id.IndexOf('/') >= 0;
        if (!looksLikePath) return false;
        try { return String.Equals(Path.GetFileName(id), Path.GetFileName(executable), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    private static bool MatchesOwner(string name, string title, string executable)
    {
        string baseName = "";
        try { baseName = Path.GetFileNameWithoutExtension(executable); }
        catch { }
        if (baseName.Length > 0)
        {
            // Windows 10 shows either the window title or the executable name as the button name.
            if (String.Equals(name, baseName, StringComparison.OrdinalIgnoreCase)) return true;
            if (name.StartsWith(baseName + " - ", StringComparison.OrdinalIgnoreCase)) return true;
            if (name.StartsWith(baseName + " · ", StringComparison.OrdinalIgnoreCase)) return true;
        }
        if (name.Length == 0 || title.Length == 0) return false;
        if (String.Equals(name, title, StringComparison.OrdinalIgnoreCase)) return true;
        // A grouped taskbar button appends a localized " - N running windows" suffix.
        return name.StartsWith(title + " - ", StringComparison.OrdinalIgnoreCase);
    }

    private IUIAutomation Automation()
    {
        if (automationHost == null)
            automationHost = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E")));
        return (IUIAutomation)automationHost;
    }

    private object Condition()
    {
        if (trueCondition == null) trueCondition = Automation().CreateTrueCondition();
        return trueCondition;
    }

    private bool FindOwner(IntPtr view, string title, string executable, out RECT result, out int ownerLeft, out int leftmostLeft)
    {
        result = new RECT();
        ownerLeft = 0;
        leftmostLeft = 0;
        bool matched = false;
        int minimum = int.MaxValue;
        IUIAutomationElement root = null;
        IUIAutomationElementArray all = null;
        try
        {
            IUIAutomation uia = Automation();
            root = uia.ElementFromHandle(view);
            all = root.FindAll(4, Condition()); // TreeScope_Descendants
            for (int index = 0; index < all.Length; index++)
            {
                IUIAutomationElement element = all.GetElement(index);
                try
                {
                    object control = element.GetCurrentPropertyValue(30003);
                    int type = control is int ? (int)control : 0;
                    if (type != 50000 && type != 50011) continue;
                    double[] bounds = element.GetCurrentPropertyValue(30001) as double[];
                    if (bounds == null || bounds.Length < 4 || bounds[2] <= 0 || bounds[3] <= 0) continue;
                    int left = (int)Math.Round(bounds[0]);
                    if (left < minimum) minimum = left;
                    string name = element.GetCurrentPropertyValue(30005) as string ?? "";
                    string automationId = element.GetCurrentPropertyValue(30011) as string ?? "";
                    if (!MatchesExecutable(automationId, executable) && !MatchesOwner(name, title, executable)) continue;
                    POINT topLeft = new POINT { X = left, Y = (int)Math.Round(bounds[1]) };
                    POINT bottomRight = new POINT { X = (int)Math.Round(bounds[0] + bounds[2]), Y = (int)Math.Round(bounds[1] + bounds[3]) };
                    if (!ScreenToClient(view, ref topLeft) || !ScreenToClient(view, ref bottomRight)) continue;
                    result = new RECT { Left = topLeft.X - 2, Top = topLeft.Y - 2, Right = bottomRight.X + 2, Bottom = bottomRight.Y + 2 };
                    ownerLeft = left;
                    matched = true;
                }
                finally { if (Marshal.IsComObject(element)) Marshal.ReleaseComObject(element); }
            }
            if (matched) leftmostLeft = minimum == int.MaxValue ? ownerLeft : Math.Min(minimum, ownerLeft);
        }
        finally
        {
            if (all != null) Marshal.ReleaseComObject(all);
            if (root != null) Marshal.ReleaseComObject(root);
        }
        return matched;
    }

    private bool TryFindOwner(IntPtr view, string title, string executable, out RECT rect, out int ownerLeft, out int leftmostLeft)
    {
        try { return FindOwner(view, title, executable, out rect, out ownerLeft, out leftmostLeft); }
        catch
        {
            // A transient UIA hiccup must not drop the already clipped taskbar.
            rect = new RECT();
            ownerLeft = 0;
            leftmostLeft = 0;
            return false;
        }
    }

    // Shift the whole task list left so the QX button sits where the first app
    // button normally starts. Button order, pinned apps and the registry are
    // untouched; the window is put back when takeover ends or QX is restored.
    // The shift is measured once and reused: re-measuring every tick made the
    // window oscillate when UIA stopped reporting buttons clipped off-screen.
    private void PositionOwner(IntPtr view, int ownerLeft, int leftmostLeft)
    {
        SavedView original;
        if (!saved.TryGetValue(view, out original)) return;
        if (!original.ShiftSet)
        {
            original.Shift = Math.Min(0, leftmostLeft - ownerLeft);
            original.ShiftSet = true;
        }
        int desiredLeft = original.ScreenLeft + original.Shift;
        int desiredTop = original.ScreenTop;
        RECT current;
        if (!GetWindowRect(view, out current)) return;
        if (current.Left == desiredLeft && current.Top == desiredTop) return;
        IntPtr parent = GetParent(view);
        if (parent == IntPtr.Zero) return;
        POINT point = new POINT { X = desiredLeft, Y = desiredTop };
        if (!MapWindowPoints(IntPtr.Zero, parent, ref point, 1)) return;
        SetWindowPos(view, IntPtr.Zero, point.X, point.Y, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    private void RestorePositions()
    {
        foreach (SavedView original in saved.Values)
        {
            uint processId;
            GetWindowThreadProcessId(original.Handle, out processId);
            if (!IsWindow(original.Handle) || processId != original.ProcessId || ClassName(original.Handle) != "MSTaskListWClass") continue;
            RECT current;
            if (!GetWindowRect(original.Handle, out current) || (current.Left == original.ScreenLeft && current.Top == original.ScreenTop)) continue;
            IntPtr parent = GetParent(original.Handle);
            if (parent == IntPtr.Zero) continue;
            POINT point = new POINT { X = original.ScreenLeft, Y = original.ScreenTop };
            if (!MapWindowPoints(IntPtr.Zero, parent, ref point, 1)) continue;
            SetWindowPos(original.Handle, IntPtr.Zero, point.X, point.Y, 0, 0, 0x0001 | 0x0004 | 0x0010);
        }
    }

    private static bool SameRect(RECT left, RECT right)
    {
        return left.Left == right.Left && left.Top == right.Top && left.Right == right.Right && left.Bottom == right.Bottom;
    }

    private static bool RegionMatches(IntPtr view, RECT rect)
    {
        RECT box;
        int type = GetWindowRgnBox(view, out box);
        // ERROR means the shell removed our region; NULLREGION means it was emptied.
        if (type == 0) return false;
        return type != 1 && SameRect(box, rect);
    }

    // Windows 10's task list ignores toolbar messages (TB_BUTTONCOUNT stays 0 even
    // while shown), so TB_HIDEBUTTON cannot hide one button. Clipping the task list
    // window to the QX button's UIA rectangle keeps that button native and clickable.
    // Hiding icons uses a screen-external region instead of an empty one so the
    // toolbar keeps exposing its buttons to UIA while nothing is painted.
    private void ApplyRegion(IntPtr view, RECT rect)
    {
        RECT previous;
        if (regions.TryGetValue(view, out previous) && SameRect(previous, rect) && RegionMatches(view, rect)) return;
        IntPtr region = CreateRectRgn(rect.Left, rect.Top, rect.Right, rect.Bottom);
        if (region == IntPtr.Zero) throw new InvalidOperationException("无法创建任务栏裁剪区域");
        if (SetWindowRgn(view, region, true) == 0)
        {
            DeleteObject(region);
            throw new InvalidOperationException(rect.Left < 0 ? "无法隐藏任务栏应用图标" : "无法将任务栏限制到 QX桌面按钮");
        }
        regions[view] = rect;
    }

    private void HideIcons(IntPtr view)
    {
        ApplyRegion(view, HiddenRegion);
    }

    private bool ApplyOwn(List<IntPtr> views, string title, string executable, bool reveal)
    {
        List<OwnedView> owners = new List<OwnedView>();
        List<IntPtr> others = new List<IntPtr>();
        foreach (IntPtr view in views)
        {
            RECT rect;
            int ownerLeft;
            int leftmostLeft;
            if (TryFindOwner(view, title, executable, out rect, out ownerLeft, out leftmostLeft))
                owners.Add(new OwnedView { Handle = view, Rect = rect, OwnerLeft = ownerLeft, LeftmostLeft = leftmostLeft });
            else
                others.Add(view);
        }
        foreach (OwnedView owner in owners)
        {
            if (reveal) SetVisible(owner.Handle, true);
            ApplyRegion(owner.Handle, owner.Rect);
            PositionOwner(owner.Handle, owner.OwnerLeft, owner.LeftmostLeft);
            if (!reveal) SetVisible(owner.Handle, true);
        }
        // Only mute taskbars without a QX桌面 button once the button was found
        // somewhere; a transient UIA miss must not blank every icon.
        if (owners.Count > 0)
            foreach (IntPtr view in others) HideIcons(view);
        return owners.Count > 0;
    }

    private static bool SameViews(List<IntPtr> left, List<IntPtr> right)
    {
        if (left.Count != right.Count) return false;
        foreach (IntPtr view in left) if (!right.Contains(view)) return false;
        return true;
    }

    private bool Fallback(List<IntPtr> views)
    {
        ownFallback = true;
        mode = 2;
        // Keep the other icons clipped instead of flashing the full taskbar back:
        // a lookup miss is usually transient, and Reapply retries every second.
        RestorePositions();
        foreach (IntPtr view in views) HideIcons(view);
        return false;
    }

    internal bool ShowOnly(string title, string executable)
    {
        ownRetry.Restart();
        List<IntPtr> views = Views();
        Remember(views);
        if (String.IsNullOrEmpty(title) && String.IsNullOrEmpty(executable)) return Fallback(views);
        // Hidden task lists keep a valid UIA layout, so clip before revealing and
        // other buttons never flicker. Fall back to reveal-then-clip if needed.
        bool found = ApplyOwn(views, title, executable, false);
        if (!found)
        {
            foreach (IntPtr view in views) SetVisible(view, true);
            found = ApplyOwn(views, title, executable, true);
        }
        List<IntPtr> current = Views();
        if (!SameViews(views, current))
        {
            // Explorer rebuilt the task list while it was being revealed.
            foreach (IntPtr view in current) if (!views.Contains(view)) SetVisible(view, true);
            found = ApplyOwn(current, title, executable, true);
        }
        if (!found) return Fallback(current);
        ownFallback = false;
        mode = 2;
        return true;
    }

    internal bool Reapply(string title, string executable)
    {
        if (mode == 0) return true;
        List<IntPtr> views = Views();
        // Explorer may rebuild the task list; track the replacement so it can be
        // positioned and restored like the original window.
        Remember(views);
        if (mode == 1)
        {
            foreach (IntPtr view in views) HideIcons(view);
            return true;
        }
        if (ownFallback)
        {
            if (ownRetry.ElapsedMilliseconds < 1000) return false;
            return ShowOnly(title, executable);
        }
        bool found = false;
        bool clipped = false;
        foreach (IntPtr view in views)
        {
            RECT rect;
            int ownerLeft;
            int leftmostLeft;
            if (TryFindOwner(view, title, executable, out rect, out ownerLeft, out leftmostLeft))
            {
                SetVisible(view, true);
                ApplyRegion(view, rect);
                PositionOwner(view, ownerLeft, leftmostLeft);
                found = true;
                clipped = true;
            }
            else
            {
                RECT previous;
                if (regions.TryGetValue(view, out previous))
                {
                    // Keep the last known clip through a transient UIA read miss, and
                    // reinstall it if the shell just dropped the region.
                    ApplyRegion(view, previous);
                    clipped = true;
                }
                else if (!saved.ContainsKey(view))
                {
                    // A taskbar we never managed has no QX桌面 button; mute its icons.
                    HideIcons(view);
                }
            }
        }
        if (clipped) return true;
        return found ? true : ShowOnly(title, executable);
    }

    internal void Hide()
    {
        List<IntPtr> views = Views();
        Remember(views);
        RestorePositions();
        // Clip instead of ShowWindow(0): the shell re-shows a hidden task list when
        // the blank taskbar is clicked, which made every app icon flash back.
        foreach (IntPtr view in views) HideIcons(view);
        ownFallback = false;
        mode = 1;
    }

    internal void Restore()
    {
        List<Exception> errors = new List<Exception>();
        List<IntPtr> views;
        try { views = Views(); }
        catch { views = new List<IntPtr>(saved.Keys); }
        RestorePositions();
        foreach (IntPtr view in views)
        {
            try { SetWindowRgn(view, IntPtr.Zero, true); }
            catch (Exception error) { errors.Add(error); }
        }
        foreach (SavedView view in saved.Values)
        {
            uint processId;
            GetWindowThreadProcessId(view.Handle, out processId);
            if (!IsWindow(view.Handle) || processId != view.ProcessId || ClassName(view.Handle) != "MSTaskListWClass") continue;
            try { SetVisible(view.Handle, view.Visible); }
            catch (Exception error) { errors.Add(error); }
        }
        if (errors.Count > 0) throw new AggregateException(errors);
        saved.Clear();
        regions.Clear();
        ownFallback = false;
        mode = 0;
    }
}

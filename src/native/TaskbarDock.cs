using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// A read-only inventory until an explicit, inventory-scoped activate request arrives.
// Keep this helper separate from the visibility guard: UIA failure must never hide anything.
internal static class TaskbarDock
{
    private sealed class Snapshot
    {
        public bool supported;
        public string error = "";
        public List<Item> items = new List<Item>();
    }

    private sealed class Item
    {
        public string id;
        public string title;
        public string icon;
        public bool running;
        public bool active;
        public List<WindowItem> windows = new List<WindowItem>();
    }

    private sealed class WindowItem
    {
        public string id;
        public string title;
        public long hwnd;
    }

    private sealed class ProcessInfo
    {
        internal uint Pid;
        internal long Birth;
        internal string Path = "";
        internal string AppId = "";
        internal string Description = "";
    }

    private sealed class WindowInfo
    {
        internal IntPtr Handle;
        internal ProcessInfo Process;
        internal string AppId, Title, Class, Key;
        internal string ContentPath = "";
        internal bool Excluded, Active;
    }

    private sealed class Pin
    {
        internal string Link, Title, Path, AppId;
    }

    private sealed class Button
    {
        internal IUIAutomationElement Element;
        internal IntPtr View;
        internal uint ShellPid;
        internal long ShellBirth;
        internal int[] RuntimeId;
        internal string Name, Title, AppId;
        internal int Count;
        internal bool Invoke, Expand;
        internal int ViewIndex, Order;
        internal double Left, Top, Width, Height;
    }

    private sealed class Target
    {
        internal WindowInfo Window;
        internal Button Button;
    }

    // UIA's native interfaces deliberately stop at the last slot used here. Do not reorder
    // the unused slots: the managed AutomationElement wrapper loses taskbar pattern data.
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

    [ComImport, Guid("FB377FBE-8EA6-46D5-9C73-6499642D3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationInvokePattern { void Invoke(); }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        internal Guid Format;
        internal uint Id;
        internal PropertyKey(Guid format, uint id) { Format = format; Id = id; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        internal ushort Type, Reserved1, Reserved2, Reserved3;
        internal IntPtr Pointer, Extra;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr findData, uint flags);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ImageSize { internal int Width, Height; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { internal int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { internal int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPlacement
    {
        internal int Length;
        internal int Flags;
        internal int ShowCmd;
        internal Point Minimum;
        internal Point Maximum;
        internal Rect Normal;
    }

    [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory
    {
        void GetImage(ImageSize size, uint flags, out IntPtr bitmap);
    }

    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int maximum);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetApplicationUserModelId(IntPtr process, ref uint size, StringBuilder appId);
    [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out IPropertyStore store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SHCreateItemInKnownFolder(ref Guid folder, uint flags, string item, ref Guid iid, out IShellItemImageFactory factory);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] private static extern IntPtr GetClassLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "GetClassLongW")] private static extern uint GetClassLong32(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern IntPtr CopyIcon(IntPtr icon);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr window, ref WindowPlacement placement);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr window, bool altTab);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private static readonly Guid AppIdFormat = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    // The count describes the entire application, even on an ungrouped, title-named button.
    private static readonly Regex RunningSuffix = new Regex(@"\s+-\s+(\d+)\s*(?:个(?:正在)?运行(?:的)?窗口|個(?:正在)?執行(?:中)?(?:的)?視窗|running windows?)\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    internal static int Run(int ownerPid)
    {
        int result = 1;
        // Native UIA clients belong on a non-UI MTA, including when the host Main is STA.
        Thread worker = new Thread(delegate() {
            try { using (Inventory inventory = new Inventory(ownerPid)) { result = inventory.Run(); } }
            catch (Exception error)
            {
                try { Emit(new Snapshot { error = "任务栏镜像后端不可用：" + error.Message }); } catch (IOException) { }
            }
        });
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        worker.Join();
        return result;
    }

    private static string Encode(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? "")); }
    private static void Emit(Snapshot snapshot)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = 16 * 1024 * 1024;
        Console.WriteLine("SNAPSHOT\t" + Encode(serializer.Serialize(snapshot)));
        Console.Out.Flush();
    }

    private static string ClassName(IntPtr window)
    {
        StringBuilder text = new StringBuilder(256);
        GetClassName(window, text, text.Capacity);
        return text.ToString();
    }

    private static string Text(IntPtr window)
    {
        StringBuilder text = new StringBuilder(Math.Min(32767, Math.Max(256, GetWindowTextLength(window) + 1)));
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    private static void Release(object value)
    {
        if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }

    private static string PropertyString(IUIAutomationElement element, int property)
    {
        return element.GetCurrentPropertyValue(property) as string ?? "";
    }

    private static bool PropertyBool(IUIAutomationElement element, int property)
    {
        object value = element.GetCurrentPropertyValue(property);
        return value is bool && (bool)value;
    }

    private static string ReadAppId(IPropertyStore store)
    {
        if (store == null) return "";
        PropertyKey key = new PropertyKey(AppIdFormat, 5);
        PropVariant value;
        if (store.GetValue(ref key, out value) < 0) return "";
        try
        {
            if (value.Type == 31) return Marshal.PtrToStringUni(value.Pointer) ?? "";
            if (value.Type == 8) return Marshal.PtrToStringBSTR(value.Pointer) ?? "";
            return "";
        }
        finally { PropVariantClear(ref value); }
    }

    private static string WindowAppId(IntPtr window)
    {
        IPropertyStore store = null;
        try
        {
            Guid iid = typeof(IPropertyStore).GUID;
            if (SHGetPropertyStoreForWindow(window, ref iid, out store) < 0) return "";
            return ReadAppId(store);
        }
        catch (COMException) { return ""; }
        finally { Release(store); }
    }

    private static string CanonicalPath(string path)
    {
        if (String.IsNullOrEmpty(path)) return "";
        try { return Path.GetFullPath(Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'))); }
        catch (ArgumentException) { return ""; }
        catch (NotSupportedException) { return ""; }
        catch (PathTooLongException) { return ""; }
    }

    private static bool Same(string left, string right)
    {
        return !String.IsNullOrEmpty(left) && !String.IsNullOrEmpty(right) && String.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }

    private static string Identity(string value)
    {
        if (value.StartsWith("Appid:", StringComparison.OrdinalIgnoreCase)) return value.Substring(6);
        return value;
    }

    private static ProcessInfo ReadProcess(uint pid)
    {
        ProcessInfo info = new ProcessInfo { Pid = pid };
        IntPtr process = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION; never request debug privileges.
        if (process == IntPtr.Zero) return info;
        try
        {
            long exit, kernel, user;
            GetProcessTimes(process, out info.Birth, out exit, out kernel, out user);
            StringBuilder path = new StringBuilder(32768);
            int size = path.Capacity;
            if (QueryFullProcessImageName(process, 0, path, ref size)) info.Path = CanonicalPath(path.ToString());
            uint length = 0;
            if (GetApplicationUserModelId(process, ref length, null) == 122 && length > 0 && length < 32768)
            {
                StringBuilder appId = new StringBuilder((int)length);
                if (GetApplicationUserModelId(process, ref length, appId) == 0) info.AppId = appId.ToString();
            }
            if (info.Path.Length > 0)
            {
                try { info.Description = FileVersionInfo.GetVersionInfo(info.Path).FileDescription ?? ""; }
                catch (Exception error) { if (!(error is IOException || error is UnauthorizedAccessException || error is ArgumentException)) throw; }
            }
        }
        finally { CloseHandle(process); }
        return info;
    }

    private static bool Switchable(IntPtr window)
    {
        if (!IsWindow(window) || !IsWindowVisible(window) || window == GetShellWindow()) return false;
        int style = GetWindowLong(window, -20);
        if ((style & 0x80) != 0) return false; // WS_EX_TOOLWINDOW
        if ((style & 0x08000000) != 0 && (style & 0x40000) == 0) return false; // NOACTIVATE, unless APPWINDOW
        if (GetWindow(window, 4) != IntPtr.Zero && (style & 0x40000) == 0) return false;
        int cloaked;
        if (DwmGetWindowAttribute(window, 14, out cloaked, 4) < 0)
            throw new InvalidOperationException("无法核验窗口是否位于当前桌面");
        if (cloaked != 0) return false;
        string name = ClassName(window);
        return name != "Progman" && name != "WorkerW" && name != "Shell_TrayWnd" && name != "Shell_SecondaryTrayWnd";
    }

    private sealed class Inventory : IDisposable
    {
        private readonly int ownerPid;
        private IUIAutomation automation;
        private readonly List<Button> buttons = new List<Button>();
        private Dictionary<string, Target> targets = new Dictionary<string, Target>(StringComparer.Ordinal);
        private Dictionary<string, string> ids = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly Dictionary<string, string> iconCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private Dictionary<string, string> nextIds;
        private Dictionary<string, Target> nextTargets;

        internal Inventory(int owner) { ownerPid = owner; }

        internal int Run()
        {
            Refresh();
            string command;
            while ((command = Console.ReadLine()) != null)
            {
                if (command == "refresh") { Refresh(); continue; }
                string[] fields = command.Split('\t');
                if (fields.Length < 2) continue;
                if (fields[0] == "activate") HandleActivate(fields);
                else if (fields[0] == "window") HandleWindow(fields);
            }
            return 0;
        }

        private void HandleActivate(string[] fields)
        {
            string error = "";
            try
            {
                if (fields.Length != 3 || fields[2].Length > 4096) throw new InvalidOperationException("无效的激活请求");
                string id = Decode(fields[2]);
                Target target;
                if (!targets.TryGetValue(id, out target)) throw new InvalidOperationException("此入口已过期，请刷新后重试");
                if (target.Window != null) ActivateWindow(target.Window);
                else
                {
                    try { InvokeButton(target.Button); }
                    catch (Exception invokeError)
                    {
                        Invalidate("任务栏入口已变化或 Explorer 不可用：" + invokeError.Message);
                        throw;
                    }
                }
            }
            catch (Exception failure) { error = failure.Message; }
            Console.WriteLine("RESULT\t" + fields[1] + "\t" + Encode(error));
            Console.Out.Flush();
        }

        private void HandleWindow(string[] fields)
        {
            string error = "";
            try
            {
                if (fields.Length != 4 || fields[2].Length > 4096) throw new InvalidOperationException("无效的窗口操作请求");
                string action = fields[3];
                if (action != "maximize" && action != "minimize" && action != "close") throw new InvalidOperationException("未知的窗口操作");
                Target target;
                if (!targets.TryGetValue(Decode(fields[2]), out target)) throw new InvalidOperationException("此入口已过期，请刷新后重试");
                if (target.Window == null) throw new InvalidOperationException("该应用尚未打开窗口");
                ControlWindow(target.Window, action);
            }
            catch (Exception failure) { error = failure.Message; }
            Console.WriteLine("RESULT\t" + fields[1] + "\t" + Encode(error));
            Console.Out.Flush();
        }

        private static string Decode(string value)
        {
            return new UTF8Encoding(false, true).GetString(Convert.FromBase64String(value));
        }

        private void ControlWindow(WindowInfo window, string action)
        {
            ValidateWindow(window);
            string name = window.Title.Length > 24 ? window.Title.Substring(0, 24) + "…" : window.Title;
            if (action == "close")
            {
                // Apps may ask to save before closing; report the request only.
                if (!PostMessage(window.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException("Windows 未允许关闭“" + name + "”，请使用系统任务栏");
                return;
            }
            bool maximize = action == "maximize";
            // SW_MAXIMIZE also restores a minimized window, then maximizes it.
            ShowWindowAsync(window.Handle, maximize ? 3 : 6);
            Stopwatch watch = Stopwatch.StartNew();
            while (true)
            {
                if (!IsWindow(window.Handle)) throw new InvalidOperationException("目标窗口已关闭");
                if (maximize ? IsZoomed(window.Handle) : IsIconic(window.Handle)) return;
                if (watch.ElapsedMilliseconds >= 1500) break;
                Thread.Sleep(30);
            }
            throw new InvalidOperationException(maximize ? "Windows 未允许最大化“" + name + "”，请使用系统任务栏" : "Windows 未允许最小化“" + name + "”，请使用系统任务栏");
        }

        private string Id(string key)
        {
            string id;
            if (!nextIds.TryGetValue(key, out id) && !ids.TryGetValue(key, out id)) id = Guid.NewGuid().ToString("N");
            nextIds[key] = id;
            return id;
        }

        private void ClearButtons()
        {
            foreach (Button button in buttons) Release(button.Element);
            buttons.Clear();
        }

        private void Invalidate(string error)
        {
            targets.Clear();
            ids.Clear();
            ClearButtons();
            Release(automation);
            automation = null;
            Emit(new Snapshot { error = error });
        }

        public void Dispose()
        {
            ClearButtons();
            Release(automation);
            automation = null;
        }

        private void Refresh()
        {
            Snapshot snapshot = null;
            Exception failure = null;
            // The shell is briefly inconsistent while windows open, close, minimize or a
            // tray flyout appears. Re-read instead of reporting that moment as a failure.
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try { snapshot = Build(); failure = null; break; }
                catch (Exception error)
                {
                    failure = error;
                    ClearButtons();
                    Release(automation);
                    automation = null;
                    if (attempt < 2) Thread.Sleep(120);
                }
            }
            if (snapshot == null)
            {
                snapshot = new Snapshot { supported = false, error = "任务栏镜像暂不可用：" + failure.Message };
                targets.Clear();
                ids.Clear();
                ClearButtons();
                Release(automation);
                automation = null;
            }
            Emit(snapshot);
        }

        private Snapshot Build()
        {
            Snapshot snapshot = new Snapshot();
            nextIds = new Dictionary<string, string>(StringComparer.Ordinal);
            nextTargets = new Dictionary<string, Target>(StringComparer.Ordinal);
            ClearButtons();
            {
                if (ownerPid <= 0) throw new InvalidOperationException("无效的 QX 主进程标识");
                if (iconCache.Count > 256) iconCache.Clear();
                ReadButtons();
                List<WindowInfo> windows = ReadWindows();
                List<Pin> pins = ReadPins();
                List<string> errors = new List<string>();
                HashSet<string> covered = new HashSet<string>(StringComparer.Ordinal);
                HashSet<string> idle = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (Button button in buttons)
                {
                    List<WindowInfo> candidates = Match(button, windows, pins);
                    List<WindowInfo> named = candidates.FindAll(delegate(WindowInfo window) { return Same(window.Title, button.Title); });
                    HashSet<string> titles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    bool grouped = button.Expand;
                    foreach (WindowInfo candidate in candidates) if (!titles.Add(candidate.Title)) grouped = true;
                    // Group the whole matched app so unique-title buttons cannot partially claim duplicate-title windows.
                    List<WindowInfo> selected = named.Count == 1 && !grouped ? named : candidates;
                    if (candidates.Count > 0)
                    {
                        if (button.Count < 1 || candidates.Count != button.Count)
                            errors.Add("窗口数量不能完整核验：" + button.Name + "（识别 " + candidates.Count + "）");
                        if (selected.Count > 1 && !grouped && named.Count == 0)
                            errors.Add("非分组按钮无法准确定位：" + button.Name);
                        List<WindowInfo> fresh = selected.FindAll(delegate(WindowInfo window) { return !window.Excluded && !covered.Contains(window.Key); });
                        foreach (WindowInfo window in selected) covered.Add(window.Key);
                        if (fresh.Count == 0) continue;
                        if (fresh.Count != selected.FindAll(delegate(WindowInfo window) { return !window.Excluded; }).Count && button.ViewIndex == 0)
                            errors.Add("主任务栏按钮映射重叠：" + button.Name);
                        AddRunning(snapshot, button, fresh);
                    }
                    else if (button.Count == 0 && !button.Expand && button.Invoke && button.AppId.Length > 0 && button.Title.Length > 0)
                    {
                        // On the Win10 native task-list provider an idle pinned button has no
                        // running-window suffix. Invoke the *retained native element*, not a path.
                        if (!idle.Add(button.AppId)) continue;
                        Pin pin = FindPin(button, pins);
                        string key = "pin|" + button.AppId.ToUpperInvariant();
                        Item item = new Item { id = Id(key), title = button.Title, icon = PinIcon(button, pin) };
                        snapshot.items.Add(item);
                        nextTargets[item.id] = new Target { Button = button };
                    }
                    else errors.Add("无法安全映射任务栏按钮：" + button.Name + " [" + button.AppId + "]");
                }
                foreach (WindowInfo window in windows)
                {
                    if (window.Excluded || covered.Contains(window.Key)) continue;
                    // Extra windows (image viewers, dialogs) are expected to appear and vanish
                    // without a taskbar button; mirroring them must not disable app hiding.
                    AddRunning(snapshot, null, new List<WindowInfo> { window });
                }
                foreach (WindowInfo window in windows)
                {
                    if (window.Excluded) continue;
                    try { ValidateWindow(window); }
                    catch { /* A window closing mid-read only affects its own entry until the next refresh. */ }
                }
                // Also detect newly added buttons/monitors, not merely disconnected old elements.
                VerifyButtons();
                snapshot.supported = errors.Count == 0;
                snapshot.error = String.Join("；", errors.ToArray());
                ids = nextIds;
                targets = nextTargets;
            }
            return snapshot;
        }

        private void ReadButtons()
        {
            List<IntPtr> views = TaskbarVisibility.Views();
            views.Sort(delegate(IntPtr left, IntPtr right) {
                bool l = ClassName(GetAncestor(left, 2)) == "Shell_TrayWnd";
                bool r = ClassName(GetAncestor(right, 2)) == "Shell_TrayWnd";
                if (l != r) return l ? -1 : 1;
                return left.ToInt64().CompareTo(right.ToInt64());
            });
            if (automation == null) automation = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E")));
            object condition = automation.CreateTrueCondition();
            try
            {
                for (int v = 0; v < views.Count; v++)
                {
                    IntPtr view = views[v];
                    uint pid;
                    GetWindowThreadProcessId(view, out pid);
                    ProcessInfo shell = ReadProcess(pid);
                    if (shell.Birth == 0 || !Same(Path.GetFileName(shell.Path), "explorer.exe"))
                        throw new InvalidOperationException("无法核验任务栏所属 Explorer 进程");
                    IUIAutomationElement root = null;
                    IUIAutomationElementArray descendants = null;
                    int before = buttons.Count;
                    try
                    {
                        root = automation.ElementFromHandle(view);
                        descendants = root.FindAll(4, condition); // TreeScope_Descendants, including native grouped MenuItems.
                        int length = descendants.Length;
                        if (length > 2048) throw new InvalidOperationException("任务栏 UIA 结构异常");
                        for (int i = 0; i < length; i++)
                        {
                            IUIAutomationElement element = descendants.GetElement(i);
                            try
                            {
                                object control = element.GetCurrentPropertyValue(30003);
                                int type = control is int ? (int)control : 0;
                                if (type != 50000 && type != 50011)
                                {
                                    if ((type != 50020 && type != 50006 && type != 50021 && type != 50026 && type != 50033 && type != 50038) || PropertyBool(element, 30031))
                                        throw new InvalidOperationException("发现不能识别的任务栏控件，已保留系统入口");
                                    continue;
                                }
                                string name = PropertyString(element, 30005);
                                string aid = Identity(PropertyString(element, 30011));
                                Match match = RunningSuffix.Match(name);
                                int count = 0;
                                if (match.Success && !Int32.TryParse(match.Groups[1].Value, out count))
                                    throw new InvalidOperationException("任务栏窗口数量无效");
                                Button button = new Button {
                                    Element = element, View = view, ShellPid = pid, ShellBirth = shell.Birth,
                                    RuntimeId = element.GetRuntimeId(), Name = name, AppId = aid,
                                    Title = match.Success ? name.Substring(0, match.Index).Trim() : name.Trim(),
                                    Count = count, Invoke = PropertyBool(element, 30031), Expand = PropertyBool(element, 30028), ViewIndex = v, Order = i
                                };
                                double[] bounds = element.GetCurrentPropertyValue(30001) as double[];
                                if (bounds != null && bounds.Length == 4)
                                {
                                    button.Left = bounds[0]; button.Top = bounds[1];
                                    button.Width = bounds[2]; button.Height = bounds[3];
                                }
                                if (button.RuntimeId == null || button.RuntimeId.Length == 0 || name.Length == 0)
                                    throw new InvalidOperationException("任务栏按钮缺少稳定的 UIA 标识");
                                buttons.Add(button);
                                element = null;
                            }
                            finally { Release(element); }
                        }
                    }
                    finally { Release(descendants); Release(root); }
                    if (buttons.Count == before) throw new InvalidOperationException("任务栏未返回应用按钮，不能确认镜像完整");
                    Rect rect;
                    List<Button> ordered = buttons.GetRange(before, buttons.Count - before);
                    if (GetWindowRect(view, out rect) && ordered.TrueForAll(delegate(Button b) { return b.Width > 0 && b.Height > 0; }))
                    {
                        bool horizontal = rect.Right - rect.Left >= rect.Bottom - rect.Top;
                        ordered.Sort(delegate(Button a, Button b) {
                            int line = horizontal ? a.Top.CompareTo(b.Top) : a.Left.CompareTo(b.Left);
                            if (line != 0) return line;
                            int position = horizontal ? a.Left.CompareTo(b.Left) : a.Top.CompareTo(b.Top);
                            return position != 0 ? position : a.Order.CompareTo(b.Order);
                        });
                        for (int i = 0; i < ordered.Count; i++) buttons[before + i] = ordered[i];
                    }
                    // Hidden providers can return empty bounds; retain their native child order then.
                }
            }
            finally { Release(condition); }
        }

        private void VerifyButtons()
        {
            List<Button> original = new List<Button>(buttons);
            buttons.Clear();
            try
            {
                ReadButtons();
                if (buttons.Count != original.Count) throw new InvalidOperationException("任务栏按钮数量正在变化，请刷新后重试");
                for (int i = 0; i < buttons.Count; i++)
                {
                    Button current = buttons[i], previous = original[i];
                    if (current.View != previous.View || current.ShellPid != previous.ShellPid || current.ShellBirth != previous.ShellBirth || current.Name != previous.Name || current.AppId != previous.AppId || !EqualRuntime(current.RuntimeId, previous.RuntimeId))
                        throw new InvalidOperationException("任务栏按钮或排列正在变化，请刷新后重试");
                }
            }
            finally
            {
                ClearButtons();
                buttons.AddRange(original);
            }
        }

        private List<WindowInfo> ReadWindows()
        {
            List<WindowInfo> windows = new List<WindowInfo>();
            Dictionary<uint, ProcessInfo> processes = new Dictionary<uint, ProcessInfo>();
            IntPtr foreground = GetForegroundWindow();
            IntPtr activeRoot = GetAncestor(foreground, 3);
            Exception failure = null;
            bool enumerated = EnumWindows(delegate(IntPtr handle, IntPtr unused) {
                try
                {
                    if (!Switchable(handle)) return true;
                    uint pid;
                    GetWindowThreadProcessId(handle, out pid);
                    if (pid == 0) return true;
                    ProcessInfo process;
                    if (!processes.TryGetValue(pid, out process)) processes[pid] = process = ReadProcess(pid);
                    if (ShellSurface(ClassName(handle), process)) return true;
                    WindowInfo window = new WindowInfo {
                        Handle = handle, Process = process, Title = Text(handle), Class = ClassName(handle),
                        AppId = WindowAppId(handle), Excluded = pid == (uint)ownerPid,
                        Active = handle == foreground || handle == activeRoot,
                        Key = handle.ToInt64().ToString("X") + ":" + pid + ":" + process.Birth
                    };
                    if (window.AppId.Length == 0) window.AppId = process.AppId;
                    if (window.Class == "ApplicationFrameWindow")
                    {
                        // Frame HWND/PID remain the activation target; the hosted app supplies identity/icon.
                        EnumChildWindows(handle, delegate(IntPtr child, IntPtr parameter) {
                            if (ClassName(child) != "Windows.UI.Core.CoreWindow") return true;
                            uint childPid;
                            GetWindowThreadProcessId(child, out childPid);
                            if (childPid == pid || childPid == 0) return true;
                            ProcessInfo content;
                            if (!processes.TryGetValue(childPid, out content)) processes[childPid] = content = ReadProcess(childPid);
                            if (window.AppId.Length == 0) window.AppId = content.AppId;
                            window.ContentPath = content.Path;
                            return false;
                        }, IntPtr.Zero);
                    }
                    if (window.Title.Length == 0) window.Title = process.Description.Length > 0 ? process.Description : Path.GetFileNameWithoutExtension(process.Path);
                    windows.Add(window);
                    return true;
                }
                catch (Exception error) { failure = error; return false; }
            }, IntPtr.Zero);
            if (failure != null) throw failure;
            if (!enumerated) throw new InvalidOperationException("无法完整枚举可切换窗口");
            return windows;
        }

        private static List<Pin> ReadPins()
        {
            List<Pin> pins = new List<Pin>();
            string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar");
            if (!Directory.Exists(folder)) return pins;
            foreach (string file in Directory.GetFiles(folder, "*.lnk"))
            {
                object link = null;
                try
                {
                    link = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
                    ((IPersistFile)link).Load(file, 0); // STGM_READ; no Resolve, Save, pin mutation, or Taskband registry access.
                    StringBuilder path = new StringBuilder(32768);
                    ((IShellLinkW)link).GetPath(path, path.Capacity, IntPtr.Zero, 4);
                    pins.Add(new Pin { Link = file, Title = Path.GetFileNameWithoutExtension(file), Path = CanonicalPath(path.ToString()), AppId = ReadAppId(link as IPropertyStore) });
                }
                catch (COMException) { /* Native UIA still supports a PIDL/packaged pin without a filesystem target. */ }
                finally { Release(link); }
            }
            return pins;
        }

        private static bool ShellSurface(string className, ProcessInfo process)
        {
            if (className == "NotifyIconOverflowWindow" || className == "TopLevelWindowForOverflowXamlIsland" ||
                className == "XamlExplorerHostIslandWindow" || className == "MultitaskingViewFrame" || className == "TaskListThumbnailWnd")
                return true;
            string executable = Path.GetFileName(process.Path);
            if (Same(executable, "explorer.exe") && className != "CabinetWClass" && className != "ExploreWClass" &&
                className != "Progman" && className != "WorkerW")
                return true;
            // Shell flyouts (Start, search, tray overflow, touch keyboard) are top-level
            // CoreWindows but never have a taskbar button of their own.
            return className == "Windows.UI.Core.CoreWindow" &&
                (Same(executable, "ShellExperienceHost.exe") || Same(executable, "StartMenuExperienceHost.exe") ||
                 Same(executable, "SearchApp.exe") || Same(executable, "TextInputHost.exe"));
        }

        private static bool StrongMatch(Button button, WindowInfo window)
        {
            string aid = button.AppId;
            if (Same(aid, window.AppId)) return true;
            if (window.AppId.Length > 0) return false; // Never merge explicit identities merely because the exe is shared.
            if (Path.IsPathRooted(aid) && (Same(CanonicalPath(aid), window.Process.Path) || Same(CanonicalPath(aid), window.ContentPath))) return true;
            if (Same(aid, "Microsoft.Windows.Explorer"))
                return Same(Path.GetFileName(window.Process.Path), "explorer.exe") && (window.Class == "CabinetWClass" || window.Class == "ExploreWClass");
            // Some unpackaged apps (notably Chrome) expose the executable basename as their AUMID.
            return aid.Length > 0 && aid.IndexOfAny(new char[] { '\\', '/', '.', '!' }) < 0 && Same(aid, Path.GetFileNameWithoutExtension(window.Process.Path));
        }

        private static Pin FindPin(Button button, List<Pin> pins)
        {
            List<Pin> matches = pins.FindAll(delegate(Pin pin) {
                return Same(button.AppId, pin.AppId) || (Path.IsPathRooted(button.AppId) && Same(CanonicalPath(button.AppId), pin.Path)) || Same(button.Title, pin.Title);
            });
            if (matches.Count == 1) return matches[0];
            matches = pins.FindAll(delegate(Pin pin) { return Same(button.AppId, Path.GetFileNameWithoutExtension(pin.Path)); });
            return matches.Count == 1 ? matches[0] : null;
        }

        private static List<WindowInfo> Match(Button button, List<WindowInfo> windows, List<Pin> pins)
        {
            List<WindowInfo> strong = windows.FindAll(delegate(WindowInfo window) { return StrongMatch(button, window); });
            if (strong.Count > 0) return strong;
            windows = windows.FindAll(delegate(WindowInfo window) { return window.AppId.Length == 0 || Same(button.AppId, window.AppId); });
            Pin pin = FindPin(button, pins);
            if (pin != null && pin.Path.Length > 0)
            {
                List<WindowInfo> byPin = windows.FindAll(delegate(WindowInfo window) { return Same(pin.Path, window.Process.Path) || Same(pin.Path, window.ContentPath); });
                if (byPin.Count > 0) return byPin;
            }
            // Fallback evidence must uniquely identify an app, never use the UIA Explorer PID.
            List<WindowInfo> named = windows.FindAll(delegate(WindowInfo window) {
                return Same(button.Title, window.Title) || Same(button.Title, window.Process.Description);
            });
            HashSet<string> identities = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (WindowInfo window in named)
                identities.Add(window.AppId.Length > 0 ? window.AppId : (window.Process.Path.Length > 0 ? window.Process.Path : "pid:" + window.Process.Pid));
            if (identities.Count != 1) return new List<WindowInfo>();
            WindowInfo first = named[0];
            return windows.FindAll(delegate(WindowInfo window) {
                if (first.AppId.Length > 0) return Same(first.AppId, window.AppId);
                return first.Process.Path.Length > 0 ? Same(first.Process.Path, window.Process.Path) : first.Process.Pid == window.Process.Pid;
            });
        }

        private void AddRunning(Snapshot snapshot, Button button, List<WindowInfo> windows)
        {
            bool grouped = windows.Count > 1 || (button != null && button.Expand);
            string identity = button == null ? "unmatched" : button.AppId;
            string key = grouped ? "group|" + identity.ToUpperInvariant() : "single|" + windows[0].Key;
            // A group signature also prevents a recycled group ID from switching an unrelated process.
            if (grouped)
            {
                windows.Sort(delegate(WindowInfo left, WindowInfo right) { return StringComparer.Ordinal.Compare(left.Key, right.Key); });
                List<string> members = windows.ConvertAll<string>(delegate(WindowInfo window) { return window.Key; });
                members.Sort(StringComparer.Ordinal);
                key += "|" + String.Join(",", members.ToArray());
            }
            Item item = new Item {
                id = Id(key), title = button == null ? windows[0].Title : button.Title,
                icon = WindowIcon(windows[0]), running = true
            };
            foreach (WindowInfo window in windows)
            {
                string id = Id("window|" + window.Key);
                item.windows.Add(new WindowItem { id = id, title = window.Title, hwnd = window.Handle.ToInt64() });
                item.active |= window.Active;
                nextTargets[id] = new Target { Window = window };
            }
            nextTargets[item.id] = new Target { Window = windows[0] };
            snapshot.items.Add(item);
        }

        private string FileIcon(string path)
        {
            if (String.IsNullOrEmpty(path)) return "";
            string key = "file|" + path + "|" + File.GetLastWriteTimeUtc(path).Ticks;
            string value;
            if (iconCache.TryGetValue(key, out value)) return value;
            try
            {
                value = DesktopBridge.FileIcon(path);
                if (value.Length > 0) iconCache[key] = value = "data:image/png;base64," + value;
                return value;
            }
            catch (Exception error)
            {
                if (!(error is IOException || error is ArgumentException || error is ExternalException || error is UnauthorizedAccessException)) throw;
                return "";
            }
        }

        private string WindowIcon(WindowInfo window)
        {
            IntPtr borrowed = IntPtr.Zero;
            foreach (int type in new int[] { 1, 2, 0 })
            {
                IntPtr result;
                if (SendMessageTimeout(window.Handle, 0x7F, new IntPtr(type), IntPtr.Zero, 0x2 | 0x20, 80, out result) != IntPtr.Zero && result != IntPtr.Zero)
                { borrowed = result; break; }
            }
            if (borrowed == IntPtr.Zero) borrowed = IntPtr.Size == 8 ? GetClassLongPtr64(window.Handle, -14) : new IntPtr(unchecked((int)GetClassLong32(window.Handle, -14)));
            if (borrowed == IntPtr.Zero) borrowed = IntPtr.Size == 8 ? GetClassLongPtr64(window.Handle, -34) : new IntPtr(unchecked((int)GetClassLong32(window.Handle, -34)));
            if (borrowed != IntPtr.Zero)
            {
                string key = "window|" + window.Key + "|" + borrowed.ToInt64();
                string value;
                if (iconCache.TryGetValue(key, out value)) return value;
                IntPtr owned = CopyIcon(borrowed);
                if (owned != IntPtr.Zero)
                {
                    try
                    {
                        using (Icon icon = Icon.FromHandle(owned))
                        using (Bitmap bitmap = icon.ToBitmap())
                            return iconCache[key] = BitmapData(bitmap);
                    }
                    catch (ArgumentException) { }
                    catch (ExternalException) { }
                    finally { DestroyIcon(owned); } // Never destroy WM_GETICON/class-owned handles.
                }
            }
            string file = FileIcon(window.ContentPath.Length > 0 ? window.ContentPath : window.Process.Path);
            return file.Length > 0 ? file : AppIcon(window.AppId);
        }

        private static string BitmapData(Bitmap bitmap)
        {
            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
            }
        }

        private string PinIcon(Button button, Pin pin)
        {
            string icon = pin == null ? "" : FileIcon(pin.Link);
            return icon.Length > 0 ? icon : AppIcon(button.AppId);
        }

        private string AppIcon(string appId)
        {
            if (appId.Length == 0) return "";
            string key = "app|" + appId;
            string icon;
            if (iconCache.TryGetValue(key, out icon)) return icon;
            IShellItemImageFactory factory = null;
            IntPtr bitmap = IntPtr.Zero;
            try
            {
                // Read a known-folder shell item's icon, including packaged apps. This is NOT
                // ShellExecute/a shell command, and it cannot start the application.
                Guid apps = new Guid("1E87508D-89C2-42F0-8A7E-645A0F50CA58");
                Guid iid = typeof(IShellItemImageFactory).GUID;
                if (SHCreateItemInKnownFolder(ref apps, 0, appId, ref iid, out factory) < 0) return "";
                factory.GetImage(new ImageSize { Width = 32, Height = 32 }, 4 | 1, out bitmap);
                if (bitmap == IntPtr.Zero) return "";
                using (Bitmap image = Image.FromHbitmap(bitmap)) icon = BitmapData(image);
                iconCache[key] = icon;
                return icon;
            }
            catch (COMException) { return ""; }
            catch (ArgumentException) { return ""; }
            finally { if (bitmap != IntPtr.Zero) DeleteObject(bitmap); Release(factory); }
        }

        private static bool EqualRuntime(int[] left, int[] right)
        {
            if (left == null || right == null || left.Length != right.Length) return false;
            for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
            return true;
        }

        private static void ValidateButton(Button button, bool forInvoke)
        {
            uint pid;
            GetWindowThreadProcessId(button.View, out pid);
            if (!IsWindow(button.View) || pid != button.ShellPid || ClassName(button.View) != "MSTaskListWClass" || ReadBirth(pid) != button.ShellBirth)
                throw new InvalidOperationException("Explorer 或任务栏已重启，请刷新后重试");
            if (!EqualRuntime(button.RuntimeId, button.Element.GetRuntimeId()) || !Same(button.AppId, Identity(PropertyString(button.Element, 30011))) || button.Name != PropertyString(button.Element, 30005))
                throw new InvalidOperationException("任务栏按钮已变化，请刷新后重试");
            if (forInvoke && (!PropertyBool(button.Element, 30010) || !PropertyBool(button.Element, 30031)))
                throw new InvalidOperationException("该任务栏入口当前不能启动");
        }

        private static long ReadBirth(uint pid)
        {
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return 0;
            try
            {
                long created, exited, kernel, user;
                return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : 0;
            }
            finally { CloseHandle(process); }
        }

        private static void InvokeButton(Button button)
        {
            ValidateButton(button, true);
            object pattern = button.Element.GetCurrentPattern(10000);
            try
            {
                IUIAutomationInvokePattern invoke = pattern as IUIAutomationInvokePattern;
                if (invoke == null) throw new InvalidOperationException("原生任务栏入口没有 Invoke 功能");
                invoke.Invoke();
            }
            finally { Release(pattern); }
        }

        private void ValidateWindow(WindowInfo window)
        {
            uint pid;
            GetWindowThreadProcessId(window.Handle, out pid);
            if (!IsWindow(window.Handle) || pid != window.Process.Pid || pid == (uint)ownerPid || window.Process.Birth == 0 || ReadBirth(pid) != window.Process.Birth || ClassName(window.Handle) != window.Class || !Switchable(window.Handle))
                throw new InvalidOperationException("目标窗口已关闭或发生变化，请刷新后重试");
        }

        private static bool ForegroundIs(IntPtr window)
        {
            IntPtr foreground = GetForegroundWindow();
            return foreground == window || GetAncestor(foreground, 3) == window;
        }

        private void ActivateWindow(WindowInfo window)
        {
            ValidateWindow(window);
            bool maximized = RestoresMaximized(window.Handle);
            if (IsIconic(window.Handle) && !ShowWindowAsync(window.Handle, maximized ? 3 : 9))
                throw new InvalidOperationException("无法还原最小化窗口");
            // ShowWindowAsync returns before the restore has happened, and the shell can be
            // between menus or virtual-desktop transitions. Try the normal foreground path
            // briefly, then let the shell's own switch force activation instead of leaving
            // the user waiting through a long retry window.
            if (FocusWindow(window, 250, maximized)) { KeepMaximized(window.Handle, maximized); return; }
            SwitchToThisWindow(window.Handle, true);
            if (FocusWindow(window, 500, maximized)) { KeepMaximized(window.Handle, maximized); return; }
            string name = window.Title.Length > 32 ? window.Title.Substring(0, 32) + "…" : window.Title;
            throw new InvalidOperationException("Windows 未允许切换到“" + name + "”，请稍后重试");
        }

        // A window minimized while maximized must come back maximized. SW_RESTORE alone
        // restores the pre-maximize bounds on some shell configurations, which looks like
        // the window shrank after switching.
        private static bool RestoresMaximized(IntPtr window)
        {
            WindowPlacement placement = new WindowPlacement();
            placement.Length = Marshal.SizeOf(typeof(WindowPlacement));
            return GetWindowPlacement(window, ref placement) && (placement.ShowCmd == 3 || (placement.Flags & 2) != 0);
        }

        private static void KeepMaximized(IntPtr window, bool maximized)
        {
            if (maximized) ShowWindowAsync(window, 3);
        }

        private bool FocusWindow(WindowInfo window, int timeout, bool maximized)
        {
            Stopwatch watch = Stopwatch.StartNew();
            while (true)
            {
                ValidateWindow(window);
                if (IsIconic(window.Handle)) ShowWindowAsync(window.Handle, maximized ? 3 : 9);
                if (SetForegroundWindow(window.Handle) || ForegroundIs(window.Handle)) return true;
                if (FocusThreads(window)) return true;
                if (watch.ElapsedMilliseconds >= timeout) return false;
                Thread.Sleep(100);
            }
        }

        private bool FocusThreads(WindowInfo window)
        {
            uint ignored;
            uint current = GetCurrentThreadId();
            uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
            uint target = GetWindowThreadProcessId(window.Handle, out ignored);
            bool foregroundAttached = false, targetAttached = false;
            try
            {
                if (foreground != 0 && foreground != current) foregroundAttached = AttachThreadInput(current, foreground, true);
                if (target != 0 && target != current && target != foreground) targetAttached = AttachThreadInput(current, target, true);
                return SetForegroundWindow(window.Handle) || ForegroundIs(window.Handle);
            }
            finally
            {
                if (targetAttached) AttachThreadInput(current, target, false);
                if (foregroundAttached) AttachThreadInput(current, foreground, false);
            }
        }
    }
}

"""Run serially with QX closed; uses normal application data without resetting it."""

import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import os
import json
from pathlib import Path
import socket
import stat
import subprocess
import sys

from desktop_guard import Desktop, Taskbar, WINDOW_CALLBACK, stop_owned_process, wait_until


ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
EXECUTABLE = ROOT / 'release' / f'QX桌面-{VERSION}-便携版.exe'
NATIVE_NAME = 'qxdesktopbridge.exe'
APPLICATION_NAMES = {EXECUTABLE.name.casefold(), 'qx桌面.exe', '拾光桌面.exe'}
CLEANUP_NAMES = APPLICATION_NAMES | {NATIVE_NAME, 'chrome_crashpad_handler.exe', 'crashpad_handler.exe'}
SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_TERMINATE = 0x0001


class ProcessEntry(ctypes.Structure):
    _fields_ = [
        ('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
        ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
        ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
        ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
        ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260),
    ]


@dataclass
class OwnedProcess:
    handle: int
    name: str
    created: int


class ApplicationProcesses:
    """Retained handles and creation times prevent terminating reused PIDs."""

    def __init__(self, desktop):
        self.kernel32 = desktop.kernel32
        self.user32 = desktop.user32
        self.owned = {}
        for name, arguments, result in (
            ('CreateToolhelp32Snapshot', [wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            ('Process32FirstW', [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
            ('Process32NextW', [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
            ('OpenProcess', [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            ('WaitForSingleObject', [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            ('GetProcessTimes', [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
            ('TerminateProcess', [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        ):
            function = getattr(self.kernel32, name)
            function.argtypes = arguments
            function.restype = result
        for name, arguments, result in (
            ('GetWindowThreadProcessId', [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
            ('GetWindowTextW', [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            ('IsWindow', [wintypes.HWND], wintypes.BOOL),
            ('IsIconic', [wintypes.HWND], wintypes.BOOL),
            ('ShowWindow', [wintypes.HWND, ctypes.c_int], wintypes.BOOL),
            ('SetForegroundWindow', [wintypes.HWND], wintypes.BOOL),
            ('PostMessageW', [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM], wintypes.BOOL),
        ):
            function = getattr(self.user32, name)
            function.argtypes = arguments
            function.restype = result

    def snapshot(self):
        handle = self.kernel32.CreateToolhelp32Snapshot(2, 0)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = ProcessEntry()
            entry.dwSize = ctypes.sizeof(entry)
            rows = []
            success = self.kernel32.Process32FirstW(handle, ctypes.byref(entry))
            while success:
                rows.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
                success = self.kernel32.Process32NextW(handle, ctypes.byref(entry))
            if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                raise ctypes.WinError(ctypes.get_last_error())
            return rows
        finally:
            self.kernel32.CloseHandle(handle)

    def times(self, handle):
        values = [wintypes.FILETIME() for _ in range(4)]
        if not self.kernel32.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
            raise ctypes.WinError(ctypes.get_last_error())
        return tuple((value.dwHighDateTime << 32) | value.dwLowDateTime for value in values[:2])

    def open_process(self, pid):
        return self.kernel32.OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, False, pid)

    def add_root(self, process):
        handle = self.open_process(process.pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            self.owned[process.pid] = OwnedProcess(handle, EXECUTABLE.name, self.times(handle)[0])
        except BaseException:
            self.kernel32.CloseHandle(handle)
            raise

    def refresh(self):
        rows = self.snapshot()
        while True:
            added = False
            for pid, parent_pid, name in rows:
                if pid in self.owned or parent_pid not in self.owned:
                    continue
                parent = self.owned[parent_pid]
                handle = self.open_process(pid)
                if not handle:
                    error = ctypes.get_last_error()
                    if error == 87:  # Child already exited between snapshot and OpenProcess.
                        continue
                    raise ctypes.WinError(error)
                try:
                    created, _ = self.times(handle)
                    _, parent_exited = self.times(parent.handle)
                    if created < parent.created or (parent_exited and created > parent_exited):
                        continue
                    self.owned[pid] = OwnedProcess(handle, name, created)
                    handle = None
                    added = True
                finally:
                    if handle:
                        self.kernel32.CloseHandle(handle)
            if not added:
                return

    def alive(self, process):
        result = self.kernel32.WaitForSingleObject(process.handle, 0)
        if result == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        return result == 258  # WAIT_TIMEOUT; a signaled handle denotes exit.

    def live_pids(self):
        return {pid for pid, process in self.owned.items() if self.alive(process)}

    def all_exited(self):
        self.refresh()
        return not self.live_pids()

    def windows(self, pids, prefixes=('QX桌面',)):
        found = []
        @WINDOW_CALLBACK
        def visit(hwnd, _):
            pid = wintypes.DWORD()
            self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            title = ctypes.create_unicode_buffer(512)
            self.user32.GetWindowTextW(hwnd, title, len(title))
            if pid.value in pids and self.user32.IsWindowVisible(hwnd) and title.value.startswith(prefixes):
                found.append((hwnd, pid.value, title.value))
            return True
        if not self.user32.EnumWindows(visit, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        return found

    def assert_no_existing_app(self):
        rows = self.snapshot()
        names = {'qx桌面.exe', '拾光桌面.exe', NATIVE_NAME, EXECUTABLE.name.casefold(),
                 '拾光桌面-1.0.0-便携版.exe'}
        existing = [(pid, name) for pid, _, name in rows if name.casefold() in names]
        existing_windows = self.windows({pid for pid, _, _ in rows}, ('QX桌面', '拾光桌面'))
        if existing or existing_windows:
            raise RuntimeError(f'Close existing QX/legacy app first; no processes were stopped: {existing or existing_windows}')

    def find_window(self):
        self.refresh()
        pids = {pid for pid in self.live_pids() if self.owned[pid].name.casefold() in APPLICATION_NAMES}
        windows = self.windows(pids)
        return windows[0] if windows else None

    def owns_window(self, hwnd):
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return (bool(self.user32.IsWindow(hwnd)) and pid.value in self.live_pids()
                and self.owned[pid.value].name.casefold() in APPLICATION_NAMES)

    def close_window(self, hwnd):
        if self.owns_window(hwnd):
            self.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE, only our live window.

    def native_pids(self):
        self.refresh()
        return {pid for pid, process in self.owned.items()
                if process.name.casefold() == NATIVE_NAME and self.alive(process)}

    def terminate_owned(self, include_native=False):
        self.refresh()
        for pid, process in list(self.owned.items()):
            if not include_native and process.name.casefold() == NATIVE_NAME:
                continue
            if self.alive(process):
                # Even if the app unexpectedly launched Explorer, Qoder or a user
                # program, ancestry is not permission to terminate that program.
                if process.name.casefold() not in CLEANUP_NAMES:
                    print(f'WARN leaving non-application descendant untouched: pid={pid} ({process.name})', file=sys.stderr)
                    continue
                if not self.kernel32.TerminateProcess(process.handle, 1) and self.alive(process):
                    raise ctypes.WinError(ctypes.get_last_error())
                print(f'WARN cleaned up test descendant pid={pid} ({process.name})', file=sys.stderr)

    def cleanup(self, window):
        self.refresh()
        window = window if window and self.owns_window(window[0]) else self.find_window()
        if window:
            self.close_window(window[0])
        try:
            wait_until(self.all_exited, 15, 'Application cleanup timed out')
            return
        except TimeoutError:
            # Kill only handles proved to belong to this launch. Let detached
            # guards observe their parents dying and restore before any fallback.
            self.terminate_owned()
        try:
            wait_until(self.all_exited, 10, 'Native bridge/guard cleanup timed out')
        except TimeoutError:
            self.terminate_owned(include_native=True)
            wait_until(self.all_exited, 5, 'Test-owned processes could not be reaped')

    def close_handles(self):
        for process in self.owned.values():
            self.kernel32.CloseHandle(process.handle)
        self.owned.clear()


def desktop_inventory():
    # CSIDL_DESKTOPDIRECTORY follows the user's relocated/OneDrive desktop.
    shell32 = ctypes.WinDLL('shell32', use_last_error=True)
    shell32.SHGetFolderPathW.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR]
    shell32.SHGetFolderPathW.restype = ctypes.c_long
    buffer = ctypes.create_unicode_buffer(260)
    result = shell32.SHGetFolderPathW(None, 0x10, None, 0, buffer)
    if result != 0:
        raise RuntimeError(f'Could not resolve the Windows desktop: HRESULT={result:#x}')
    directories = {Path(buffer.value)}
    if os.environ.get('PUBLIC'):
        directories.add(Path(os.environ['PUBLIC']) / 'Desktop')
    snapshot = {}
    importable = set()
    for directory in directories:
        if not directory.exists():
            continue
        for path in directory.iterdir():
            info = path.lstat()
            snapshot[path] = (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))
            if path.name.casefold() != 'desktop.ini' and not path.name.startswith('.'):
                if path.is_file() or path.is_dir():
                    importable.add(os.path.normcase(os.path.abspath(path)))
    return snapshot, importable


def assert_desktop_files_preserved(snapshot):
    changed = []
    for path, identity in snapshot.items():
        try:
            info = path.lstat()
            if (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)) != identity:
                changed.append(str(path))
        except FileNotFoundError:
            changed.append(str(path))
    assert not changed, f'Desktop entries were moved/deleted/replaced (test does not repair user files): {changed}'


def selected_data_directory(settings_directory):
    def read_json(path):
        def reject_constant(value):
            raise ValueError(f'Invalid JSON constant {value} in {path}; refusing to launch or reset data')
        # Python accepts NaN/Infinity by default, unlike the app's JSON.parse.
        return json.loads(path.read_text(encoding='utf-8'), parse_constant=reject_constant)

    location_file = settings_directory / 'data-location.json'
    directory = settings_directory
    try:
        location_file.lstat()  # A dangling link is not an absent configuration.
    except FileNotFoundError:
        pass
    else:
        location = read_json(location_file)
        if (not isinstance(location, dict) or not isinstance(location.get('directory'), str)
                or not Path(location['directory']).is_absolute() or '\x00' in location['directory']):
            raise ValueError(f'Invalid absolute directory in {location_file}; refusing to launch or reset data')
        # Match path.resolve in the app, without resolving directory junctions.
        directory = Path(os.path.abspath(location['directory']))

    workspace = directory / 'workspace.json'
    if not workspace.is_file():
        raise FileNotFoundError(f'Existing workspace required: {workspace}; refusing to create or reset data')
    value = read_json(workspace)
    # Mirror core.validState: even parseable invalid data would otherwise trigger
    # Store recovery and overwrite the user's workspace during this real smoke.
    categories = value.get('categories') if isinstance(value, dict) else None
    items = value.get('items') if isinstance(value, dict) else None
    notes = value.get('notes') if isinstance(value, dict) else None
    valid_categories = (isinstance(categories, list) and bool(categories)
                        and all(isinstance(c, dict) and isinstance(c.get('id'), str)
                                and isinstance(c.get('name'), str) for c in categories))
    category_ids = {c['id'] for c in categories} if valid_categories else set()
    valid = (isinstance(value, dict) and type(value.get('version')) in (int, float) and value['version'] == 1
             and valid_categories and {'documents', 'apps', 'images', 'others'} <= category_ids
             and isinstance(items, list)
             and all(isinstance(i, dict) and all(isinstance(i.get(k), str) for k in ('id', 'name', 'path'))
                     and isinstance(i.get('categoryId'), str) and i['categoryId'] in category_ids for i in items)
             and isinstance(notes, list) and bool(notes)
             and all(isinstance(n, dict) and all(isinstance(n.get(k), str) for k in ('id', 'title', 'content'))
                     for n in notes)
             and isinstance(value.get('browserUrl'), str))
    if not valid:
        raise ValueError(f'Invalid workspace: {workspace}; refusing to launch or reset data')
    return directory


def wait_for_bootstrap(page, taskbar_hidden=None, desktop_active=False):
    def read():
        result = page.evaluate("() => window.desktop.invoke('bootstrap')")
        assert result['ok'], result.get('error')
        value = result['value']
        if not value['dock']['revision'] or (desktop_active and not value['desktopState']['active']):
            return None
        if taskbar_hidden is not None and value['taskbarState']['hidden'] != taskbar_hidden:
            return None
        return value
    bootstrap = wait_until(read, 20, 'Dock bootstrap did not reach the expected state')
    dock, state = bootstrap['dock'], bootstrap['taskbarState']
    assert type(dock['supported']) is bool and isinstance(dock['error'], str), dock
    assert isinstance(dock['items'], list) and type(dock['revision']) is int and dock['revision'] > 0, dock
    assert type(state['hidden']) is bool and isinstance(state['error'], str), state
    ids = []
    for item in dock['items']:
        assert all(isinstance(item[key], str) for key in ('id', 'title', 'icon')), item
        assert item['id'] and type(item['running']) is bool and type(item['active']) is bool, item
        assert isinstance(item['windows'], list), item
        assert all(isinstance(entry, dict) and isinstance(entry.get('id'), str) and entry['id']
                   and isinstance(entry.get('title'), str) for entry in item['windows']), item
        ids.append(item['id'])
    assert len(ids) == len(set(ids)), f'Duplicate Dock IDs: {ids}'
    return bootstrap


def wait_taskbar_snapshot(taskbar, before, target_visible=None):
    difference = ''

    def matches():
        nonlocal difference
        try:
            taskbar.assert_snapshot(before, target_visible=target_visible)
            return True
        except AssertionError as error:
            difference = str(error)
            return False

    try:
        wait_until(matches, 10, 'Taskbar did not reach the expected strict snapshot')
    except TimeoutError as error:
        # Do not filter children or rebaseline around QX's changing task button.
        raise AssertionError(f'Strict taskbar snapshot failed (no exclusions or relaxed geometry): {difference}') from error


def check_dock(page, taskbar, initial_taskbar, unsupported_reason):
    bootstrap = wait_for_bootstrap(page)
    dock, state = bootstrap['dock'], bootstrap['taskbarState']
    if not dock['supported'] or not dock['items']:
        if not dock['supported']:
            assert dock['error'].strip(), 'Unsupported Dock backend must provide a reason'
            reason = dock['error']
        else:
            assert not dock['error'], dock['error']
            reason = 'Dock returned no items; no user programs were launched to manufacture samples'
        print(f'SKIP Dock support/hide checks: {reason}; taskbar probe: {unsupported_reason or "compatible targets found"}')
        assert not state['hidden'], f'Unavailable/empty Dock must not hide taskbar targets: {state}'
        taskbar.assert_snapshot(initial_taskbar)
        return False

    assert not unsupported_reason, f'Backend claims Dock support but strict taskbar verification is unavailable: {unsupported_reason}'
    assert not dock['error'], dock['error']
    bootstrap = wait_for_bootstrap(page, taskbar_hidden=True)
    assert bootstrap['dock']['supported'] and bootstrap['dock']['items'], 'Dock became unavailable before takeover'
    assert not bootstrap['dock']['error'] and not bootstrap['taskbarState']['error'], bootstrap['taskbarState']
    wait_taskbar_snapshot(taskbar, initial_taskbar, target_visible=False)

    # Never acknowledge readiness on behalf of the actual renderer.
    def read_rendered():
        return page.evaluate("""async () => {
        const result = await window.desktop.invoke('bootstrap');
        if (!result.ok) throw new Error(result.error);
        const {dock, taskbarState} = result.value;
        if (!dock.supported || dock.error || taskbarState.error)
            throw new Error(dock.error || taskbarState.error || 'Dock support was lost');
        if (!taskbarState.hidden || !dock.items.length) return false;
        const buttons = [...document.querySelectorAll('#app-dock .dock-button')];
        if (buttons.length !== dock.items.length) return false;
        const matches = await Promise.all(buttons.map(async (button, index) => {
            const item = dock.items[index];
            const image = button.querySelector('img');
            if (button.tagName !== 'BUTTON' || button.dataset.dock !== item.id ||
                button.getAttribute('aria-label') !== item.title ||
                button.classList.contains('running') !== item.running ||
                button.classList.contains('active') !== item.active ||
                !item.icon || !image || image.getAttribute('src') !== item.icon) return false;
            try { await image.decode(); } catch { return false; }
            return button.isConnected && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        }));
        return matches.every(Boolean) ? {revision: dock.revision, ids: dock.items.map(item => item.id)} : false;
    }""")
    rendered = wait_until(read_rendered, 20, 'Dock DOM did not match the current native snapshot')
    assert len(rendered['ids']) == len(set(rendered['ids'])), rendered
    taskbar.assert_snapshot(initial_taskbar, target_visible=False)
    print(f'PASS Dock revision={rendered["revision"]}: {len(rendered["ids"])} matching buttons and decoded images; only MSTaskListWClass hidden')
    return True


def check_interface(page, expected_imports, data_directory, expect):
    page.set_default_timeout(15000)
    page.locator('.category-card').first.wait_for()
    page.locator('#note-content').wait_for()
    expect(page.locator('.calendar-day')).to_have_count(42)
    expect(page.locator('.local-badge')).to_be_visible()
    expect(page.locator('.local-badge')).to_contain_text('桌面已接管', timeout=15000)
    expect(page.locator('#focus-web')).to_have_count(0)
    expect(page.locator('#focus-note')).to_have_count(0)

    # Manual import would mask a broken automatic import and modify normal user data.
    bootstrap = wait_for_bootstrap(page, desktop_active=True)
    assert Path(bootstrap['dataDirectory']).is_absolute(), bootstrap['dataDirectory']
    actual_directory = os.path.normcase(os.path.abspath(bootstrap['dataDirectory']))
    expected_directory = os.path.normcase(os.path.abspath(data_directory))
    assert actual_directory == expected_directory, f'Smoke must use the selected data directory: expected={data_directory}, actual={bootstrap["dataDirectory"]}'
    assert not bootstrap.get('recovered'), 'Smoke must not recover/reset the existing user workspace'
    assert bootstrap['version'] == VERSION, f'Unexpected packaged version: {bootstrap["version"]}'

    # Read the settings only: neither change-directory nor open-directory is safe
    # here (the latter would launch Explorer and change the real Dock inventory).
    page.locator('#help-button').click()
    expect(page.locator('#settings')).to_be_visible()
    expect(page.locator('#data-directory')).to_have_text(bootstrap['dataDirectory'])
    shown_directory = page.locator('#data-directory').inner_text()
    assert Path(shown_directory).is_absolute() and os.path.normcase(os.path.abspath(shown_directory)) == expected_directory
    page.locator('#settings-close').click()
    expect(page.locator('#settings')).to_be_hidden()
    assert not page.locator('#settings').evaluate('node => node.open'), 'Settings dialog did not close'
    print(f'PASS bootstrap and closable settings show the selected data directory: {data_directory}')

    items = bootstrap['state']['items']
    actual_paths = {os.path.normcase(os.path.abspath(item['path'])) for item in items}
    missing = expected_imports - actual_paths
    assert not missing, f'Existing desktop files were not imported automatically: {sorted(missing)}'
    expect(page.locator('#search')).to_have_value('')
    expect(page.locator('.file-item')).to_have_count(len(items))
    labels = page.locator('.file-item').evaluate_all("""nodes => nodes.map(node => ({
        id: node.dataset.item, text: node.querySelector(':scope > span')?.textContent,
        label: node.getAttribute('aria-label')
    }))""")
    labels = {entry['id']: entry for entry in labels}
    shortcuts = 0
    for item in items:
        if item['name'].lower().endswith('.lnk'):
            label = labels[item['id']]
            expected = item['name'] if item['isDirectory'] else item['name'][:-4]
            assert label['text'] == expected and label['label'] == expected, f'Incorrect visible shortcut/directory label: {label!r}'
            if not item['isDirectory']:
                shortcuts += 1
    icon_ids = [item['id'] for item in items if not item['isDirectory']
                and item['name'].lower().endswith('.lnk') and Path(item['path']).is_file()]
    if icon_ids:
        page.wait_for_function("""ids => ids.every(id => {
            const node = [...document.querySelectorAll('.file-item')].find(node => node.dataset.item === id);
            const image = node?.querySelector('img');
            return image?.complete && image.naturalWidth > 0;
        })""", arg=icon_ids, timeout=20000)
    print(f'PASS automatic import: {len(expected_imports)} existing paths; .lnk labels checked: {shortcuts}; shortcut icons: {len(icon_ids)}')
    if not shortcuts:
        print('NOTE no existing shortcut samples; none were created in user data or on the desktop')

    layout = page.evaluate("""() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect();
            return {x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom}; };
        return {files:box('.organizer'), web:box('.browser-panel'), calendar:box('.calendar-panel'),
            notes:box('.notes-panel'), dashboard:box('.dashboard'), workspace:box('.workspace')};
    }""")
    files, web, calendar, notes = (layout[key] for key in ('files', 'web', 'calendar', 'notes'))
    assert abs(files['height'] - layout['dashboard']['height']) < 2, layout
    assert web['x'] > files['right'] and web['width'] > files['width'], layout
    assert web['y'] >= calendar['bottom'] and web['bottom'] <= layout['workspace']['bottom'] + 1, layout
    assert abs(calendar['height'] - notes['height']) < 2 and abs(calendar['width'] - notes['width']) < 2, layout
    current = wait_for_bootstrap(page)
    if not current['dock']['supported'] and page.locator('#toast.error').is_visible():
        # An explicitly unsupported backend may report that reason in the UI;
        # unrelated storage/desktop/renderer errors must still fail this smoke.
        message = page.locator('#toast.error').inner_text()
        assert message and message in (current['dock']['error'], current['taskbarState']['error']), message
        print(f'NOTE reported unsupported taskbar/Dock reason: {message}')
    else:
        expect(page.locator('#toast.error')).to_be_hidden()
    page.screenshot(path=str(ROOT / 'assets' / 'portable-exe.png'))
    print('PASS takeover/auto-import UI and full-height file area with right-side widgets')
    return bootstrap


def main():
    from playwright.sync_api import expect, sync_playwright

    if not EXECUTABLE.is_file():
        raise FileNotFoundError(f'Build the {VERSION} portable release before running: {EXECUTABLE}')
    desktop = Desktop()
    desktop.user32.SetProcessDPIAware()
    desktop.assert_unmanaged()  # Fail BEFORE any launch or desktop restoration.
    processes = ApplicationProcesses(desktop)
    processes.assert_no_existing_app()
    initial_visible = desktop.visible()
    snapshot, expected_imports = desktop_inventory()
    settings_directory = Path(os.path.abspath(Path(os.environ['APPDATA']) / 'DesktopHarbor'))
    data_directory = selected_data_directory(settings_directory)
    print(f'Using selected application data without reset/deletion: {data_directory}')
    taskbar = Taskbar(desktop)
    initial_taskbar = taskbar.snapshot()  # Own WS_VISIBLE, not ancestor visibility.
    unsupported_reason = taskbar.unsupported_reason(initial_taskbar)
    print(f'Recorded strict pre-launch taskbar snapshot: {len(initial_taskbar)} HWNDs')
    environment = os.environ.copy()
    for name in ('HARBOR_TEST_MODE', 'HARBOR_DATA_DIR', 'ELECTRON_RUN_AS_NODE'):
        environment.pop(name, None)
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        debug_port = reservation.getsockname()[1]
    process = None
    window = None
    try:
        desktop.assert_unmanaged()
        processes.assert_no_existing_app()
        if not unsupported_reason:
            taskbar.own_initial_targets(initial_taskbar)
        else:
            taskbar.assert_snapshot(initial_taskbar)
            print(f'NOTE taskbar layout cannot be safely owned: {unsupported_reason}')
        process = subprocess.Popen(
            [str(EXECUTABLE), f'--remote-debugging-port={debug_port}', '--remote-debugging-address=127.0.0.1'],
            cwd=str(EXECUTABLE.parent), env=environment, stdin=subprocess.DEVNULL,
        )
        processes.add_root(process)
        window = wait_until(processes.find_window, 90, '便携 EXE 未能显示 QX桌面 主窗口')
        hwnd, pid, title = window
        assert title.startswith('QX桌面'), f'Unexpected main window: {title}'
        if desktop.user32.IsIconic(hwnd):
            desktop.user32.ShowWindow(hwnd, 9)
        desktop.user32.SetForegroundWindow(hwnd)
        desktop.wait_visible(False, 15)
        print(f'PASS portable executable launched with desktop hidden: pid={pid}, title={title}')
        with sync_playwright() as playwright:
            connection = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}', timeout=15000)
            page = wait_until(
                lambda: next((page for context in connection.contexts for page in context.pages
                              if page.url.startswith('file:') and 'index.html' in page.url), None),
                15, 'Packaged application page was not exposed over CDP',
            )
            page_errors = []
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            bootstrap = check_interface(page, expected_imports, data_directory, expect)
            assert bootstrap['desktopState']['originalVisible'] == initial_visible, 'Guard did not remember the pre-launch visibility'
            assert not desktop.visible(), 'Desktop must remain hidden while the application runs'
            assert desktop.guard_exists(), 'Packaged application has no active guard mutex'
            native_pids = wait_until(processes.native_pids, 10, 'Native bridge/guard missing from application descendants')
            dock_supported = check_dock(page, taskbar, initial_taskbar, unsupported_reason)

            # Exercise only this launch's QX window; never click a real app's
            # Dock entry or use an unowned HWND for activation/minimization.
            assert processes.owns_window(hwnd), 'Lost ownership of QX before minimize'
            desktop.user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
            wait_until(lambda: processes.owns_window(hwnd) and desktop.user32.IsIconic(hwnd),
                       10, 'Test-owned QX window did not minimize')
            minimized = wait_for_bootstrap(page, taskbar_hidden=False)
            assert not minimized['taskbarState']['error'] or not dock_supported, minimized['taskbarState']
            wait_taskbar_snapshot(taskbar, initial_taskbar)
            print('PASS minimizing owned QX preserved/restored the original taskbar snapshot')

            assert processes.owns_window(hwnd), 'Lost ownership of QX before restore'
            desktop.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            desktop.user32.SetForegroundWindow(hwnd)
            wait_until(lambda: processes.owns_window(hwnd) and not desktop.user32.IsIconic(hwnd),
                       10, 'Test-owned QX window did not restore')
            restored_support = check_dock(page, taskbar, initial_taskbar, unsupported_reason)
            assert restored_support == dock_supported, 'Dock availability changed across minimize/restore'
            assert not desktop.visible(), 'Desktop must remain hidden after restoring QX'
            assert desktop.guard_exists(), 'Desktop guard disappeared across minimize/restore'
            assert not page_errors, f'Renderer errors: {page_errors}'
            # The handles are kept across process exit, including detached native
            # children. A vanishing/reused PID alone cannot make this check pass.
            processes.refresh()
            processes.close_window(hwnd)
            wait_until(lambda: not processes.owns_window(hwnd), 15, '关闭后主窗口仍存在')
            wait_until(processes.all_exited, 20, '关闭后应用/浏览器/native bridge/guard 进程仍存在')
            process.wait(timeout=5)
            assert process.returncode == 0, f'EXE 返回异常代码: {process.returncode}'
            # Assert product recovery BEFORE finally's emergency restoration.
            desktop.wait_visible(initial_visible, 10)
            desktop.assert_unmanaged()
            wait_taskbar_snapshot(taskbar, initial_taskbar)
            assert not page_errors, f'Renderer errors during close: {page_errors}'
            print(f'PASS normal close restored visible={initial_visible} and the original taskbar snapshot; all {len(processes.owned)} processes exited, including {len(native_pids)} native bridge/guard processes')
            # Do not browser.close(): only the real window-close path is tested.
    finally:
        try:
            if process is not None:
                if processes.owned:
                    processes.cleanup(window)
                    process.wait(timeout=5)
                else:
                    stop_owned_process(process)
        finally:
            try:
                processes.close_handles()
            finally:
                try:
                    if process is not None:
                        # Emergency recovery is not a product PASS. This helper
                        # refuses unowned, reused/reparented HWNDs and live guards.
                        taskbar.restore_owned()
                finally:
                    try:
                        if process is not None:
                            desktop.assert_unmanaged()
                            desktop.set_visible(initial_visible)
                    finally:
                        assert_desktop_files_preserved(snapshot)
    print(f'PASS {len(snapshot)} top-level desktop entries retained at their original paths')
    print(f'PASS portable size: {EXECUTABLE.stat().st_size / 1024 / 1024:.1f} MiB')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'FAIL {error}', file=sys.stderr)
        raise

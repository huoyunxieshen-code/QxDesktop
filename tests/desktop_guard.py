"""Interactive guard tests: 8 desktop + 8 taskbar cases; run serially with QX closed."""

import base64
import binascii
import ctypes
from ctypes import wintypes
from contextlib import ExitStack
from dataclasses import dataclass, replace
from pathlib import Path
import os
import queue
import subprocess
import sys
import threading
import time


ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / 'assets' / 'QXDesktopBridge.exe'
GUARD_MUTEX = 'Local\\QXDesktopVisibilityGuard'
TIMEOUT = 10
WINDOW_CALLBACK = ctypes.WINFUNCTYPE if os.name == 'nt' else ctypes.CFUNCTYPE
WINDOW_CALLBACK = WINDOW_CALLBACK(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def wait_until(predicate, timeout, message):
    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if result:
            return result
        if time.monotonic() >= deadline:
            raise TimeoutError(message)
        time.sleep(0.05)


class Desktop:
    """Locate the actual Explorer ListView; never send commands to desktop files."""

    def __init__(self):
        if os.name != 'nt':
            raise RuntimeError('These tests require an interactive Windows desktop')
        self.user32 = ctypes.WinDLL('user32', use_last_error=True)
        self.kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        for name, arguments, result in (
            ('FindWindowW', [wintypes.LPCWSTR, wintypes.LPCWSTR], wintypes.HWND),
            ('FindWindowExW', [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR], wintypes.HWND),
            ('EnumWindows', [WINDOW_CALLBACK, wintypes.LPARAM], wintypes.BOOL),
            ('GetClassNameW', [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            ('IsWindowVisible', [wintypes.HWND], wintypes.BOOL),
            ('ShowWindowAsync', [wintypes.HWND, ctypes.c_int], wintypes.BOOL),
        ):
            function = getattr(self.user32, name)
            function.argtypes = arguments
            function.restype = result
        self.kernel32.OpenMutexW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel32.OpenMutexW.restype = wintypes.HANDLE
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.CloseHandle.restype = wintypes.BOOL

    def guard_exists(self):
        # Creating or retaining this mutex would prevent the guard from acquiring it.
        handle = self.kernel32.OpenMutexW(0x00100000, False, GUARD_MUTEX)
        if handle:
            self.kernel32.CloseHandle(handle)
            return True
        error = ctypes.get_last_error()
        if error != 2:  # ERROR_FILE_NOT_FOUND
            raise ctypes.WinError(error)
        return False

    def assert_unmanaged(self):
        if self.guard_exists():
            raise RuntimeError(f'{GUARD_MUTEX} already exists; refusing to touch the desktop')

    def listview(self):
        user32 = self.user32
        progman = user32.FindWindowW('Progman', None)
        view = user32.FindWindowExW(progman, None, 'SHELLDLL_DefView', None) if progman else None
        views = [view] if view else []
        if not views:
            @WINDOW_CALLBACK
            def visit(hwnd, _):
                name = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, name, len(name))
                if name.value in ('Progman', 'WorkerW'):
                    candidate = user32.FindWindowExW(hwnd, None, 'SHELLDLL_DefView', None)
                    if candidate:
                        views.append(candidate)
                return True
            if not user32.EnumWindows(visit, 0):
                raise ctypes.WinError(ctypes.get_last_error())
        for view in views:
            hwnd = user32.FindWindowExW(view, None, 'SysListView32', None)
            if hwnd:
                return hwnd
        raise RuntimeError('Windows desktop SysListView32 was not found')

    def visible(self):
        return bool(self.user32.IsWindowVisible(self.listview()))

    def wait_visible(self, expected, timeout=TIMEOUT):
        wait_until(lambda: self.visible() == expected, timeout,
                   f'Desktop ListView did not become visible={expected}')

    def set_visible(self, visible):
        if self.visible() != visible:
            self.user32.ShowWindowAsync(self.listview(), 5 if visible else 0)
        self.wait_visible(visible)


@dataclass(frozen=True)
class TaskbarWindow:
    hwnd: int
    class_name: str
    pid: int
    parent: int
    root: int
    visible: bool
    rect: tuple

    @property
    def identity(self):
        return self.hwnd, self.class_name, self.pid, self.parent, self.root


class Taskbar:
    ROOT_CLASSES = ('Shell_TrayWnd', 'Shell_SecondaryTrayWnd')
    TARGET_CLASS = 'MSTaskListWClass'

    def __init__(self, desktop):
        self.desktop = desktop
        self.user32 = desktop.user32
        self._initial = {}
        self._owned = {}
        for name, arguments, result in (
            ('EnumChildWindows', [wintypes.HWND, WINDOW_CALLBACK, wintypes.LPARAM], wintypes.BOOL),
            ('IsWindow', [wintypes.HWND], wintypes.BOOL),
            ('GetWindowLongW', [wintypes.HWND, ctypes.c_int], wintypes.LONG),
            ('GetWindowThreadProcessId', [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
            ('GetParent', [wintypes.HWND], wintypes.HWND),
            ('GetAncestor', [wintypes.HWND, wintypes.UINT], wintypes.HWND),
            ('GetWindowRect', [wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
        ):
            function = getattr(self.user32, name)
            function.argtypes = arguments
            function.restype = result

    def _class_name(self, hwnd):
        name = ctypes.create_unicode_buffer(256)
        self.user32.GetClassNameW(hwnd, name, len(name))
        return name.value

    def _identity(self, hwnd):
        pid = wintypes.DWORD()
        if not self.user32.IsWindow(hwnd) or not self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid)):
            raise RuntimeError(f'Taskbar HWND {hwnd} disappeared')
        class_name = self._class_name(hwnd)
        root = self.user32.GetAncestor(hwnd, 2)
        if not class_name or not pid.value or not root:
            raise RuntimeError(f'Cannot identify taskbar HWND {hwnd}')
        return hwnd, class_name, pid.value, self.user32.GetParent(hwnd) or 0, root

    def _read_window(self, hwnd):
        identity = self._identity(hwnd)
        ctypes.set_last_error(0)
        style = self.user32.GetWindowLongW(hwnd, -16)
        error = ctypes.get_last_error()
        if style == 0 and error:
            raise ctypes.WinError(error)
        rect = wintypes.RECT()
        if not self.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            raise ctypes.WinError(ctypes.get_last_error())
        if self._identity(hwnd) != identity:
            raise RuntimeError(f'Taskbar HWND {hwnd} changed identity during snapshot')
        # Ancestor auto-hide must not be mistaken for this window's own visibility.
        return TaskbarWindow(*identity, bool(style & 0x10000000),
                             (rect.left, rect.top, rect.right, rect.bottom))

    def _windows(self, parent=None):
        windows = []

        @WINDOW_CALLBACK
        def visit(hwnd, _):
            windows.append(hwnd)
            return True

        if parent is None:
            if not self.user32.EnumWindows(visit, 0):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            self.user32.EnumChildWindows(parent, visit, 0)
        return windows

    def snapshot(self):
        snapshot = {}
        for root in self._windows():
            if self._class_name(root) not in self.ROOT_CLASSES:
                continue
            for hwnd in (root, *self._windows(root)):
                state = self._read_window(hwnd)
                if state.root != root:
                    raise RuntimeError(f'Taskbar HWND {hwnd} moved outside root {root}')
                snapshot[hwnd] = state
        return snapshot

    def unsupported_reason(self, snapshot):
        roots = [state for state in snapshot.values() if state.class_name in self.ROOT_CLASSES]
        if not roots:
            return 'no Shell_TrayWnd/Shell_SecondaryTrayWnd found'
        for root in roots:
            if not any(state.class_name == self.TARGET_CLASS and state.root == root.hwnd
                       for state in snapshot.values()):
                return f'{root.class_name} HWND={root.hwnd} has no {self.TARGET_CLASS}'
        return None

    def own_initial_targets(self, snapshot):
        self.desktop.assert_unmanaged()
        if self._owned or self.unsupported_reason(snapshot):
            raise RuntimeError('Cannot take ownership of taskbar test state')
        self.assert_snapshot(snapshot)
        self._initial = dict(snapshot)
        self._owned = {hwnd: state for hwnd, state in snapshot.items()
                       if state.class_name == self.TARGET_CLASS}

    def assert_snapshot(self, before, target_visible=None):
        actual = self.snapshot()
        assert actual.keys() == before.keys(), (
            f'Taskbar HWND set changed: missing={before.keys() - actual.keys()}, '
            f'added={actual.keys() - before.keys()}'
        )
        for hwnd, expected in before.items():
            if expected.class_name == self.TARGET_CLASS and target_visible is not None:
                expected = replace(expected, visible=target_visible)
            assert actual[hwnd] == expected, f'Taskbar changed: expected={expected!r}, actual={actual[hwnd]!r}'

    def _set_owned_visible(self, original, visible):
        if self._owned.get(original.hwnd) is not original or original.class_name != self.TARGET_CLASS:
            raise RuntimeError('Refusing to change a taskbar HWND not owned by this test')

        def own_visible():
            current = self._read_window(original.hwnd)
            root = self._read_window(original.root)
            if current.identity != original.identity or root.identity != self._initial[original.root].identity:
                raise RuntimeError(f'Refusing reused/reparented taskbar HWND {original.hwnd}')
            return current.visible

        self.desktop.assert_unmanaged()
        if own_visible() != visible:
            if not self.user32.ShowWindowAsync(original.hwnd, 8 if visible else 0):
                raise RuntimeError(f'ShowWindowAsync failed for owned taskbar HWND {original.hwnd}')
        wait_until(lambda: own_visible() == visible, TIMEOUT,
                   f'Taskbar HWND {original.hwnd} did not become own-visible={visible}')

    def prepare(self, visible):
        self.desktop.assert_unmanaged()
        before = self.snapshot()
        targets = {hwnd for hwnd, state in before.items() if state.class_name == self.TARGET_CLASS}
        assert targets == self._owned.keys(), 'Taskbar targets changed since test ownership began'
        for original in self._owned.values():
            self._set_owned_visible(original, visible)
        self.assert_snapshot(before, target_visible=visible)
        return self.snapshot()

    def restore_owned(self):
        errors = []
        for original in self._owned.values():
            try:
                self._set_owned_visible(original, original.visible)
            except Exception as error:
                errors.append(f'HWND={original.hwnd}: {error}')
        if errors:
            raise RuntimeError('Could not restore all test-owned taskbar states: ' + '; '.join(errors))


def start_owned_parent():
    return subprocess.Popen(
        [sys.executable, '-I', '-c', 'import time; time.sleep(300)'],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def stop_owned_process(process):
    """Only accepts a Popen created by this test, never a discovered PID/name."""
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)


class Guard:
    def __init__(self, executable, parent_pid):
        self.process = subprocess.Popen(
            [str(executable), 'guard', str(parent_pid)], cwd=str(executable.parent),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        self.lines = []
        self.errors = []
        self.events = queue.Queue()
        self.readers = []
        for stream, target, events in (
            (self.process.stdout, self.lines, self.events),
            (self.process.stderr, self.errors, None),
        ):
            reader = threading.Thread(target=self._read, args=(stream, target, events), daemon=True)
            self.readers.append(reader)
            reader.start()

    @staticmethod
    def _read(stream, target, events):
        try:
            for raw in stream:
                line = raw.rstrip('\r\n')
                target.append(line)
                if events is not None:
                    events.put(line)
        finally:
            if events is not None:
                events.put(None)

    def next_line(self, expected):
        # Never block the main thread in readline(): a broken guard must time out.
        try:
            return self.events.get(timeout=TIMEOUT)
        except queue.Empty as error:
            raise TimeoutError(f'Guard timed out waiting for {expected!r}; stderr={self.errors!r}') from error

    def expect_line(self, expected):
        actual = self.next_line(expected)
        assert actual == expected, f'Expected {expected!r}, got {actual!r}; stderr={self.errors!r}'

    def taskbar(self, hidden):
        command = 'taskbar-hide' if hidden else 'taskbar-show'
        self.process.stdin.write(command + '\n')
        self.process.stdin.flush()
        expected = f'TASKBAR\t{int(hidden)}\t'
        actual = self.next_line(expected)
        fields = actual.split('\t') if actual is not None else []
        assert len(fields) == 3 and fields[0] == 'TASKBAR', f'Invalid taskbar reply: {actual!r}; stderr={self.errors!r}'
        try:
            error_text = base64.b64decode(fields[2], validate=True).decode('utf-8')
        except (ValueError, binascii.Error, UnicodeError) as error:
            raise AssertionError(f'Invalid base64 UTF-8 taskbar error: {actual!r}') from error
        assert not error_text, f'{command} failed: {error_text}'
        assert actual == expected, f'Expected {expected!r}, got {actual!r}'

    def restore(self):
        # Keep stdin OPEN so this case cannot accidentally pass via EOF recovery.
        self.process.stdin.write('restore\n')
        self.process.stdin.flush()

    def wait_exit(self):
        code = self.process.wait(timeout=TIMEOUT)
        for reader in self.readers:
            reader.join(timeout=2)
            assert not reader.is_alive(), 'Guard output reader did not finish'
        return code

    def cleanup(self):
        try:
            if not self.process.stdin.closed:
                try:
                    self.process.stdin.close()  # EOF is the first, graceful recovery path.
                except OSError:
                    pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Last resort, only this Popen. main() restores the initial state.
                stop_owned_process(self.process)
                print(f'WARN forcibly cleaned up test guard pid={self.process.pid}', file=sys.stderr)
        finally:
            if self.process.poll() is not None:
                for reader in self.readers:
                    reader.join(timeout=2)
                for stream in (self.process.stdout, self.process.stderr):
                    stream.close()


def check_desktop_state(desktop):
    result = subprocess.run(
        [str(BRIDGE), 'desktop-state'], cwd=str(BRIDGE.parent),
        stdin=subprocess.DEVNULL, capture_output=True, text=True,
        encoding='utf-8-sig', timeout=TIMEOUT, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert result.returncode == 0, f'desktop-state failed: {result.stderr}'
    expected = f'{desktop.listview()}\t{int(desktop.visible())}'
    assert result.stdout.strip() == expected, f'desktop-state disagrees with ctypes: {result.stdout!r}, expected {expected!r}'


def assert_guard_hides_desktop(desktop, guard, taskbar=None, before=None, target_visible=None):
    deadline = time.monotonic() + 0.5
    while True:
        assert guard.process.poll() is None, 'Guard exited while its parent and stdin were still alive'
        assert not desktop.visible(), 'Desktop became visible while guard was active'
        if taskbar is not None:
            taskbar.assert_snapshot(before, target_visible)
        if time.monotonic() >= deadline:
            return
        time.sleep(0.05)


def run_case(desktop, original_visible, trigger, taskbar=None):
    desktop.assert_unmanaged()
    desktop.set_visible(original_visible)
    check_desktop_state(desktop)
    before = taskbar.snapshot() if taskbar is not None else None
    with ExitStack() as cleanup:
        parent = start_owned_parent()
        cleanup.callback(stop_owned_process, parent)
        guard = Guard(BRIDGE, parent.pid)
        cleanup.callback(guard.cleanup)
        guard.expect_line(f'READY\t{int(original_visible)}')
        assert parent.poll() is None, 'Temporary parent exited prematurely'
        desktop.wait_visible(False)
        assert desktop.guard_exists(), 'Active guard did not create its singleton mutex'
        assert_guard_hides_desktop(desktop, guard, taskbar, before)
        check_desktop_state(desktop)

        if trigger == 'second-guard':
            second = Guard(BRIDGE, parent.pid)
            cleanup.callback(second.cleanup)
            assert second.wait_exit() != 0, 'Second guard unexpectedly succeeded'
            assert not second.lines, f'Rejected guard must not emit READY/RESTORED: {second.lines!r}'
            assert 'Desktop is already managed' in '\n'.join(second.errors), second.errors
            assert_guard_hides_desktop(desktop, guard, taskbar, before)
            guard.restore()
        elif trigger == 'restore':
            guard.restore()
        elif trigger == 'stdin-eof':
            guard.process.stdin.close()
        elif trigger == 'parent-crash':
            assert not guard.process.stdin.closed, 'Crash test requires an open guard stdin'
            parent.kill()
            assert parent.wait(timeout=5) != 0, 'Temporary parent did not exit abnormally'
        else:
            raise ValueError(trigger)

        guard.expect_line('RESTORED')
        assert guard.wait_exit() == 0, f'Guard failed: {guard.errors!r}'
        assert guard.lines == [f'READY\t{int(original_visible)}', 'RESTORED'], guard.lines
        if trigger != 'parent-crash':
            assert parent.poll() is None, 'Recovery must not rely on the temporary parent exiting'
        if trigger != 'stdin-eof':
            assert not guard.process.stdin.closed, 'Recovery must not rely on stdin EOF'
        desktop.wait_visible(original_visible)
        desktop.assert_unmanaged()
        check_desktop_state(desktop)
        if taskbar is not None:
            taskbar.assert_snapshot(before)
    print(f'PASS originalVisible={int(original_visible)}: {trigger}')


def run_taskbar_case(desktop, taskbar, original_visible, trigger):
    desktop.assert_unmanaged()
    desktop.set_visible(original_visible)
    before = taskbar.prepare(original_visible)
    check_desktop_state(desktop)
    with ExitStack() as cleanup:
        parent = start_owned_parent()
        cleanup.callback(stop_owned_process, parent)
        guard = Guard(BRIDGE, parent.pid)
        cleanup.callback(guard.cleanup)
        ready = f'READY\t{int(original_visible)}'
        guard.expect_line(ready)
        expected_lines = [ready]
        assert parent.poll() is None, 'Temporary parent exited prematurely'
        desktop.wait_visible(False)
        assert desktop.guard_exists(), 'Active guard did not create its singleton mutex'
        assert_guard_hides_desktop(desktop, guard, taskbar, before)

        # Show before the first hide must preserve even an originally hidden target.
        commands = (False, True, False, True) if trigger == 'show-hide' else (True,)
        for hidden in commands:
            guard.taskbar(hidden)
            expected_lines.append(f'TASKBAR\t{int(hidden)}\t')
            assert parent.poll() is None, 'Taskbar commands must not rely on the parent exiting'
            assert not guard.process.stdin.closed, 'Taskbar commands require open stdin'
            assert_guard_hides_desktop(desktop, guard, taskbar, before,
                                       target_visible=False if hidden else None)
        check_desktop_state(desktop)

        if trigger in ('restore', 'show-hide'):
            guard.restore()
        elif trigger == 'stdin-eof':
            guard.process.stdin.close()
        elif trigger == 'parent-crash':
            assert not guard.process.stdin.closed, 'Crash test requires an open guard stdin'
            parent.kill()
            assert parent.wait(timeout=5) != 0, 'Temporary parent did not exit abnormally'
        else:
            raise ValueError(trigger)

        guard.expect_line('RESTORED')
        assert guard.wait_exit() == 0, f'Guard failed: {guard.errors!r}'
        assert guard.lines == expected_lines + ['RESTORED'], guard.lines
        if trigger != 'parent-crash':
            assert parent.poll() is None, 'Recovery must not rely on the temporary parent exiting'
        if trigger != 'stdin-eof':
            assert not guard.process.stdin.closed, 'Recovery must not rely on stdin EOF'
        desktop.wait_visible(original_visible)
        desktop.assert_unmanaged()
        check_desktop_state(desktop)
        taskbar.assert_snapshot(before)
    print(f'PASS taskbar originalOwnVisible={int(original_visible)}: {trigger}')


def main():
    if not BRIDGE.is_file():
        raise FileNotFoundError(f'Build the native bridge before running this test: {BRIDGE}')
    desktop = Desktop()
    # Refuse before any cleanup can mistake another guard's state for test ownership.
    desktop.assert_unmanaged()
    initial_visible = desktop.visible()
    taskbar = Taskbar(desktop)
    initial_taskbar = taskbar.snapshot()
    skip_reason = taskbar.unsupported_reason(initial_taskbar)
    if skip_reason:
        print(f'SKIP 8 taskbar cases: {skip_reason}; retaining all 8 desktop cases')
        taskbar = None
    else:
        taskbar.own_initial_targets(initial_taskbar)
    try:
        for original_visible in (True, False):
            for trigger in ('restore', 'stdin-eof', 'parent-crash', 'second-guard'):
                run_case(desktop, original_visible, trigger, taskbar)
        if taskbar is not None:
            for original_visible in (True, False):
                for trigger in ('restore', 'stdin-eof', 'parent-crash', 'show-hide'):
                    run_taskbar_case(desktop, taskbar, original_visible, trigger)
    finally:
        # Child cleanup precedes fallback restoration, never the product assertions.
        desktop.assert_unmanaged()
        try:
            if taskbar is not None:
                taskbar.restore_owned()
        finally:
            desktop.assert_unmanaged()
            desktop.set_visible(initial_visible)
    taskbar_result = 'SKIP 8 taskbar cases' if skip_reason else 'PASS 8 taskbar cases; pre-test target states restored'
    print(f'PASS 8 desktop cases; {taskbar_result}; pre-test desktop visible={initial_visible} restored')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'FAIL {error}', file=sys.stderr)
        raise

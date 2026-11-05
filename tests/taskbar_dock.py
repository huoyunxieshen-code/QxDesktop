"""--inventory-only can run with QX open; default/--ui tests require QX closed."""

import argparse
import base64
import ctypes
from ctypes import wintypes
from contextlib import ExitStack
import json
import os
import queue
import subprocess
import sys
import threading
import uuid

from desktop_guard import BRIDGE, Desktop, Guard, Taskbar, stop_owned_process, wait_until


FIXTURE = r'''
import ctypes, queue, sys, threading, tkinter as tk
# Optional process-local identity; no pins, registry or shared Python state change.
app_id = next((arg.split('=', 1)[1] for arg in sys.argv[2:] if arg.startswith('app-id=')), None)
if app_id:
    set_app_id = ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID
    set_app_id.argtypes, set_app_id.restype = [ctypes.c_wchar_p], ctypes.c_long
    result = set_app_id(app_id)
    if result != 0:
        raise OSError('Fixture AUMID failed: ' + str(result))
commands = queue.Queue()
root = tk.Tk()
root.withdraw()
windows = {}
names = ('A', 'B', 'C') if 'three' in sys.argv[2:] else ('A', 'B')
for index, name in enumerate(names):
    window = tk.Toplevel(root)
    window.title(sys.argv[1] + ' ' + name)
    window.geometry('360x180+' + str(100 + 400 * index) + '+100')
    tk.Label(window, text='QX taskbar integration fixture ' + name).pack(pady=60)
    windows[name] = window

def read():
    for line in sys.stdin:
        commands.put(line.strip())
    commands.put('quit')
threading.Thread(target=read, daemon=True).start()
def drain():
    while not commands.empty():
        command = commands.get_nowait()
        if command == 'quit':
            root.destroy()
            return
        fields = command.split(' ', 2)
        action, name = fields[:2]
        if action == 'minimize': windows[name].iconify()
        elif action == 'close': windows[name].destroy()
        elif action == 'rename': windows[name].title(sys.argv[1] + ' ' + fields[2])
        else: raise ValueError('Unknown fixture command: ' + command)
        print('DONE ' + command, flush=True)
    root.after(25, drain)
root.after(25, drain)
root.after(100, lambda: print('READY', flush=True))
root.mainloop()
'''


class LineProcess:
    def __init__(self, arguments):
        self.process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding='utf-8',
                                        bufsize=1, creationflags=subprocess.CREATE_NO_WINDOW)
        self.lines = queue.Queue()
        self.errors = []
        self.readers = [threading.Thread(target=self.read, args=(self.process.stdout, self.lines.put)),
                        threading.Thread(target=self.read, args=(self.process.stderr, self.errors.append))]
        for reader in self.readers:
            reader.start()

    @staticmethod
    def read(stream, receive):
        for line in stream:
            receive(line.rstrip('\r\n'))

    def next(self):
        try:
            return self.lines.get(timeout=15)
        except queue.Empty:
            raise AssertionError(f'No reply; code={self.process.poll()}, stderr={self.errors}')

    def send(self, text):
        self.process.stdin.write(text + '\n')
        self.process.stdin.flush()

    def cleanup(self):
        if not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            stop_owned_process(self.process)
        for reader in self.readers:
            reader.join(timeout=2)
            assert not reader.is_alive()
        self.process.stdout.close()
        self.process.stderr.close()


def snapshot(dock, refresh=True):
    if refresh:
        dock.send('refresh')
    line = dock.next()
    assert line.startswith('SNAPSHOT\t'), line
    return json.loads(base64.b64decode(line.split('\t')[1], validate=True))


def complete_snapshot(dock):
    last = {}
    def read():
        nonlocal last
        last = snapshot(dock)
        return last if last['supported'] else None
    try:
        return wait_until(read, 15, 'Taskbar inventory did not become complete')
    except TimeoutError:
        raise AssertionError(last.get('error'))


def fixture_command(fixture, command):
    fixture.send(command)
    assert fixture.next() == 'DONE ' + command


def assert_fixture_inventory(inventory, prefix, titles, ids=None, grouped=False):
    assert inventory['supported'], inventory['error']
    assert not inventory['error'], inventory['error']
    items = inventory['items']
    item_ids = [item['id'] for item in items]
    assert len(item_ids) == len(set(item_ids)), f'Duplicate Dock group IDs: {item_ids}'
    windows = [window for item in items for window in item['windows']]
    window_ids = [window['id'] for window in windows]
    # Check the flat list BEFORE building maps: repeated coverage must not be lost.
    assert all(window_ids) and len(window_ids) == len(set(window_ids)), (
        f'Duplicate/empty native window IDs: {window_ids}'
    )
    known_ids = set(ids.values()) if ids is not None else set()
    owned = [window for window in windows
             if window['id'] in known_ids or window['title'].startswith(prefix + ' ')]
    observed = [(window['id'], window['title']) for window in owned]
    assert len(owned) == len(titles), f'Fixture coverage changed: {observed}'
    if ids is None:
        # Capture identity while titles are distinct; never rediscover by title after rename.
        ids = {}
        for name, title in titles.items():
            matches = [window for window in owned if window['title'] == prefix + ' ' + title]
            assert len(matches) == 1, f'Initial fixture {name} is not unique: {observed}'
            ids[name] = matches[0]['id']
    assert len(set(ids.values())) == len(titles), f'Fixture IDs are not distinct: {ids}'
    expected = {ids[name]: prefix + ' ' + title for name, title in titles.items()}
    assert dict(observed) == expected, f'Fixture IDs/titles changed: expected={expected}, actual={observed}'
    groups = [item for item in items if any(window['id'] in expected for window in item['windows'])]
    assert all(item['running'] and all(window['id'] in expected for window in item['windows'])
               for item in groups), 'Fixture group includes unrelated windows or is not running'
    if grouped:
        assert len(groups) == 1 and len(groups[0]['windows']) == len(titles), (
            f'Expected one complete same-app group: {fixture_layout(groups)}'
        )
    return ids, groups


def fixture_layout(groups):
    return tuple((item['id'], tuple(window['id'] for window in item['windows'])) for item in groups)


def wait_fixture_inventory(read_inventory, prefix, titles, ids=None, grouped=False):
    last_error = ''
    def read():
        nonlocal last_error
        inventory = read_inventory()
        try:
            actual_ids, groups = assert_fixture_inventory(inventory, prefix, titles, ids, grouped)
        except AssertionError as error:
            last_error = str(error)
            return None
        return inventory, actual_ids, groups
    try:
        return wait_until(read, 15, 'Fixture inventory did not settle')
    except TimeoutError as error:
        raise AssertionError(f'Fixture titles {titles}: {last_error}') from error


def run_inventory_only():
    """Only stdin rename/quit on our fixture and read-only refresh on our dock helper."""
    if os.name != 'nt':
        raise RuntimeError('These tests require an interactive Windows desktop')
    if not BRIDGE.is_file():
        raise FileNotFoundError(f'Build the native bridge before running this test: {BRIDGE}')
    prefix = 'QX Dock inventory fixture ' + uuid.uuid4().hex
    distinct = {name: name for name in ('A', 'B', 'C')}
    # Deliberately no Desktop/Taskbar ownership, guard, activation or visibility recovery.
    # The optional AUMID belongs only to this fixture, isolating other Python windows.
    with ExitStack() as cleanup:
        fixture = LineProcess([sys.executable, '-u', '-c', FIXTURE, prefix, 'three',
                               'app-id=' + prefix.replace(' ', '.')])
        cleanup.callback(fixture.cleanup)
        assert fixture.next() == 'READY'
        dock = LineProcess([str(BRIDGE), 'dock', str(os.getpid())])
        cleanup.callback(dock.cleanup)
        snapshot(dock, False)  # Consume the unsolicited startup snapshot before refreshing.
        read_inventory = lambda: snapshot(dock)
        _, ids, groups = wait_fixture_inventory(read_inventory, prefix, distinct)
        original_members = sorted(members for _, members in fixture_layout(groups))
        print('PASS distinct fixture titles captured native IDs: ' + json.dumps(ids, sort_keys=True))
        duplicate_layout = None
        for stage, commands, titles, grouped in (
            ('distinct', (), distinct, False),
            ('A/A/C', ('rename B A',), {'A': 'A', 'B': 'A', 'C': 'C'}, True),
            ('A/A/A', ('rename C A',), {'A': 'A', 'B': 'A', 'C': 'A'}, True),
            ('restored', ('rename B B', 'rename C C'), distinct, False),
        ):
            for command in commands:
                fixture_command(fixture, command)
            if commands:
                _, _, groups = wait_fixture_inventory(read_inventory, prefix, titles, ids, grouped)
            layout = fixture_layout(groups)
            if grouped:
                if duplicate_layout is not None:
                    assert layout == duplicate_layout, 'Same-title group identity/window order changed'
                duplicate_layout = layout
            if stage == 'restored':
                assert sorted(members for _, members in layout) == original_members, (
                    'Distinct-title fixture grouping did not recover'
                )
            # Once settled, every refresh must pass; do not retry away unstable ordering/coverage.
            for _ in range(3):
                _, refreshed_groups = assert_fixture_inventory(read_inventory(), prefix, titles, ids, grouped)
                assert fixture_layout(refreshed_groups) == layout, f'{stage}: unstable group IDs/window order'
            print(f'PASS read-only {stage}: all 3 original IDs covered once; 3 stable refreshes')
        fixture.send('quit')
        assert fixture.process.wait(timeout=5) == 0
        dock.process.stdin.close()
        assert dock.process.wait(timeout=5) == 0
    print('PASS inventory-only: owned fixture/dock exited; no guard, activation or visibility commands')


def activate(dock, token, error=False):
    dock.send('activate\tcheck\t' + base64.b64encode(token.encode()).decode())
    line = dock.next()
    assert line.startswith('RESULT\tcheck\t'), line
    message = base64.b64decode(line.split('\t')[2], validate=True).decode()
    assert bool(message) == error, message


def main():
    desktop = Desktop()
    desktop.assert_unmanaged()
    taskbar = Taskbar(desktop)
    before = taskbar.snapshot()
    unsupported = taskbar.unsupported_reason(before)
    if unsupported:
        raise RuntimeError(unsupported)
    taskbar.own_initial_targets(before)
    original_visible = desktop.visible()
    user32 = desktop.user32
    for name, arguments, result in (
        ('FindWindowW', [wintypes.LPCWSTR, wintypes.LPCWSTR], wintypes.HWND),
        ('GetForegroundWindow', [], wintypes.HWND),
        ('IsIconic', [wintypes.HWND], wintypes.BOOL),
    ):
        function = getattr(user32, name)
        function.argtypes, function.restype = arguments, result
    prefix = 'QX Dock fixture ' + uuid.uuid4().hex[:8]
    try:
        with ExitStack() as cleanup:
            fixture = LineProcess([sys.executable, '-u', '-c', FIXTURE, prefix])
            cleanup.callback(fixture.cleanup)
            assert fixture.next() == 'READY'
            handles = {name: wait_until(lambda n=name: user32.FindWindowW(None, prefix + ' ' + n), 10, 'Fixture HWND missing') for name in ('A', 'B')}
            dock = LineProcess([str(BRIDGE), 'dock', str(os.getpid())])
            cleanup.callback(dock.cleanup)
            first = snapshot(dock, False)
            full = first if first['supported'] else complete_snapshot(dock)
            assert all(item['icon'].startswith('data:image/png;base64,') for item in full['items'])
            windows = {window['title']: window['id'] for item in full['items'] for window in item['windows']}
            ids = {name: windows[prefix + ' ' + name] for name in ('A', 'B')}
            refreshed = complete_snapshot(dock)
            next_windows = {window['title']: window['id'] for item in refreshed['items'] for window in item['windows']}
            assert all(next_windows[prefix + ' ' + name] == token for name, token in ids.items())
            print(f'PASS complete native inventory: {len(full["items"])} items; stable fixture IDs and PNG icons')
            activate(dock, 'C:\\not-an-authorized-launch.exe', error=True)
            taskbar.assert_snapshot(before)
            guard = Guard(BRIDGE, os.getpid())
            cleanup.callback(guard.cleanup)
            guard.expect_line(f'READY\t{int(original_visible)}')
            guard.taskbar(True)
            taskbar.assert_snapshot(before, target_visible=False)
            hidden = complete_snapshot(dock)
            assert hidden['supported'], hidden['error']
            print('PASS native UIA inventory remains complete while application buttons are hidden')
            for name in ('A', 'B'):
                activate(dock, ids[name])
                wait_until(lambda n=name: user32.GetForegroundWindow() == handles[n], 5, 'Fixture did not become foreground')
                assert not user32.IsIconic(handles[name])
            fixture.send('minimize A')
            assert fixture.next() == 'DONE minimize A'
            wait_until(lambda: user32.IsIconic(handles['A']), 5, 'Fixture did not minimize')
            activate(dock, ids['A'])
            wait_until(lambda: not user32.IsIconic(handles['A']) and user32.GetForegroundWindow() == handles['A'], 5, 'Minimized fixture did not restore and activate')
            taskbar.assert_snapshot(before, target_visible=False)
            print('PASS real foreground switching and minimized-window restoration for owned fixtures')
            fixture.send('close B')
            assert fixture.next() == 'DONE close B'
            wait_until(lambda: not user32.IsWindow(handles['B']), 5, 'Fixture did not close')
            activate(dock, ids['B'], error=True)
            current = complete_snapshot(dock)
            assert not any(window['id'] == ids['B'] for item in current['items'] for window in item['windows'])
            print('PASS closed-window token rejected and removed on refresh')
            guard.restore()
            guard.expect_line('RESTORED')
            assert guard.wait_exit() == 0
            desktop.assert_unmanaged()
            desktop.wait_visible(original_visible)
            taskbar.assert_snapshot(before)
            dock.process.stdin.close()
            assert dock.process.wait(timeout=5) == 0
            print('PASS dock EOF exits; guard restores desktop and all taskbar states')
    finally:
        desktop.assert_unmanaged()
        try:
            taskbar.restore_owned()
        finally:
            desktop.set_visible(original_visible)


def run_ui(duplicates=False):
    import socket
    import tempfile
    from pathlib import Path
    from playwright.sync_api import sync_playwright
    from portable_smoke import ApplicationProcesses, EXECUTABLE, wait_for_bootstrap, wait_taskbar_snapshot

    desktop = Desktop()
    desktop.assert_unmanaged()
    processes = ApplicationProcesses(desktop)
    processes.assert_no_existing_app()
    if not EXECUTABLE.is_file():
        raise FileNotFoundError(EXECUTABLE)
    taskbar = Taskbar(desktop)
    before = taskbar.snapshot()
    taskbar.own_initial_targets(before)
    original_visible = desktop.visible()
    desktop.user32.GetForegroundWindow.restype = wintypes.HWND
    prefix = 'QX Dock UI fixture ' + uuid.uuid4().hex[:8]
    process = None
    window = None
    try:
        with ExitStack() as cleanup:
            fixture_arguments = [sys.executable, '-u', '-c', FIXTURE, prefix]
            if duplicates:
                fixture_arguments.append('app-id=' + prefix.replace(' ', '.'))
            fixture = LineProcess(fixture_arguments)
            cleanup.callback(fixture.cleanup)
            assert fixture.next() == 'READY'
            handles = {name: wait_until(lambda n=name: desktop.user32.FindWindowW(None, prefix + ' ' + n), 10, 'Fixture HWND missing') for name in ('A', 'B')}
            temporary = cleanup.enter_context(tempfile.TemporaryDirectory(prefix='qx-dock-ui-'))
            environment = os.environ.copy()
            for key in ('HARBOR_TEST_MODE', 'HARBOR_DATA_DIR', 'ELECTRON_RUN_AS_NODE'):
                environment.pop(key, None)
            environment.update(TEMP=temporary, TMP=temporary)
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            process = subprocess.Popen([str(EXECUTABLE), f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1'], env=environment)
            cleanup.callback(lambda: processes.cleanup(window) if processes.owned else stop_owned_process(process))
            processes.add_root(process)
            window = wait_until(processes.find_window, 90, 'QX UI did not start')
            hwnd = window[0]
            with sync_playwright() as playwright:
                connection = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=15000)
                page = wait_until(lambda: next((page for context in connection.contexts for page in context.pages if page.url.startswith('file:') and 'index.html' in page.url), None), 15, 'QX renderer missing')
                initial = wait_for_bootstrap(page, taskbar_hidden=True, desktop_active=True)
                assert initial['dock']['supported'], initial['dock']['error']
                wait_taskbar_snapshot(taskbar, before, target_visible=False)
                for name in ('A', 'B'):
                    current = wait_for_bootstrap(page, taskbar_hidden=True)
                    target = next(item for item in current['dock']['items'] if any(entry['title'] == prefix + ' ' + name for entry in item['windows']))
                    desktop.user32.SetForegroundWindow(hwnd)
                    button = page.locator(f'[data-dock="{target["id"]}"]')
                    button.click()
                    if len(target['windows']) > 1:
                        page.get_by_role('menuitem', name=prefix + ' ' + name, exact=True).click()
                    wait_until(lambda n=name: desktop.user32.GetForegroundWindow() == handles[n], 5, 'Real Dock click did not activate owned fixture')
                fixture.send('minimize A')
                assert fixture.next() == 'DONE minimize A'
                wait_until(lambda: desktop.user32.IsIconic(handles['A']), 5, 'Fixture did not minimize')
                current = wait_for_bootstrap(page, taskbar_hidden=True)
                target = next(item for item in current['dock']['items'] if any(entry['title'] == prefix + ' A' for entry in item['windows']))
                desktop.user32.SetForegroundWindow(hwnd)
                page.locator(f'[data-dock="{target["id"]}"]').click()
                if len(target['windows']) > 1:
                    page.get_by_role('menuitem', name=prefix + ' A', exact=True).click()
                wait_until(lambda: not desktop.user32.IsIconic(handles['A']) and desktop.user32.GetForegroundWindow() == handles['A'], 5, 'UI click did not restore minimized fixture')
                print('PASS packaged Dock real clicks switch owned windows and restore minimized windows')
                if duplicates:
                    read_inventory = lambda: wait_for_bootstrap(page, taskbar_hidden=True)['dock']
                    distinct = {'A': 'A', 'B': 'B'}
                    _, ids, _ = wait_fixture_inventory(read_inventory, prefix, distinct)
                    fixture_command(fixture, 'rename B A')
                    titles = {'A': 'A', 'B': 'A'}
                    current, _, groups = wait_fixture_inventory(read_inventory, prefix, titles, ids, True)
                    layout = fixture_layout(groups)
                    for name in ('A', 'B', 'A', 'B'):
                        target = groups[0]
                        index = next(index for index, entry in enumerate(target['windows']) if entry['id'] == ids[name])
                        label = f'{prefix} A（窗口 {index + 1}）'
                        revision = current['revision']
                        desktop.user32.SetForegroundWindow(hwnd)
                        page.locator(f'[data-dock="{target["id"]}"]').click()
                        page.get_by_role('menuitem', name=label, exact=True).click()
                        wait_until(lambda n=name: desktop.user32.GetForegroundWindow() == handles[n], 5,
                                   'Same-title menu click did not activate the correct owned fixture')
                        def refreshed_inventory():
                            value = read_inventory()
                            return value if value['revision'] > revision else None
                        current = wait_until(refreshed_inventory, 15, 'Same-title UI inventory did not refresh')
                        _, groups = assert_fixture_inventory(current, prefix, titles, ids, True)
                        assert fixture_layout(groups) == layout, 'Same-title menu order changed after activation'
                    fixture_command(fixture, 'rename B B')
                    wait_fixture_inventory(read_inventory, prefix, distinct, ids)
                    print('PASS same-title numbered menus activate each owned HWND; IDs/order survive foreground changes')
                desktop.user32.SetForegroundWindow(hwnd)
                page.screenshot(path=str(Path(__file__).resolve().parent.parent / 'assets' / 'dock-live.png'))
                processes.close_window(hwnd)
                wait_until(processes.all_exited, 20, 'Packaged Dock processes did not exit')
                assert process.wait(timeout=5) == 0
                desktop.wait_visible(original_visible)
                desktop.assert_unmanaged()
                wait_taskbar_snapshot(taskbar, before)
                print('PASS packaged Dock normal close restored desktop/taskbar and exited all owned processes')
    finally:
        processes.close_handles()
        desktop.assert_unmanaged()
        try:
            taskbar.restore_owned()
        finally:
            desktop.set_visible(original_visible)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--inventory-only', action='store_true',
                       help='Read-only three-window duplicate-title regression; safe with QX running')
    modes.add_argument('--ui', action='store_true', help='Also run packaged UI clicks; requires QX closed')
    parser.add_argument('--duplicates', action='store_true', help='With --ui, click same-title numbered menus')
    arguments = parser.parse_args()
    if arguments.duplicates and not arguments.ui:
        parser.error('--duplicates requires --ui; --inventory-only already covers duplicate titles')
    if arguments.inventory_only:
        run_inventory_only()
    else:
        main()
        if arguments.ui:
            run_ui(duplicates=arguments.duplicates)

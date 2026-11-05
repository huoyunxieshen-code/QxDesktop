'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Only these two source reads touch the host filesystem. Both modules execute
// unchanged, with a closed require allowlist and no real Electron/helper/Store.
const sourceDirectory = path.resolve(__dirname, '..', 'src');
const sources = Object.fromEntries(['windows.cjs', 'main.cjs'].map(name => [
  name, fs.readFileSync(path.join(sourceDirectory, name), 'utf8')
]));
const helperPath = 'C:\\isolated-test\\NativeBridge.exe';
const parentPid = 42001;
const png = 'data:image/png;base64,aWNvbg==';
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const base64 = value => Buffer.from(value, 'utf8').toString('base64');
const snapshot = (overrides = {}) => ({
  supported: true,
  error: '',
  items: [{
    id: 'app:编辑器', title: '编辑器', icon: png, running: true, active: false,
    windows: [{ id: 'hwnd:101', title: '文档一', hwnd: 101 }]
  }],
  ...overrides
});
const emitSnapshot = (child, value) => child.line(`SNAPSHOT\t${base64(JSON.stringify(value))}`);
const emitResult = (child, id, error = '') => child.line(`RESULT\t${id}\t${base64(error)}`);
const requestFields = child => child.stdin.writes.at(-1).trimEnd().split('\t');
async function settle() {
  // Flush promise continuations without advancing any clock or doing real I/O.
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

class FakeChild extends EventEmitter {
  constructor(executable, args, options, pid) {
    super();
    this.executable = executable;
    this.args = plain(args);
    this.options = plain(options);
    this.pid = pid;
    this.exitCode = null;
    this.exited = false;
    this.killCalls = 0;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stderr.resumeCalls = 0;
    this.stderr.resume = () => { this.stderr.resumeCalls++; };
    this.stdin = new EventEmitter();
    Object.assign(this.stdin, {
      writes: [], endCalls: [], ended: false,
      write: value => {
        assert.equal(this.stdin.ended, false, 'no writes after helper stdin closes');
        this.stdin.writes.push(String(value));
        return true;
      },
      end: value => {
        if (value !== undefined) this.stdin.writes.push(String(value));
        this.stdin.endCalls.push(value);
        this.stdin.ended = true;
      }
    });
  }
  line(value) {
    assert.ok(this.stdout.reader, 'the real bridge must create a readline reader');
    if (!this.stdout.reader.closed) this.stdout.reader.emit('line', value);
  }
  exit(code = 0) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.emit('exit', code);
  }
  kill() {
    // kill and exit are separate events, as they are for a real child process.
    this.killCalls++;
    return true;
  }
}

function createRuntime(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const forbiddenCalls = [];
  const unexpected = name => (...args) => {
    forbiddenCalls.push({ name, args });
    throw new Error(`Unexpected external operation: ${name}`);
  };
  const spawn = (executable, args, options) => {
    assert.ok(['dock', 'guard', 'icons'].includes(args[0]));
    const child = new FakeChild(executable, args, options, 50000 + children.length);
    children.push(child);
    return child;
  };
  const readline = {
    createInterface({ input }) {
      assert.ok(children.some(child => child.stdout === input));
      const reader = new EventEmitter();
      reader.closed = false;
      reader.close = () => { reader.closed = true; };
      input.reader = reader;
      return reader;
    }
  };
  function load(name, dependencies) {
    const module = { exports: {} };
    const context = vm.createContext({
      module, exports: module.exports, Buffer,
      __dirname: sourceDirectory, __filename: path.join(sourceDirectory, name),
      process: { pid: parentPid, platform: 'win32', execPath: process.execPath, env: {}, resourcesPath: 'C:\\isolated-test\\resources' },
      setTimeout, clearTimeout,
      require(id) {
        if (!Object.hasOwn(dependencies, id)) return unexpected(`require(${id})`)();
        return dependencies[id];
      }
    });
    new vm.Script(sources[name], { filename: path.join(sourceDirectory, name) }).runInContext(context);
    return module.exports;
  }
  const { WindowsBridge } = load('windows.cjs', {
    'node:child_process': { spawn }, 'node:readline': readline
  });
  t.after(() => {
    // All children and timers are in-memory fakes. Finish outstanding listeners
    // before Node automatically restores this test's mock timers.
    for (const child of children) child.exit(0);
    assert.deepEqual(forbiddenCalls, [], 'no filesystem writes, shell calls, or unmocked imports');
  });
  return { children, forbiddenCalls, unexpected, load, WindowsBridge, tick: ms => t.mock.timers.tick(ms) };
}

function createBridge(t, startDock = true) {
  const runtime = createRuntime(t);
  const bridge = new runtime.WindowsBridge(helperPath);
  const snapshots = [];
  const failures = [];
  const start = () => bridge.startDock(value => snapshots.push(plain(value)), message => failures.push(message));
  if (startDock) start();
  return { ...runtime, bridge, snapshots, failures, start, get dock() { return bridge.dock; } };
}

async function createMain(t) {
  const runtime = createRuntime(t);
  const handlers = new Map();
  const windows = [];
  const messages = [];
  const errors = [];
  const fsProbes = [];
  const stores = [];
  const ignored = [];
  const appPaths = new Map([
    ['appData', 'C:\\isolated-test\\AppData'],
    ['desktop', 'C:\\isolated-test\\Desktop']
  ]);
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, quitCalls: 0,
    setName() {},
    setPath: (name, value) => appPaths.set(name, value),
    getPath: name => {
      assert.ok(appPaths.has(name), `mock app path: ${name}`);
      return appPaths.get(name);
    },
    getVersion: () => 'test',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    loginItemState: false,
    loginItems: [],
    getLoginItemSettings: options => ({ openAtLogin: app.loginItemState, path: options?.path }),
    setLoginItemSettings: options => { app.loginItemState = Boolean(options.openAtLogin); app.loginItems.push(plain(options)); },
    quit: () => { app.quitCalls++; }
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.minimized = false;
      this.maximized = false;
      this.destroyed = false;
      this.closeCalls = 0;
      this.focusCalls = 0;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: {},
        isDestroyed: () => this.destroyed,
        send: (channel, value) => messages.push({ channel, value: plain(value) }),
        setWindowOpenHandler: handler => { this.openHandler = handler; }
      });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isMaximized() { return this.maximized; }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; this.emit('hide'); }
    minimize() { this.minimized = true; this.emit('minimize'); }
    restore() { this.minimized = false; this.emit('restore'); }
    focus() { this.focusCalls++; }
    loadFile(filename) { this.loadedFile = filename; return Promise.resolve(); }
    getContentSize() { return [this.options.width, this.options.height]; }
    getContentBounds() { return { x: 100, y: 200, width: this.options.width, height: this.options.height }; }
    getNormalBounds() { return { width: this.options.width, height: this.options.height }; }
    close() {
      this.closeCalls++;
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', event);
      if (!event.prevented) {
        this.destroyed = true;
        this.visible = false;
        this.emit('closed');
      }
    }
  }
  class Store {
    constructor(directory) {
      this.directory = directory;
      this.recovered = false;
      this.state = { items: [], categories: [], notes: [], window: {} };
      this.saves = 0;
      this.flushes = 0;
      stores.push(this);
    }
    saveSoon() { this.saves++; }
    flush() { this.flushes++; }
  }
  const fakeFs = new Proxy({
    existsSync(filename) { fsProbes.push(filename); return false; }
  }, {
    get: (target, name) => Object.hasOwn(target, name) ? target[name] : runtime.unexpected(`fs.${String(name)}`)
  });
  let uuid = 0;
  runtime.load('main.cjs', {
    electron: {
      app, BrowserWindow,
      WebContentsView: runtime.unexpected('WebContentsView'),
      screen: { dipToScreenRect: (_window, rect) => ({ x: rect.x * 2, y: rect.y * 2, width: rect.width * 2, height: rect.height * 2 }) },
      ipcMain: { handle: (channel, handler) => {
        assert.equal(handlers.has(channel), false);
        handlers.set(channel, handler);
      } },
      dialog: {
        showErrorBox: (title, message) => errors.push({ title, message }),
        showOpenDialog: runtime.unexpected('dialog.showOpenDialog')
      },
      shell: {
        openPath: runtime.unexpected('shell.openPath'),
        openExternal: runtime.unexpected('shell.openExternal'),
        showItemInFolder: runtime.unexpected('shell.showItemInFolder')
      },
      session: { fromPartition: runtime.unexpected('session.fromPartition') },
      Menu: { setApplicationMenu() {} }
    },
    'node:fs': fakeFs,
    'node:path': path,
    'node:crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    './windows.cjs': { WindowsBridge: runtime.WindowsBridge },
    './core.cjs': {
      Store,
      resolveDataDirectory: () => 'C:\\isolated-test\\data',
      addPaths: (_state, files) => {
        assert.deepEqual(plain(files), []);
        return { added: 0, skipped: 0 };
      },
      ignorePath: (_state, filePath) => ignored.push(filePath),
      normalizeUrl: runtime.unexpected('normalizeUrl'),
      relocateStore: runtime.unexpected('relocateStore')
    }
  });
  await settle();
  assert.deepEqual(errors, [], 'the real main module must initialize successfully');
  assert.equal(windows.length, 1);
  const window = windows[0];
  const child = mode => runtime.children.find(entry => entry.args[0] === mode);
  const latest = channel => messages.filter(message => message.channel === channel).at(-1)?.value;
  const invokeAs = (event, channel, ...args) => {
    assert.ok(handlers.has(channel), `real IPC handler ${channel} registered`);
    return handlers.get(channel)(event, ...args);
  };
  const invoke = (channel, ...args) => invokeAs({
    sender: window.webContents, senderFrame: window.webContents.mainFrame
  }, channel, ...args);
  const harness = {
    ...runtime, app, window, messages, errors, stores, ignored, fsProbes, child, latest, invoke, invokeAs,
    async start({ desktopReady = true } = {}) {
      window.emit('ready-to-show');
      assert.deepEqual(runtime.children.map(entry => entry.args[0]), ['dock', 'guard']);
      if (desktopReady) child('guard').line('READY\t1');
      await settle();
      return harness;
    },
    publish(value = snapshot()) {
      emitSnapshot(child('dock'), value);
      return latest('dock-changed');
    },
    taskbarCommands: () => (child('guard')?.stdin.writes || []).filter(line => /^taskbar-(hide|show|own)\n$/.test(line)),
    assertTaskbar(hidden, message) {
      const mode = hidden === 'own' ? 'own' : hidden ? 'hidden' : 'visible';
      const command = mode === 'own' ? 'taskbar-own\n' : mode === 'hidden' ? 'taskbar-hide\n' : 'taskbar-show\n';
      assert.equal(harness.taskbarCommands().at(-1), command, message);
    },
    async ready() {
      const dock = harness.publish();
      assert.equal((await invoke('dock-ready', dock.revision, true)).ok, true);
      harness.assertTaskbar(true);
      return dock;
    },
    async state() {
      const result = await invoke('bootstrap');
      assert.equal(result.ok, true);
      return plain(result.value);
    }
  };
  return harness;
}

// WindowsBridge: the protocol implementation itself is never replaced.
test('Bridge: owned dock spawn, first snapshot, and repeated 1500ms refresh', t => {
  const h = createBridge(t);
  const child = h.dock;
  assert.equal(child.executable, helperPath);
  assert.deepEqual(child.args, ['dock', String(parentPid)]);
  assert.deepEqual(child.options, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(child.stderr.resumeCalls, 1);
  h.start();
  assert.equal(h.children.length, 1, 'startDock is idempotent while owned helper exists');
  h.tick(9999);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(child.stdin.writes, []);
  const first = snapshot();
  emitSnapshot(child, first);
  assert.deepEqual(h.snapshots, [first]);
  h.tick(1499);
  assert.deepEqual(child.stdin.writes, []);
  h.tick(1);
  assert.deepEqual(child.stdin.writes, ['refresh\n']);
  const second = snapshot({ error: 'still supported' });
  emitSnapshot(child, second);
  h.tick(1500);
  assert.deepEqual(child.stdin.writes, ['refresh\n', 'refresh\n']);
  emitSnapshot(child, first);
  assert.deepEqual(h.snapshots, [first, second, first]);
  assert.deepEqual(h.failures, []);
});

test('Bridge: unsupported empty snapshot is valid and still refreshed', t => {
  const h = createBridge(t);
  const value = snapshot({ supported: false, error: '当前桌面不支持', items: [] });
  emitSnapshot(h.dock, value);
  assert.deepEqual(h.snapshots, [value]);
  h.tick(1500);
  assert.deepEqual(h.dock.stdin.writes, ['refresh\n']);
  assert.deepEqual(h.failures, []);
});

const invalidSnapshots = [
  ['missing supported', value => { delete value.supported; }],
  ['non-boolean supported', value => { value.supported = 1; }],
  ['missing error', value => { delete value.error; }],
  ['non-string error', value => { value.error = null; }],
  ['non-array items', value => { value.items = {}; }],
  ['null item', value => { value.items = [null]; }],
  ['empty item id', value => { value.items[0].id = ''; }],
  ['non-string item id', value => { value.items[0].id = 123; }],
  ['non-string title', value => { value.items[0].title = null; }],
  ['non-string icon', value => { value.items[0].icon = 123; }],
  ['file icon URL', value => { value.items[0].icon = 'file:///C:/Users/owner/private.png'; }],
  ['network icon URL', value => { value.items[0].icon = 'https://example.invalid/icon.png'; }],
  ['malformed inline icon', value => { value.items[0].icon = 'data:image/png;base64,###'; }],
  ['non-boolean running', value => { value.items[0].running = 'true'; }],
  ['non-boolean active', value => { value.items[0].active = 1; }],
  ['non-array windows', value => { value.items[0].windows = null; }],
  ['null window', value => { value.items[0].windows = [null]; }],
  ['empty window id', value => { value.items[0].windows[0].id = ''; }],
  ['non-string window title', value => { value.items[0].windows[0].title = 123; }],
  ['supported empty list', value => { value.items = []; }],
  ['supported missing icon', value => { value.items[0].icon = ''; }],
  ['supported partially complete icons', value => { value.items.push({ ...value.items[0], id: 'app:second', icon: '' }); }]
];
for (const [name, mutate] of invalidSnapshots) {
  test(`Bridge: rejects ${name} and closes only the owned dock helper`, t => {
    const h = createBridge(t);
    const child = h.dock;
    const value = snapshot();
    mutate(value);
    emitSnapshot(child, value);
    assert.deepEqual(h.snapshots, []);
    assert.equal(h.failures.length, 1);
    assert.match(h.failures[0], /应用清单不可用，已保留系统任务栏/);
    if (name.startsWith('supported ')) assert.match(h.failures[0], /应用清单或图标不完整/);
    assert.equal(child.stdin.endCalls.length, 1);
    h.tick(1999);
    assert.equal(child.killCalls, 0);
    h.tick(1);
    assert.equal(child.killCalls, 1);
    h.tick(2999);
    assert.equal(h.children.length, 1, 'no restart before the backoff delay');
    h.tick(1);
    assert.equal(h.children.length, 2, 'a failed dock helper is restarted');
    assert.equal(h.failures.length, 1);
    const retry = h.dock;
    emitSnapshot(retry, snapshot());
    assert.deepEqual(h.snapshots, [snapshot()], 'the restarted helper delivers a usable list');
    assert.deepEqual(child.stdin.writes, []);
  });
}

for (const encoded of ['', base64('{broken'), base64('null')]) {
  test(`Bridge: malformed SNAPSHOT payload ${JSON.stringify(encoded)} fails closed`, t => {
    const h = createBridge(t);
    h.dock.line(`SNAPSHOT\t${encoded}`);
    assert.equal(h.failures.length, 1);
    assert.deepEqual(h.snapshots, []);
    assert.equal(h.dock.stdin.endCalls.length, 1);
  });
}

test('Bridge: first-frame timeout rejects pending activation and ignores late responses', async t => {
  const h = createBridge(t);
  const child = h.dock;
  h.tick(9999);
  assert.deepEqual(h.failures, []);
  const activation = h.bridge.activateDock('app:编辑器');
  const rejected = assert.rejects(activation, /应用清单读取超时/);
  const id = requestFields(child)[1];
  h.tick(1);
  await rejected;
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0], /应用清单读取超时/);
  assert.equal(h.bridge.dockPending.size, 0);
  assert.equal(child.stdin.endCalls.length, 1);
  emitSnapshot(child, snapshot());
  emitResult(child, id);
  assert.deepEqual(h.snapshots, []);
  child.exit(0);
  h.tick(2000);
  assert.equal(child.killCalls, 0, 'normal exit cancels the failure cleanup kill');
  assert.equal(child.stdout.reader.closed, true);
  assert.equal(h.bridge.dock, null);
});

test('Bridge: every refresh requires a fresh snapshot within 10000ms', t => {
  const h = createBridge(t);
  emitSnapshot(h.dock, snapshot());
  h.tick(1500);
  assert.deepEqual(h.dock.stdin.writes, ['refresh\n']);
  h.tick(9999);
  assert.deepEqual(h.failures, []);
  h.tick(1);
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0], /应用清单读取超时/);
  assert.equal(h.dock.stdin.endCalls.length, 1);
});

for (const [name, trigger, pattern] of [
  ['stdin error', child => child.stdin.emit('error', new Error('EPIPE')), /连接中断/],
  ['spawn error', child => child.emit('error', new Error('ENOENT')), /无法启动：ENOENT/],
  ['unexpected exit', child => child.exit(1), /组件已停止/]
]) {
  test(`Bridge: ${name} fails once and rejects all owned requests`, async t => {
    const h = createBridge(t);
    const child = h.dock;
    emitSnapshot(child, snapshot());
    const first = assert.rejects(h.bridge.activateDock('app:编辑器'), pattern);
    const second = assert.rejects(h.bridge.activateDock('hwnd:101'), pattern);
    trigger(child);
    await Promise.all([first, second]);
    assert.equal(h.failures.length, 1);
    assert.match(h.failures[0], pattern);
    assert.equal(h.bridge.dockPending.size, 0);
    assert.equal(child.stdin.endCalls.length, 1);
    child.stdin.emit('error', new Error('late EPIPE'));
    child.emit('error', new Error('late error'));
    child.exit(1);
    h.tick(4999);
    assert.equal(h.failures.length, 1);
    assert.equal(h.children.length, 1, 'no restart before the backoff delay');
    h.tick(1);
    assert.equal(h.children.length, 2, 'an exited dock helper is restarted');
    assert.equal(child.killCalls, 0);
    assert.equal(child.stdout.reader.closed, true);
  });
}

test('Bridge: a throwing snapshot consumer also closes the owned helper', t => {
  const h = createBridge(t, false);
  h.bridge.startDock(() => { throw new Error('consumer failed'); }, message => h.failures.push(message));
  const child = h.bridge.dock;
  emitSnapshot(child, snapshot());
  assert.match(h.failures[0], /consumer failed/);
  assert.equal(child.stdin.endCalls.length, 1);
  h.tick(2000);
  assert.equal(child.killCalls, 1);
});

test('Bridge: activate uses base64 opaque IDs and correlates out-of-order success/error', async t => {
  const h = createBridge(t);
  emitSnapshot(h.dock, snapshot());
  const opaqueId = '窗口:C:\\路径\\app.exe\tRESULT\nrefresh';
  const first = h.bridge.activateDock(opaqueId);
  const firstFields = requestFields(h.dock);
  const second = h.bridge.activateDock('hwnd:101');
  const secondFields = requestFields(h.dock);
  const secondRejected = assert.rejects(second, /激活被拒绝：窗口已关闭/);
  assert.deepEqual(firstFields, ['activate', '1', base64(opaqueId)]);
  assert.deepEqual(secondFields, ['activate', '2', base64('hwnd:101')]);
  assert.equal(h.dock.stdin.writes[0].split('\n').length, 2, 'one command despite embedded separators');
  emitResult(h.dock, 'unknown');
  assert.equal(h.bridge.dockPending.size, 2);
  emitResult(h.dock, secondFields[1], '激活被拒绝：窗口已关闭');
  await secondRejected;
  assert.equal(h.bridge.dockPending.size, 1);
  emitResult(h.dock, firstFields[1]);
  assert.equal(await first, undefined);
  assert.equal(h.bridge.dockPending.size, 0);
  emitResult(h.dock, firstFields[1], 'late failure');
  h.tick(8000);
  assert.deepEqual(h.failures, []);
  assert.equal(h.children.length, 1, 'activation never spawns a user application');
});

test('Bridge: window operations send opaque IDs and correlate success, errors, and timeouts', async t => {
  const h = createBridge(t);
  emitSnapshot(h.dock, snapshot());
  await assert.rejects(h.bridge.windowDock('hwnd:101', 'restore'), /未知的窗口操作/);
  assert.deepEqual(h.dock.stdin.writes, []);
  const opaqueId = '窗口:C:\\路径\\app.exe\tRESULT';
  const close = h.bridge.windowDock(opaqueId, 'close');
  const fields = requestFields(h.dock);
  assert.deepEqual(fields, ['window', '1', base64(opaqueId), 'close']);
  emitResult(h.dock, 'unknown');
  assert.equal(h.bridge.dockPending.size, 1);
  emitResult(h.dock, fields[1], '目标窗口已关闭');
  await assert.rejects(close, /目标窗口已关闭/);
  const timeout = h.bridge.windowDock('hwnd:101', 'minimize');
  const rejected = assert.rejects(timeout, /窗口操作超时，请重试/);
  h.tick(7999);
  await settle();
  assert.equal(h.bridge.dockPending.size, 1);
  h.tick(1);
  await rejected;
  assert.equal(h.bridge.dockPending.size, 0);
  assert.deepEqual(h.failures, []);
});

test('Bridge: activation times out at 8000ms and late results cannot revive it', async t => {
  const h = createBridge(t);
  emitSnapshot(h.dock, snapshot());
  const activation = h.bridge.activateDock('hwnd:101');
  let settled = false;
  const rejected = assert.rejects(activation, /应用切换超时，请使用系统任务栏/).then(() => { settled = true; });
  const id = requestFields(h.dock)[1];
  h.tick(7999);
  await settle();
  assert.equal(settled, false);
  assert.equal(h.bridge.dockPending.size, 1);
  h.tick(1);
  await rejected;
  assert.equal(h.bridge.dockPending.size, 0);
  emitResult(h.dock, id);
  assert.deepEqual(h.failures, []);
  assert.equal(h.dock.stdin.endCalls.length, 0, 'request timeout alone does not stop discovery');
});

test('Bridge: unavailable, failed, exited, and stopping docks reject activation without writes', async t => {
  const h = createBridge(t, false);
  await assert.rejects(h.bridge.activateDock('x'), /应用清单不可用/);
  assert.equal(h.children.length, 0);
  h.start();
  const child = h.bridge.dock;
  child.stdin.emit('error', new Error('EPIPE'));
  await assert.rejects(h.bridge.activateDock('x'), /应用清单不可用/);
  child.exit(0);
  await assert.rejects(h.bridge.activateDock('x'), /应用清单不可用/);
  await h.bridge.stop();
  await assert.rejects(h.bridge.activateDock('x'), /应用清单不可用/);
  assert.deepEqual(child.stdin.writes, []);
  assert.throws(() => h.start(), /应用正在退出/);
  assert.throws(() => h.bridge.startIcons(), /应用正在退出/);
  assert.throws(() => h.bridge.takeDesktop(), /应用正在退出/);
  assert.equal(h.children.length, 1);
});

test('Bridge: unknown protocol text cannot write arbitrary paths or extend the snapshot deadline', t => {
  const h = createBridge(t);
  const filename = 'C:\\Users\\owner\\Desktop\\must-not-exist.txt';
  h.tick(9999);
  for (const line of [`WRITE\t${filename}\t${base64('contents')}`, `open\t${filename}`, 'RESULT\tunknown\t', 'noise']) {
    h.dock.line(line);
  }
  assert.deepEqual(h.dock.stdin.writes, []);
  assert.deepEqual(h.snapshots, []);
  assert.equal(h.children.length, 1);
  h.tick(1);
  assert.match(h.failures[0], /应用清单读取超时/);
  assert.deepEqual(h.forbiddenCalls, []);
});

test('Bridge: icon paths are base64 stdin data, not filesystem or shell operations', async t => {
  const h = createBridge(t, false);
  const filename = 'C:\\目录\\app.exe\tunsafe\nwrite';
  const icon = h.bridge.getIcon(filename);
  const child = h.bridge.icons;
  assert.equal(child.executable, helperPath);
  assert.deepEqual(child.args, ['icons']);
  assert.deepEqual(child.stdin.writes, [`1\t${base64(filename)}\n`]);
  child.line('1\taWNvbg==');
  assert.equal(await icon, png);
  h.tick(15000);
  assert.equal(h.bridge.pending.size, 0);
  assert.equal(child.stdin.endCalls.length, 0);
  assert.deepEqual(h.forbiddenCalls, []);
});

for (const receivedSnapshot of [false, true]) {
  test(`Bridge: stop cancels ${receivedSnapshot ? 'refresh' : 'first-frame'} timer and suppresses failure callback`, async t => {
    const h = createBridge(t);
    const child = h.dock;
    if (receivedSnapshot) emitSnapshot(child, snapshot());
    const stopped = h.bridge.stop();
    assert.equal(child.stdin.endCalls.length, 1);
    h.tick(1999);
    assert.equal(child.killCalls, 0);
    h.tick(1);
    await stopped;
    assert.equal(child.killCalls, 1);
    child.exit(0);
    h.tick(20000);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(child.stdin.writes, []);
    assert.equal(child.stdout.reader.closed, true);
  });
}

test('Bridge: stop restores the mock guard and waits for all three owned helpers', async t => {
  const h = createBridge(t);
  emitSnapshot(h.dock, snapshot());
  const taken = h.bridge.takeDesktop(() => assert.fail('intentional guard stop is not unexpected'));
  const guard = h.bridge.guard;
  guard.line('READY\t1');
  assert.deepEqual(plain(await taken), { active: true, originalVisible: true });
  const iconRejected = assert.rejects(h.bridge.getIcon('C:\\not-read.exe'), /图标组件已停止/);
  const activationRejected = assert.rejects(h.bridge.activateDock('hwnd:101'), /应用清单组件已停止/);
  const icon = h.bridge.icons;
  const dock = h.dock;
  let done = false;
  const stopped = h.bridge.stop().then(() => { done = true; });
  assert.deepEqual(guard.stdin.endCalls, ['restore\n']);
  assert.equal(icon.stdin.endCalls.length, 1);
  assert.equal(dock.stdin.endCalls.length, 1);
  dock.exit(0);
  icon.exit(0);
  await Promise.all([iconRejected, activationRejected]);
  assert.equal(done, false, 'guard restoration must complete before stop resolves');
  guard.exit(0);
  await stopped;
  h.tick(20000);
  assert.deepEqual(h.failures, []);
  assert.equal(h.bridge.pending.size, 0);
  assert.equal(h.bridge.dockPending.size, 0);
  assert.ok(h.children.every(child => child.killCalls === 0 && child.stdout.reader.closed));
  assert.deepEqual(h.children.map(child => child.executable), [helperPath, helperPath, helperPath]);
});

test('Bridge: shutdown may kill owned icon/dock helpers but never kills the restoring guard', async t => {
  const h = createBridge(t);
  h.bridge.startIcons();
  const taken = h.bridge.takeDesktop();
  const guard = h.bridge.guard;
  guard.line('READY\t0');
  await taken;
  const dock = h.dock;
  const icon = h.bridge.icons;
  const rejected = assert.rejects(h.bridge.stop(), /桌面恢复仍在进行/);
  h.tick(2000);
  assert.equal(dock.killCalls, 1);
  assert.equal(icon.killCalls, 1);
  assert.equal(guard.killCalls, 0);
  h.tick(4000);
  await rejected;
  assert.deepEqual(guard.stdin.endCalls, ['restore\n']);
  assert.equal(guard.killCalls, 0);
  assert.deepEqual(h.failures, []);
});

// main.cjs integration: real IPC/event handlers AND the real WindowsBridge,
// including non-testMode paths. Only OS/Electron/persistence boundaries are fake.
test('main: only current revision with rendered === true and an active desktop can hide', async t => {
  const h = await createMain(t);
  await h.start({ desktopReady: false });
  const dock = h.publish();
  assert.equal(dock.revision, 1);
  assert.equal((await h.invoke('dock-ready', dock.revision, true)).ok, true);
  assert.ok(!h.taskbarCommands().includes('taskbar-hide\n'));
  h.child('guard').line('READY\t1');
  await settle();
  h.assertTaskbar(true);
  assert.deepEqual(h.fsProbes, ['C:\\isolated-test\\Desktop']);
  assert.equal(h.stores[0].directory, 'C:\\isolated-test\\data');
  assert.deepEqual(h.children.map(child => child.args), [['dock', String(parentPid)], ['guard', String(parentPid)]]);
});

test('main: stale, future, unsafe, and non-numeric revisions cannot hide or cancel the current gate', async t => {
  const h = await createMain(t);
  await h.start();
  const old = h.publish();
  const current = h.publish(snapshot({ error: 'changed' }));
  assert.equal(current.revision, old.revision + 1);
  for (const revision of [old.revision, 0, -1, 1.5, String(current.revision), current.revision + 1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    const result = await h.invoke('dock-ready', revision, true);
    assert.equal(result.ok, true);
    h.assertTaskbar(false);
  }
  assert.equal((await h.state()).dock.revision, current.revision);
  assert.ok(!h.taskbarCommands().includes('taskbar-hide\n'));
  await h.invoke('dock-ready', current.revision, true);
  h.assertTaskbar(true);
});

test('main: duplicate snapshots keep the revision and do not rearm an acknowledged gate', async t => {
  const h = await createMain(t);
  await h.start();
  const current = await h.ready();
  const count = h.messages.filter(message => message.channel === 'dock-changed').length;
  h.publish();
  assert.equal(h.messages.filter(message => message.channel === 'dock-changed').length, count);
  assert.equal((await h.state()).dock.revision, current.revision);
  h.tick(3000);
  h.assertTaskbar(true);
});

test('main: stale ack cannot cancel the 3000ms gate for a changed supported snapshot', async t => {
  const h = await createMain(t);
  await h.start();
  const old = await h.ready();
  const current = h.publish(snapshot({ error: 'new revision' }));
  h.tick(2999);
  await h.invoke('dock-ready', old.revision, true);
  h.assertTaskbar(true, 'existing dock has a bounded grace period');
  h.tick(1);
  h.assertTaskbar(false);
  await h.invoke('dock-ready', old.revision, true);
  h.assertTaskbar(false);
  await h.invoke('dock-ready', current.revision, true);
  h.assertTaskbar(true);
});

test('main: unsupported snapshots cannot hide, and becoming unsupported shows immediately', async t => {
  const h = await createMain(t);
  await h.start();
  let current = h.publish(snapshot({ supported: false, error: 'unsupported shell', items: [] }));
  await h.invoke('dock-ready', current.revision, true);
  h.assertTaskbar(false);
  assert.ok(!h.taskbarCommands().includes('taskbar-hide\n'));
  await h.ready();
  current = h.publish(snapshot({ supported: false, error: 'lost support', items: [] }));
  h.assertTaskbar(false);
  await h.invoke('dock-ready', current.revision, true);
  h.assertTaskbar(false);
  assert.equal(h.latest('taskbar-state').error, 'lost support');
});

test('main: transient shell inconsistencies are debounced and recover silently', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  const transient = { supported: false, error: '任务栏镜像暂不可用：任务栏按钮数量正在变化，请刷新后重试', items: [] };
  h.publish(transient);
  h.assertTaskbar(true, 'one bad sample keeps the working mirror');
  h.publish(transient);
  h.assertTaskbar(true);
  assert.equal(h.latest('dock-changed').supported, true);
  h.publish(snapshot());
  h.assertTaskbar(true);
  h.publish(transient);
  h.publish(transient);
  h.assertTaskbar(true, 'the failure counter resets after a good sample');
  h.publish(transient);
  h.assertTaskbar(false, 'a persistent inconsistency restores the system taskbar');
  assert.match(h.latest('dock-changed').error, /数量正在变化/);
});

for (const rendered of [undefined, false, 0, 1, 'true', {}, []]) {
  test(`main: rendered=${JSON.stringify(rendered)} is not an icon decode acknowledgement`, async t => {
    const h = await createMain(t);
    await h.start();
    const dock = h.publish();
    await h.invoke('dock-ready', dock.revision, rendered);
    h.assertTaskbar(false);
    assert.ok(!h.taskbarCommands().includes('taskbar-hide\n'));
    assert.match(h.latest('taskbar-state').error, /图标未完整显示/);
    await h.invoke('dock-ready', dock.revision, true);
    h.assertTaskbar(false, 'a recorded taskbar error is a fail-safe latch');
  });
}

test('main: an explicit failed decode acknowledgement immediately restores a hidden taskbar', async t => {
  const h = await createMain(t);
  await h.start();
  const dock = await h.ready();
  await h.invoke('dock-ready', dock.revision, false);
  h.assertTaskbar(false);
  assert.match(h.latest('taskbar-state').error, /图标未完整显示/);
});

for (const [name, fail] of [
  ['incomplete supported snapshot', child => emitSnapshot(child, snapshot({ items: [] }))],
  ['malformed snapshot', child => child.line('SNAPSHOT\t!')],
  ['helper exit', child => child.exit(1)],
  ['helper stdin failure', child => child.stdin.emit('error', new Error('EPIPE'))]
]) {
  test(`main: ${name} immediately requests show without another renderer ack`, async t => {
    const h = await createMain(t);
    await h.start();
    await h.ready();
    fail(h.child('dock'));
    h.assertTaskbar(false);
    const state = await h.state();
    assert.equal(state.dock.supported, false);
    assert.ok(state.dock.error);
    assert.equal(state.taskbarState.error, state.dock.error);
    assert.equal(h.child('guard').killCalls, 0);
  });
}

test('main: a missing refresh restores the taskbar through the real Bridge failure callback', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  h.tick(1500);
  assert.ok(h.child('dock').stdin.writes.includes('refresh\n'));
  h.tick(9999);
  h.assertTaskbar(true);
  h.tick(1);
  h.assertTaskbar(false);
  assert.match(h.latest('dock-changed').error, /应用清单读取超时/);
});

test('main: minimize shows only QX, restore/hide and second-instance stay synchronized', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  await h.invoke('window-action', 'minimize');
  h.assertTaskbar('own', 'minimizing keeps only the QX taskbar entry');
  h.window.restore();
  h.assertTaskbar(true);
  h.window.hide();
  h.assertTaskbar(false);
  h.window.show();
  h.assertTaskbar(true);
  h.window.minimize();
  h.assertTaskbar('own');
  h.app.emit('second-instance');
  h.assertTaskbar(true);
  assert.equal(h.window.focusCalls, 1);
  assert.deepEqual(h.taskbarCommands(), [
    'taskbar-show\n', 'taskbar-hide\n', 'taskbar-own\n', 'taskbar-hide\n',
    'taskbar-show\n', 'taskbar-hide\n', 'taskbar-own\n', 'taskbar-hide\n'
  ]);
});

test('main: a minimized window keeps the QX-only taskbar through gate timeouts', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  h.window.minimize();
  h.assertTaskbar('own');
  const changed = h.publish(snapshot({ error: 'changed while minimized' }));
  h.tick(3000);
  h.tick(5000);
  h.assertTaskbar('own', 'the 3000ms dock gate must not reveal every icon while minimized');
  await h.invoke('dock-ready', changed.revision, false);
  h.assertTaskbar('own', 'a failed decode acknowledgement cannot reveal every icon while minimized');
  h.window.restore();
  h.assertTaskbar(true, 'restoring validates the dock again and hides the system icons');
});

test('main: autostart is readable, writable, and validated through the real IPC bridge', async t => {
  const h = await createMain(t);
  await h.start();
  let result = await h.invoke('autostart-get');
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.value), { enabled: false, supported: true });
  result = await h.invoke('autostart-set', true);
  assert.equal(result.ok, true);
  assert.equal(result.value.enabled, true);
  assert.equal(h.app.loginItems.at(-1).path, process.execPath);
  assert.equal(h.app.loginItems.at(-1).openAtLogin, true);
  result = await h.invoke('autostart-set', 'yes');
  assert.equal(result.ok, false);
  assert.match(result.error, /无效/);
  result = await h.invoke('autostart-set', false);
  assert.equal(result.value.enabled, false);
  assert.deepEqual(plain((await h.invoke('autostart-get')).value), { enabled: false, supported: true });
});

test('main: renderer reload shows immediately and needs another true render acknowledgement', async t => {
  const h = await createMain(t);
  await h.start();
  const dock = await h.ready();
  h.window.webContents.emit('did-start-loading');
  h.assertTaskbar(false);
  h.window.hide();
  h.window.show();
  h.assertTaskbar(false);
  h.publish();
  h.assertTaskbar(false);
  await h.invoke('dock-ready', dock.revision, true);
  h.assertTaskbar(true);
  assert.equal(h.children.length, 2, 'reload must not restart the helpers');
});

test('main: unresponsive renderer shows; responsive notification alone does not hide', async t => {
  const h = await createMain(t);
  await h.start();
  const dock = await h.ready();
  h.window.emit('unresponsive');
  h.assertTaskbar(false);
  const count = h.messages.filter(message => message.channel === 'dock-changed').length;
  h.window.emit('responsive');
  assert.equal(h.messages.filter(message => message.channel === 'dock-changed').length, count + 1);
  assert.equal(h.latest('dock-changed').revision, dock.revision);
  h.assertTaskbar(false);
  await h.invoke('dock-ready', dock.revision, true);
  h.assertTaskbar(true);
});

test('main: authorized app/window IDs activate only through the Bridge base64 protocol', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  for (const id of ['app:编辑器', 'hwnd:101']) {
    const pending = h.invoke('dock-activate', id);
    const fields = requestFields(h.child('dock'));
    assert.equal(fields[0], 'activate');
    assert.equal(fields[2], base64(id));
    emitResult(h.child('dock'), fields[1]);
    assert.equal((await pending).ok, true);
    h.assertTaskbar(true);
  }
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.forbiddenCalls, []);
});

test('main: window operations accept only current window IDs and known actions', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  for (const [id, action] of [['hwnd:101', 'maximize'], ['hwnd:101', 'minimize'], ['app:编辑器', 'close']]) {
    const pending = h.invoke('dock-window', id, action);
    const fields = requestFields(h.child('dock'));
    assert.equal(fields[0], 'window');
    assert.equal(fields[2], base64(id));
    assert.equal(fields[3], action);
    emitResult(h.child('dock'), fields[1]);
    assert.equal((await pending).ok, true);
  }
  for (const [id, action] of [['hwnd:999', 'close'], ['hwnd:101', 'restore'], [42, 'close']]) {
    assert.equal((await h.invoke('dock-window', id, action)).ok, false);
  }
  h.assertTaskbar(true);
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.forbiddenCalls, []);
});

for (const mode of ['error', 'timeout']) {
  test(`main: activation ${mode} pauses hiding only until the next successful switch`, async t => {
    const h = await createMain(t);
    await h.start();
    await h.ready();
    h.child('guard').line('TASKBAR\t1\t');
    const pending = h.invoke('dock-activate', 'hwnd:101');
    const id = requestFields(h.child('dock'))[1];
    if (mode === 'error') emitResult(h.child('dock'), id, '窗口已经关闭');
    else h.tick(8000);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error, mode === 'error' ? /窗口已经关闭/ : /应用切换超时/);
    h.assertTaskbar(false);
    assert.equal(h.latest('taskbar-state').hidden, false);
    assert.match(h.latest('taskbar-state').error, /系统任务栏已暂时显示，下次切换成功后自动隐藏/);
    // Fresh snapshots and rendered acknowledgements must not end the pause...
    const refreshed = h.publish(snapshot());
    await h.invoke('dock-ready', refreshed.revision, true);
    h.assertTaskbar(false);
    assert.match(h.latest('taskbar-state').error, /系统任务栏已暂时显示/);
    // ...only the next successful switch does.
    const retry = h.invoke('dock-activate', 'hwnd:101');
    emitResult(h.child('dock'), requestFields(h.child('dock'))[1]);
    assert.equal((await retry).ok, true);
    h.assertTaskbar(true, 'a successful switch resumes hiding');
    assert.equal(h.latest('taskbar-state').error, '');
    assert.equal(h.child('dock').stdin.endCalls.length, 0);
  });
}

test('main: arbitrary paths and stale IDs cannot activate, write files, or spawn applications', async t => {
  const h = await createMain(t);
  await h.start();
  h.publish();
  const before = [...h.child('dock').stdin.writes];
  for (const id of ['C:\\Users\\owner\\Desktop\\arbitrary.exe', '..\\..\\write.txt\nrefresh', 'hwnd:999', '', null, {}, 123]) {
    const result = await h.invoke('dock-activate', id);
    assert.equal(result.ok, false);
    assert.match(result.error, /应用入口已失效/);
  }
  h.publish(snapshot({ items: [{ ...snapshot().items[0], id: 'replacement', windows: [] }] }));
  const stale = await h.invoke('dock-activate', 'hwnd:101');
  assert.equal(stale.ok, false);
  assert.deepEqual(h.child('dock').stdin.writes, before);
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.forbiddenCalls, []);
});

test('main: removing an entry remembers the path for the next desktop import', async t => {
  const h = await createMain(t);
  await h.start();
  const store = h.stores[0];
  const saves = store.saves;
  store.state.categories = [{ id: 'documents', name: '工作文档' }];
  store.state.items = [{ id: 'entry-1', name: 'a.txt', path: 'C:\\Users\\owner\\Desktop\\a.txt', categoryId: 'documents' }];
  const result = await h.invoke('item-action', 'entry-1', 'remove');
  assert.equal(result.ok, true);
  assert.deepEqual(plain(store.state.items), []);
  assert.deepEqual(h.ignored, ['C:\\Users\\owner\\Desktop\\a.txt']);
  assert.equal(store.saves, saves + 1);
});

test('main: foreign webContents and subframes cannot acknowledge or activate the dock', async t => {
  const h = await createMain(t);
  await h.start();
  const dock = h.publish();
  for (const event of [
    { sender: {}, senderFrame: h.window.webContents.mainFrame },
    { sender: h.window.webContents, senderFrame: {} }
  ]) {
    for (const [channel, args] of [['dock-ready', [dock.revision, true]], ['dock-activate', ['hwnd:101']]]) {
      const result = await h.invokeAs(event, channel, ...args);
      assert.equal(result.ok, false);
      assert.match(result.error, /拒绝未授权/);
    }
  }
  h.assertTaskbar(false);
  assert.deepEqual(h.child('dock').stdin.writes, []);
});

test('main: guard TASKBAR error restores visibility and remains fail-safe on later acks', async t => {
  const h = await createMain(t);
  await h.start();
  const dock = await h.ready();
  h.child('guard').line(`TASKBAR\t0\t${base64('任务栏控制失败')}`);
  h.assertTaskbar(false);
  assert.equal(h.latest('taskbar-state').hidden, false);
  assert.equal(h.latest('taskbar-state').error, '任务栏控制失败');
  await h.invoke('dock-ready', dock.revision, true);
  h.window.minimize();
  h.window.restore();
  h.assertTaskbar(false);
});

test('main: unexpected guard exit invalidates desktop readiness without restarting a helper', async t => {
  const h = await createMain(t);
  await h.start();
  const dock = await h.ready();
  const guard = h.child('guard');
  guard.exit(1);
  const state = await h.state();
  assert.equal(state.desktopState.active, false);
  assert.match(state.desktopState.error, /桌面恢复组件已停止/);
  assert.equal(state.taskbarState.hidden, false);
  const commands = [...h.taskbarCommands()];
  await h.invoke('dock-ready', dock.revision, true);
  h.window.minimize();
  h.window.restore();
  assert.deepEqual(h.taskbarCommands(), commands, 'no writes to an exited guard');
  assert.equal(h.children.length, 2);
});

test('main: failed desktop takeover never hides despite a supported acknowledged dock', async t => {
  const h = await createMain(t);
  await h.start({ desktopReady: false });
  const dock = h.publish();
  await h.invoke('dock-ready', dock.revision, true);
  h.child('guard').emit('error', new Error('guard unavailable'));
  await settle();
  const state = await h.state();
  assert.equal(state.desktopState.active, false);
  assert.match(state.desktopState.error, /guard unavailable/);
  assert.ok(!h.taskbarCommands().includes('taskbar-hide\n'));
});

for (const finish of ['close-ready', 'timeout', 'renderer-gone']) {
  test(`main: ${finish} restores and stops owned helpers; close/reload never restart them`, async t => {
    const h = await createMain(t);
    await h.start();
    const dock = await h.ready();
    let finished;
    if (finish === 'renderer-gone') {
      h.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    } else {
      await h.invoke('window-action', 'close');
      assert.equal(h.window.destroyed, false, 'first close waits for renderer/persistence');
      assert.ok(h.messages.some(message => message.channel === 'prepare-close'));
      h.assertTaskbar(false);
      await h.invoke('dock-ready', dock.revision, true);
      h.assertTaskbar(false, 'closeTimer blocks a late decode acknowledgement');
      assert.equal(h.child('dock').stdin.endCalls.length, 0);
      if (finish === 'close-ready') finished = h.invoke('close-ready');
      else {
        h.tick(4999);
        assert.equal(h.child('dock').stdin.endCalls.length, 0);
        h.tick(1);
      }
    }
    h.assertTaskbar(false);
    assert.equal(h.child('dock').stdin.endCalls.length, 1);
    assert.deepEqual(h.child('guard').stdin.endCalls, ['restore\n']);
    assert.equal(h.window.destroyed, false, 'native restoration must finish before destruction');
    const revision = h.latest('dock-changed').revision;
    h.publish(snapshot({ error: 'late snapshot during finalizing' }));
    assert.equal(h.latest('dock-changed').revision, revision);
    await h.invoke('dock-ready', dock.revision, true);
    h.window.minimize();
    h.app.emit('second-instance');
    h.window.webContents.emit('did-start-loading');
    h.assertTaskbar(false);
    h.child('dock').exit(0);
    h.child('guard').exit(0);
    if (finished) assert.equal((await finished).ok, true);
    await settle();
    assert.equal(h.window.destroyed, true);
    assert.equal(h.stores[0].flushes, 1);
    assert.equal(h.app.quitCalls, 1);
    h.window.emit('ready-to-show');
    h.window.webContents.emit('did-start-loading');
    h.window.webContents.emit('render-process-gone');
    h.app.emit('second-instance');
    h.tick(20000);
    assert.equal(h.children.length, 2);
    assert.deepEqual(h.errors, []);
    assert.ok(h.children.every(child => child.killCalls === 0));
  });
}

test('main: pending close must also block a late ready-to-show takeover', async t => {
  const h = await createMain(t);
  h.window.close();
  assert.ok(h.messages.some(message => message.channel === 'prepare-close'));
  assert.equal(h.window.destroyed, false);
  assert.equal(h.children.length, 0);
  h.window.emit('ready-to-show');
  assert.equal(h.children.length, 0, 'do not start dock/guard while waiting for close-ready');
});

test('main: finalized close before ready-to-show cannot start dock or guard later', async t => {
  const h = await createMain(t);
  h.window.close();
  const finished = await h.invoke('close-ready');
  assert.equal(finished.ok, true);
  assert.equal(h.window.destroyed, true);
  h.window.emit('ready-to-show');
  h.tick(20000);
  assert.equal(h.children.length, 0);
  assert.equal(h.app.quitCalls, 1);
});

test('main: guard restoration failure is reported, not hidden by another takeover', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  h.window.close();
  const finished = h.invoke('close-ready');
  h.child('dock').exit(0);
  h.child('guard').exit(1);
  assert.equal((await finished).ok, true);
  assert.equal(h.window.destroyed, true);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].title, '桌面恢复提示');
  assert.match(h.errors[0].message, /桌面恢复组件异常退出/);
  assert.equal(h.children.length, 2);
});

test('main: embed attaches only dock-provided windows with physical bounds and restores them through the guard', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  const dock = h.publish(snapshot());
  assert.equal(dock.items[0].windows[0].hwnd, 101);
  const bounds = { x: 10, y: 20, width: 300, height: 200 };
  const attach = h.invoke('embed-attach', 'app:编辑器', 'hwnd:101', bounds);
  await settle();
  const guard = h.child('guard');
  const attachFields = requestFields(guard);
  assert.equal(attachFields[0], 'embed-attach');
  assert.deepEqual(attachFields.slice(2), ['101', '220', '440', '820', '840']);
  const writes = guard.stdin.writes.length;
  assert.equal((await h.invoke('embed-attach', 'app:编辑器', 'hwnd:101', bounds)).ok, false, 'the same window cannot be embedded twice');
  assert.equal((await h.invoke('embed-attach', 'app:其他', '', bounds)).ok, false, 'unknown entries are rejected');
  assert.equal(guard.stdin.writes.length, writes, 'rejected requests never reach the guard');
  guard.line(`EMBED\t${attachFields[1]}\t1\t${base64('')}`);
  const attached = await attach;
  assert.equal(attached.ok, true);
  assert.equal(attached.value.title, '文档一');
  assert.equal(attached.value.icon, png);
  const tab = attached.value;
  await h.invoke('embed-bounds', tab.id, { x: 5, y: 6, width: 100, height: 80 });
  const boundsFields = requestFields(guard);
  assert.equal(boundsFields[0], 'embed-bounds');
  assert.deepEqual(boundsFields.slice(2), ['101', '210', '412', '410', '572']);
  await h.invoke('embed-hide', tab.id);
  assert.equal(requestFields(guard)[0], 'embed-hide');
  await h.invoke('embed-show', tab.id);
  assert.equal(requestFields(guard)[0], 'embed-show');
  const detach = h.invoke('embed-detach', tab.id);
  await settle();
  const detachFields = requestFields(guard);
  assert.equal(detachFields[0], 'embed-detach');
  assert.deepEqual(detachFields.slice(2), ['101']);
  guard.line(`EMBED\t${detachFields[1]}\t1\t${base64('')}`);
  assert.equal((await detach).ok, true);
  await h.invoke('embed-show', tab.id);
  assert.equal(guard.stdin.writes.at(-1).trimEnd().split('\t')[0], 'embed-detach', 'a closed tab is never shown again');
});

test('main: unsupported windows surface the guard message and lost windows close their tab', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  h.publish(snapshot());
  const bounds = { x: 1, y: 2, width: 200, height: 150 };
  const failed = h.invoke('embed-attach', 'app:编辑器', 'hwnd:101', bounds);
  await settle();
  const failedFields = requestFields(h.child('guard'));
  h.child('guard').line(`EMBED\t${failedFields[1]}\t0\t${base64('该应用不允许窗口内嵌，已保留原窗口')}`);
  const rejected = await failed;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, '该应用不允许窗口内嵌，已保留原窗口');
  const retry = h.invoke('embed-attach', 'app:编辑器', 'hwnd:101', bounds);
  await settle();
  const fields = requestFields(h.child('guard'));
  h.child('guard').line(`EMBED\t${fields[1]}\t1\t${base64('')}`);
  const tab = (await retry).value;
  h.child('guard').line(`EMBED-LOST\t101\t${base64('应用窗口已关闭，已退出内嵌')}`);
  assert.deepEqual(h.latest('embed-lost'), { id: tab.id, reason: '应用窗口已关闭，已退出内嵌' });
});

test('main: guard exit clears embedded tabs so no floating window is left behind', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  h.publish(snapshot());
  const attach = h.invoke('embed-attach', 'app:编辑器', 'hwnd:101', { x: 0, y: 0, width: 200, height: 150 });
  await settle();
  const fields = requestFields(h.child('guard'));
  h.child('guard').line(`EMBED\t${fields[1]}\t1\t${base64('')}`);
  const tab = (await attach).value;
  h.child('guard').exit(1);
  assert.deepEqual(h.latest('embed-lost'), { id: tab.id, reason: '桌面恢复组件已停止，请检查桌面图标显示状态' });
});

test('main: shell attention flashes reach the matching embedded tab', async t => {
  const h = await createMain(t);
  await h.start();
  await h.ready();
  h.publish(snapshot());
  const attach = h.invoke('embed-attach', 'app:编辑器', 'hwnd:101', { x: 0, y: 0, width: 200, height: 150 });
  await settle();
  const fields = requestFields(h.child('guard'));
  h.child('guard').line(`EMBED\t${fields[1]}\t1\t${base64('')}`);
  const tab = (await attach).value;
  h.child('guard').line('EMBED-FLASH\t999\t1');
  assert.equal(h.latest('embed-flash'), undefined, 'other windows never reach the renderer');
  h.child('guard').line('EMBED-FLASH\t101\t1');
  assert.deepEqual(h.latest('embed-flash'), { id: tab.id, flashing: true });
  h.child('guard').line('EMBED-FLASH\t101\t0');
  assert.deepEqual(h.latest('embed-flash'), { id: tab.id, flashing: false });
  h.child('guard').line('EMBED-FLASH\tinvalid\t1');
  assert.equal(h.latest('embed-flash').flashing, false, 'malformed handles are ignored');
});

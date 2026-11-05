const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, screen, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, addPaths, ignorePath, normalizeUrl, resolveDataDirectory, relocateStore } = require('./core.cjs');
const { WindowsBridge } = require('./windows.cjs');

app.setName('QX桌面');
app.setPath('userData', !app.isPackaged && process.env.HARBOR_DATA_DIR ? path.resolve(process.env.HARBOR_DATA_DIR) : path.join(app.getPath('appData'), 'DesktopHarbor'));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let window;
let browser;
let store;
let browserBounds;
let browserVisible = true;
let browserZoom = 100;
const browserZoomSteps = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
let closing = false;
let finalizing = false;
let closeTimer;
let desktopState = { active: false };
let dock = { supported: false, error: '', items: [], revision: 0 };
let dockSignature = '';
let dockReady = false;
let dockReadyTimer;
let taskbarState = { hidden: false, error: '' };
let taskbarError = '';
let taskbarPaused = false;
let taskbarRetryTimer;
const testMode = !app.isPackaged && process.env.HARBOR_TEST_MODE === '1';
const native = new WindowsBridge(app.isPackaged ? path.join(process.resourcesPath, 'native', 'QXDesktopBridge.exe') : path.join(__dirname, '..', 'assets', 'QXDesktopBridge.exe'));
const iconCache = new Map();
// Native windows currently shown as tabs: id -> { hwnd, title, icon, bounds, shown, dockId, windowId }.
// The guard restores every window on exit; this map only mirrors the renderer tabs.
const embeds = new Map();
const pendingEmbeds = new Set();
let testAutostart = false;
// Portable builds run from a temporary extraction folder, so login items must
// point at the original portable EXE rather than process.execPath.
const loginItemPath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}
function changed() {
  store.saveSoon(() => send('storage-error', '保存失败，请检查磁盘空间和数据目录权限'));
  send('state-changed', store.state);
}
function syncTaskbar() {
  const minimized = Boolean(window && !window.isDestroyed() && window.isMinimized());
  // A minimized window cannot re-render the dock, so its readiness gate must not
  // turn the taskbar back on; QX alone must stay reachable while minimized.
  const ready = !testMode && !closing && !finalizing && !closeTimer && !taskbarError && !taskbarPaused && desktopState.active && dock.supported && (dockReady || minimized) && window && !window.isDestroyed();
  // Only QX stays reachable from the taskbar while minimized; every app icon
  // returns on exit, and the full bar returns whenever takeover is unavailable.
  const mode = !ready ? 'visible' : window.isMinimized() ? 'own' : window.isVisible() ? 'hidden' : 'visible';
  native.setTaskbarMode(mode);
}
function updateTaskbarState(value) {
  if (value.error) {
    taskbarError = value.error;
    scheduleTaskbarRetry();
  }
  const error = taskbarError || dock.error || (taskbarPaused ? taskbarState.error : '');
  taskbarState = { hidden: value.hidden, error };
  send('taskbar-state', taskbarState);
  if (value.error) syncTaskbar();
}
function scheduleTaskbarRetry() {
  if (taskbarRetryTimer || closing || finalizing) return;
  // A single shell/UIA hiccup only pauses the takeover; retry so a transient
  // failure cannot leave every taskbar icon visible for the rest of the session.
  taskbarRetryTimer = setTimeout(() => {
    taskbarRetryTimer = undefined;
    if (closing || finalizing) return;
    taskbarError = '';
    taskbarState = { hidden: taskbarState.hidden, error: taskbarPaused ? taskbarState.error : dock.error || '' };
    send('taskbar-state', taskbarState);
    syncTaskbar();
  }, 5000);
}
function pauseTaskbar(message) {
  taskbarPaused = true;
  taskbarState = { hidden: false, error: message };
  send('taskbar-state', taskbarState);
  syncTaskbar();
}
function resumeTaskbar() {
  if (!taskbarPaused) return;
  taskbarPaused = false;
  taskbarState = { hidden: taskbarState.hidden, error: taskbarError || dock.error || '' };
  send('taskbar-state', taskbarState);
  syncTaskbar();
}
function resetDockReady() {
  clearTimeout(dockReadyTimer);
  dockReadyTimer = undefined;
  dockReady = false;
  syncTaskbar();
}
let dockFailures = 0;
function updateDock(value) {
  const signature = JSON.stringify(value);
  if (closing || finalizing) return;
  const transient = /任务栏镜像暂不可用|正在变化|未匹配任务栏的窗口|不能确认镜像完整|无法完整枚举/.test(value.error || '');
  if (!value.supported && dock.supported && transient) {
    // Opening a tray flyout or an app's image window can make one shell sample
    // inconsistent. Hold the last working mirror unless the failure persists.
    if (++dockFailures < 3) return;
  } else dockFailures = 0;
  if (signature === dockSignature) return;
  dockSignature = signature;
  dock = { ...value, revision: dock.revision + 1 };
  if (!dock.supported) resetDockReady();
  else if (!dockReadyTimer) dockReadyTimer = setTimeout(() => {
    dockReadyTimer = undefined;
    if (window && !window.isDestroyed() && window.isMinimized()) return;
    resetDockReady();
  }, 3000);
  send('dock-changed', dock);
  updateTaskbarState({ hidden: taskbarState.hidden });
}
function browserState(extra = {}) {
  if (!browser || browser.webContents.isDestroyed()) return;
  const contents = browser.webContents;
  send('browser-state', { url: contents.getURL(), loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), zoom: browserZoom, ...extra });
}
function applyBrowserZoom(action) {
  if (action === 'reset') browserZoom = 100;
  else {
    const index = browserZoomSteps.findIndex(step => step >= browserZoom);
    const current = index === -1 ? browserZoomSteps.length - 1 : index;
    browserZoom = browserZoomSteps[Math.max(0, Math.min(browserZoomSteps.length - 1, current + (action === 'in' ? 1 : -1)))];
  }
  if (browser && !browser.webContents.isDestroyed()) browser.webContents.setZoomFactor(browserZoom / 100);
  send('browser-state', { zoom: browserZoom });
  return browserZoom;
}
function positionBrowser() {
  if (!browser || !browserBounds || !window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const x = Math.max(0, Math.min(width, Math.round(browserBounds.x)));
  const y = Math.max(0, Math.min(height, Math.round(browserBounds.y)));
  browser.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(browserBounds.width))), height: Math.max(0, Math.min(height - y, Math.round(browserBounds.height))) });
  browser.setVisible(browserVisible && browserBounds.width > 10 && browserBounds.height > 10);
}
// The renderer reports CSS pixels inside the content area; the guard positions
// real windows in physical screen pixels.
function embedPhysicalBounds(bounds) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw new Error('无效的内嵌位置');
  const [width, height] = window.getContentSize();
  const x = Math.max(0, Math.min(width - 1, Math.round(bounds.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(bounds.y)));
  const w = Math.max(1, Math.min(width - x, Math.round(bounds.width)));
  const h = Math.max(1, Math.min(height - y, Math.round(bounds.height)));
  const content = window.getContentBounds();
  const rect = screen.dipToScreenRect(window, { x: Math.round(content.x + x), y: Math.round(content.y + y), width: w, height: h });
  return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
}
function syncEmbedBounds() {
  for (const embed of embeds.values()) {
    try {
      embed.bounds = embedPhysicalBounds(embed.css);
      native.embedBounds(embed.hwnd, embed.bounds).catch(() => {});
    } catch { /* the window is closing or the layout is between frames */ }
  }
}
let embedSyncTimer;
function scheduleEmbedSync() {
  clearTimeout(embedSyncTimer);
  embedSyncTimer = setTimeout(syncEmbedBounds, 80);
}
function dockWindowEntry(itemId, windowId) {
  const item = dock.items.find(entry => entry.id === itemId);
  if (!item) return null;
  const target = (windowId && item.windows.find(entry => entry.id === windowId)) || item.windows[0];
  if (!target || !Number.isSafeInteger(target.hwnd) || target.hwnd <= 0) return null;
  return { item, target };
}
async function resolveDockWindow(itemId, windowId) {
  let found = dockWindowEntry(itemId, windowId);
  if (found) return found;
  if (!dock.items.some(item => item.id === itemId)) throw new Error('应用入口已失效，请重新拖入');
  try { await native.activateDock(itemId); } catch { /* the window may still be opening */ }
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    found = dockWindowEntry(itemId, windowId);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('应用没有可内嵌的窗口，请先在应用中打开窗口');
}
function reportEmbedLost(hwnd, reason) {
  for (const [id, embed] of embeds) {
    if (embed.hwnd !== hwnd) continue;
    embeds.delete(id);
    send('embed-lost', { id, reason });
  }
}
function reportEmbedFlash(hwnd, flashing) {
  for (const [id, embed] of embeds) {
    if (embed.hwnd !== hwnd) continue;
    send('embed-flash', { id, flashing });
  }
}
function dropAllEmbeds() {
  const records = [...embeds.values()];
  embeds.clear();
  for (const embed of records) native.embedDetach(embed.hwnd).catch(() => {});
}
function createBrowser() {
  if (browser) return browser;
  const browserSession = session.fromPartition('persist:harbor-web');
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: '保存网页下载的文件' }));
  browser = new WebContentsView({ webPreferences: { partition: 'persist:harbor-web', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  window.contentView.addChildView(browser);
  browser.setBackgroundColor('#ffffff');
  browser.setVisible(false);
  browser.webContents.setZoomFactor(browserZoom / 100);
  browser.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    const action = ['-', '_'].includes(input.key) ? 'out' : ['=', '+'].includes(input.key) ? 'in' : input.key === '0' ? 'reset' : '';
    if (!action) return;
    event.preventDefault();
    applyBrowserZoom(action);
  });
  browser.webContents.setWindowOpenHandler(({ url }) => {
    try { navigateBrowser(url); } catch { send('browser-state', { error: '已阻止非 HTTP / HTTPS 链接' }); }
    return { action: 'deny' };
  });
  for (const event of ['will-navigate', 'will-redirect']) {
    browser.webContents.on(event, (eventObject, url) => {
      try { normalizeUrl(url); } catch { eventObject.preventDefault(); browserState({ error: '已阻止不安全的网页跳转' }); }
    });
  }
  browser.webContents.on('did-start-loading', () => browserState({ error: '' }));
  browser.webContents.on('did-stop-loading', () => browserState());
  browser.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (code !== -3 && isMainFrame) browserState({ loading: false, error: `网页加载失败（${code}），请检查网址或网络后重试` });
  });
  const rememberUrl = (_event, url) => {
    try { store.state.browserUrl = normalizeUrl(url); store.saveSoon(() => send('storage-error', '网页地址保存失败')); } catch { return; }
    browserState({ error: '' });
  };
  browser.webContents.on('did-navigate', rememberUrl);
  browser.webContents.on('did-navigate-in-page', rememberUrl);
  browser.webContents.on('render-process-gone', () => browserState({ loading: false, error: '网页进程已停止，请点击刷新' }));
  positionBrowser();
  return browser;
}
function navigateBrowser(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const view = createBrowser();
  store.state.browserUrl = url;
  store.saveSoon(() => send('storage-error', '网页地址保存失败'));
  positionBrowser();
  view.webContents.loadURL(url).catch(error => {
    if (error.code !== 'ERR_ABORTED') browserState({ loading: false, error: '网页加载失败，请检查网址或网络后重试' });
  });
  return url;
}
function importDesktop() {
  const directories = [app.getPath('desktop')];
  if (process.env.PUBLIC) directories.push(path.join(process.env.PUBLIC, 'Desktop'));
  const files = [];
  for (const directory of new Set(directories)) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory)) {
      if (entry.toLowerCase() !== 'desktop.ini' && !entry.startsWith('.')) files.push(path.join(directory, entry));
    }
  }
  const result = addPaths(store.state, files);
  changed();
  return result;
}
async function finishClosing() {
  if (finalizing) return;
  finalizing = true;
  clearTimeout(closeTimer);
  clearTimeout(taskbarRetryTimer);
  clearTimeout(embedSyncTimer);
  resetDockReady();
  try { await native.stop(); }
  catch (error) { dialog.showErrorBox('桌面恢复提示', `${error.message}。如图标未显示，可右键桌面 → 查看 → 显示桌面图标。`); }
  embeds.clear();
  closing = true;
  if (window && !window.isDestroyed()) window.close();
}
function registerHandlers() {
  const handle = (channel, handler) => ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '拒绝未授权的操作' };
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) { return { ok: false, error: error.message || '操作未完成' }; }
  });
  handle('bootstrap', () => ({ state: store.state, dataDirectory: store.directory, recovered: store.recovered, version: app.getVersion(), desktopState, dock, taskbarState }));
  handle('dock-ready', (revision, rendered) => {
    if (!Number.isSafeInteger(revision) || revision !== dock.revision || !dock.supported || closing || finalizing) return;
    clearTimeout(dockReadyTimer);
    dockReadyTimer = undefined;
    if (window && !window.isDestroyed() && window.isMinimized()) {
      // Minimized windows stop painting, so a missing or negative acknowledgement
      // says nothing about the dock; re-validate after the window is restored.
      dockReady = true;
      syncTaskbar();
      return;
    }
    dockReady = rendered === true;
    if (!dockReady) updateTaskbarState({ hidden: taskbarState.hidden, error: '左侧应用图标未完整显示，已保留系统任务栏' });
    syncTaskbar();
  });
  handle('dock-activate', async id => {
    if (typeof id !== 'string' || !dock.items.some(item => item.id === id || item.windows.some(entry => entry.id === id))) throw new Error('应用入口已失效，请使用最新列表');
    try {
      await native.activateDock(id);
      resumeTaskbar();
    } catch (error) {
      // A transient denial must not disable the dock takeover for the rest of the session:
      // show the system taskbar as a fallback, then resume hiding after the next successful switch.
      pauseTaskbar(`${error.message}${dock.supported ? '；系统任务栏已暂时显示，下次切换成功后自动隐藏' : ''}`);
      throw error;
    }
  });
  handle('dock-window', async (id, action) => {
    if (typeof id !== 'string' || !dock.items.some(item => item.running && (item.id === id || item.windows.some(entry => entry.id === id)))) throw new Error('应用入口已失效，请使用最新列表');
    if (!['maximize', 'minimize', 'close'].includes(action)) throw new Error('未知的窗口操作');
    await native.windowDock(id, action);
  });
  handle('embed-attach', async (dockId, windowId, bounds) => {
    if (typeof dockId !== 'string') throw new Error('无效的应用入口');
    const { item, target } = await resolveDockWindow(dockId, typeof windowId === 'string' ? windowId : '');
    if (pendingEmbeds.has(target.hwnd) || [...embeds.values()].some(embed => embed.hwnd === target.hwnd)) throw new Error('该应用窗口已经在标签中');
    const physical = embedPhysicalBounds(bounds);
    pendingEmbeds.add(target.hwnd);
    try {
      await native.embedAttach(target.hwnd, physical);
      const id = crypto.randomUUID();
      embeds.set(id, { hwnd: target.hwnd, title: target.title || item.title, icon: item.icon, css: { ...bounds }, bounds: physical, shown: true, dockId, windowId: target.id });
      return { id, title: target.title || item.title, icon: item.icon };
    } finally { pendingEmbeds.delete(target.hwnd); }
  });
  handle('embed-bounds', (id, bounds) => {
    const embed = embeds.get(id);
    if (!embed) return;
    try {
      embed.css = { ...bounds };
      embed.bounds = embedPhysicalBounds(bounds);
      native.embedBounds(embed.hwnd, embed.bounds).catch(() => {});
    } catch { /* the panel is between layouts */ }
  });
  handle('embed-show', id => {
    const embed = embeds.get(id);
    if (!embed) return;
    embed.shown = true;
    native.embedShow(embed.hwnd).catch(() => {});
  });
  handle('embed-hide', id => {
    const embed = embeds.get(id);
    if (!embed) return;
    embed.shown = false;
    native.embedHide(embed.hwnd).catch(() => {});
  });
  handle('embed-detach', async id => {
    const embed = embeds.get(id);
    if (!embed) return;
    embeds.delete(id);
    await native.embedDetach(embed.hwnd).catch(() => {});
  });
  handle('import-desktop', importDesktop);
  handle('add-files', async (categoryId, directory = false) => {
    const result = await dialog.showOpenDialog(window, { title: directory ? '选择要收纳的文件夹' : '选择要收纳的文件', properties: directory ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] });
    if (result.canceled) return { added: 0, skipped: 0, canceled: true };
    const added = addPaths(store.state, result.filePaths, categoryId, { includeRemoved: true });
    changed();
    return added;
  });
  handle('add-paths', (paths, categoryId) => {
    if (!Array.isArray(paths)) throw new Error('无效的文件列表');
    const result = addPaths(store.state, paths, categoryId, { includeRemoved: true });
    changed();
    return result;
  });
  handle('item-action', async (id, action, categoryId) => {
    const item = store.state.items.find(entry => entry.id === id);
    if (!item) throw new Error('文件入口不存在');
    if (action === 'remove') {
      store.state.items = store.state.items.filter(entry => entry.id !== id);
      // The desktop import runs on every launch; remember this path so a removed
      // entry is not silently recreated after a restart or an upgrade.
      ignorePath(store.state, item.path);
    }
    else if (action === 'move') {
      if (!store.state.categories.some(category => category.id === categoryId)) throw new Error('分区不存在');
      item.categoryId = categoryId;
    } else if (action === 'open' || action === 'reveal') {
      if (!fs.existsSync(item.path)) throw new Error('源文件已移动或删除，请重新添加入口');
      if (action === 'open') {
        const error = await shell.openPath(item.path);
        if (error) throw new Error(`无法打开文件：${error}`);
      } else shell.showItemInFolder(item.path);
      return;
    } else throw new Error('未知操作');
    changed();
  });
  handle('item-icon', async id => {
    const item = store.state.items.find(entry => entry.id === id);
    if (!item || !fs.existsSync(item.path)) return null;
    if (iconCache.has(item.path)) return iconCache.get(item.path);
    const icon = await native.getIcon(item.path);
    iconCache.set(item.path, icon);
    return icon;
  });
  handle('category-edit', (id, rawName) => {
    const name = String(rawName || '').trim().slice(0, 24);
    if (!name) throw new Error('请输入分区名称');
    if (id) {
      const category = store.state.categories.find(entry => entry.id === id);
      if (!category) throw new Error('分区不存在');
      category.name = name;
    } else {
      const colors = ['blue', 'violet', 'green', 'amber'];
      store.state.categories.push({ id: crypto.randomUUID(), name, color: colors[store.state.categories.length % colors.length], icon: 'folder' });
    }
    changed();
  });
  handle('category-remove', id => {
    if (['documents', 'apps', 'images', 'others'].includes(id)) throw new Error('默认分区可重命名，但不能删除');
    store.state.categories = store.state.categories.filter(category => category.id !== id);
    for (const item of store.state.items) if (item.categoryId === id) item.categoryId = 'others';
    changed();
  });
  handle('notes-save', (notes, activeNoteId) => {
    if (!Array.isArray(notes) || !notes.length || notes.length > 100 || notes.some(note => !note || typeof note.id !== 'string' || typeof note.title !== 'string' || typeof note.content !== 'string' || note.content.length > 1000000)) throw new Error('便签内容无效或超过限制');
    store.state.notes = notes.map(note => ({ id: note.id, title: note.title.slice(0, 60), content: note.content, updatedAt: Number(note.updatedAt) || Date.now() }));
    store.state.activeNoteId = activeNoteId;
    store.flush();
  });
  handle('browser-navigate', navigateBrowser);
  handle('browser-zoom', action => {
    if (!['in', 'out', 'reset'].includes(action)) throw new Error('未知的网页缩放操作');
    return applyBrowserZoom(action);
  });
  handle('browser-action', async action => {
    if (action === 'home') {
      if (browser) {
        const old = browser;
        browser = null;
        window.contentView.removeChildView(old);
        old.webContents.close();
      }
      store.state.browserUrl = '';
      store.saveSoon(() => send('storage-error', '网页地址保存失败'));
      send('browser-state', { url: '', loading: false, canGoBack: false, canGoForward: false, home: true, error: '' });
      return;
    }
    if (!browser) return;
    const contents = browser.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') contents.reload();
    if (action === 'stop') contents.stop();
    if (action === 'external') await shell.openExternal(normalizeUrl(contents.getURL()));
  });
  handle('browser-bounds', bounds => {
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) return;
    browserBounds = bounds;
    positionBrowser();
  });
  handle('browser-visible', visible => { browserVisible = Boolean(visible); positionBrowser(); });
  handle('window-action', action => {
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
  });
  handle('autostart-get', () => {
    if (testMode) return { enabled: testAutostart, supported: process.platform === 'win32' };
    const selected = app.getLoginItemSettings({ path: loginItemPath() });
    return { enabled: Boolean(selected.openAtLogin), supported: process.platform === 'win32' };
  });
  handle('autostart-set', enabled => {
    if (typeof enabled !== 'boolean') throw new Error('无效的开机自启动设置');
    if (process.platform !== 'win32') throw new Error('当前系统不支持开机自启动');
    if (testMode) { testAutostart = enabled; return { enabled }; }
    app.setLoginItemSettings({ openAtLogin: enabled, path: loginItemPath() });
    return { enabled: Boolean(app.getLoginItemSettings({ path: loginItemPath() }).openAtLogin) };
  });
  handle('close-ready', finishClosing);
  handle('open-data-directory', () => shell.openPath(store.directory));
  handle('change-data-directory', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择新的工作区数据保存文件夹', defaultPath: store.directory, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return { canceled: true };
    if (closing || finalizing) throw new Error('应用正在退出，未更改保存位置');
    store = relocateStore(store, result.filePaths[0], app.getPath('userData'));
    return { canceled: false, directory: store.directory };
  });
}

if (singleInstance) {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    store = new Store(resolveDataDirectory(app.getPath('userData')));
    if (!testMode) importDesktop();
    const savedWindow = store.state.window || {};
    window = new BrowserWindow({
      width: Math.max(1120, Math.min(2400, savedWindow.width || 1480)),
      height: Math.max(740, Math.min(1600, savedWindow.height || 940)),
      minWidth: 1120, minHeight: 740, frame: false, show: false,
      title: 'QX桌面', backgroundColor: '#f5f7fb',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
    });
    Menu.setApplicationMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-start-loading', () => { resetDockReady(); dropAllEmbeds(); });
    window.webContents.on('render-process-gone', finishClosing);
    window.on('unresponsive', resetDockReady);
    window.on('responsive', () => send('dock-changed', dock));
    for (const event of ['minimize', 'hide']) window.on(event, () => { syncTaskbar(); setTimeout(syncTaskbar, 250); });
    for (const event of ['restore', 'show']) window.on(event, () => { send('dock-changed', dock); syncTaskbar(); });
    window.once('ready-to-show', async () => {
      if (finalizing || closing || closeTimer) return;
      if (!testMode || savedWindow.maximized) window.maximize();
      window.show();
      if (!testMode) {
        native.startDock(updateDock, error => updateDock({ supported: false, error, items: [] }));
        try {
          desktopState = await native.takeDesktop(message => {
            desktopState = { active: false, error: message };
            send('desktop-state', desktopState);
            resetDockReady();
            updateTaskbarState({ hidden: false, error: message });
            for (const id of [...embeds.keys()]) { embeds.delete(id); send('embed-lost', { id, reason: message }); }
          }, updateTaskbarState, reportEmbedLost, reportEmbedFlash);
        } catch (error) { desktopState = { active: false, error: error.message }; }
        send('desktop-state', desktopState);
        syncTaskbar();
      }
    });
    window.on('resize', () => { positionBrowser(); scheduleEmbedSync(); });
    window.on('move', scheduleEmbedSync);
    window.on('close', event => {
      if (!closing) {
        event.preventDefault();
        if (!finalizing) {
          resetDockReady();
          send('prepare-close');
          if (!closeTimer) closeTimer = setTimeout(finishClosing, 5000);
        }
        return;
      }
      clearTimeout(closeTimer);
      const bounds = window.getNormalBounds();
      store.state.window = { width: bounds.width, height: bounds.height, maximized: window.isMaximized() };
      try { store.flush(); } catch (error) { dialog.showErrorBox('数据未能保存', `请检查磁盘空间。${error.message}`); }
      if (browser && !browser.webContents.isDestroyed()) browser.webContents.close();
    });
    window.on('closed', () => { window = null; app.quit(); });
    registerHandlers();
    window.loadFile(path.join(__dirname, 'index.html'));
  }).catch(error => { dialog.showErrorBox('QX桌面启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}

const { spawn } = require('node:child_process');
const readline = require('node:readline');

class WindowsBridge {
  constructor(executable) {
    this.executable = executable;
    this.icons = null;
    this.guard = null;
    this.dock = null;
    this.pending = new Map();
    this.dockPending = new Map();
    this.embedPending = new Map();
    this.onEmbedLost = null;
    this.onEmbedFlash = null;
    this.nextId = 0;
    this.stopping = false;
    this.dockRetryTimer = null;
    this.dockRetryDelay = 0;
    this.dockSnapshotHandler = null;
    this.dockFailureHandler = null;
  }
  startIcons() {
    if (this.stopping) throw new Error('应用正在退出');
    if (this.icons) return this.icons;
    const child = spawn(this.executable, ['icons'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.icons = child;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
      const [id, png] = line.split('\t');
      const request = this.pending.get(id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(id);
      if (png) request.resolve(`data:image/png;base64,${png}`);
      else request.reject(new Error('Windows 无法读取此文件的图标'));
    });
    child.stderr.resume();
    const stopped = () => {
      if (this.icons === child) this.icons = null;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Windows 图标组件已停止')); }
      this.pending.clear();
      reader.close();
    };
    child.on('error', stopped);
    child.on('exit', stopped);
    child.stdin.on('error', () => {});
    return child;
  }
  getIcon(filePath) {
    const child = this.startIcons();
    return new Promise((resolve, reject) => {
      const id = String(++this.nextId);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('文件图标读取超时')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${id}\t${Buffer.from(filePath, 'utf8').toString('base64')}\n`);
    });
  }
  startDock(onSnapshot, onFailure) {
    if (this.stopping) throw new Error('应用正在退出');
    if (this.dock) return;
    this.dockSnapshotHandler = onSnapshot;
    this.dockFailureHandler = onFailure;
    const child = spawn(this.executable, ['dock', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.dock = child;
    const reader = readline.createInterface({ input: child.stdout });
    const clearTimers = () => { clearTimeout(child.snapshotTimer); clearTimeout(child.refreshTimer); };
    const fail = message => {
      if (child.dockFailed) return;
      child.dockFailed = true;
      clearTimers();
      for (const request of this.dockPending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
      this.dockPending.clear();
      if (!this.stopping) onFailure(message);
      child.stdin.end();
      if (child.exitCode === null && child.pid) child.cleanupTimer = setTimeout(() => child.kill(), 2000);
      this.scheduleDockRestart();
    };
    const expectSnapshot = () => {
      clearTimeout(child.snapshotTimer);
      child.snapshotTimer = setTimeout(() => fail('应用清单读取超时，已保留系统任务栏'), 10000);
    };
    reader.on('line', line => {
      if (child.dockFailed || this.stopping) return;
      const fields = line.split('\t');
      if (fields[0] === 'SNAPSHOT') {
        try {
          const value = JSON.parse(Buffer.from(fields[1] || '', 'base64').toString('utf8'));
          if (!value || typeof value.supported !== 'boolean' || typeof value.error !== 'string' || !Array.isArray(value.items) || value.items.some(item =>
            !item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || typeof item.icon !== 'string' || (item.icon && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.icon)) ||
            typeof item.running !== 'boolean' || typeof item.active !== 'boolean' || !Array.isArray(item.windows) || item.windows.some(entry => !entry || typeof entry.id !== 'string' || !entry.id || typeof entry.title !== 'string' || (entry.hwnd !== undefined && !Number.isSafeInteger(entry.hwnd))))) throw new Error('无效的应用清单');
          if (value.supported && (!value.items.length || value.items.some(item => !item.icon))) throw new Error('应用清单或图标不完整');
          clearTimers();
          this.dockRetryDelay = 0;
          clearTimeout(this.dockRetryTimer);
          this.dockRetryTimer = null;
          onSnapshot(value);
          child.refreshTimer = setTimeout(() => {
            if (child.dockFailed || this.stopping) return;
            expectSnapshot();
            child.stdin.write('refresh\n');
          }, 1500);
        } catch (error) { fail(`应用清单不可用，已保留系统任务栏：${error.message}`); }
      } else if (fields[0] === 'RESULT') {
        const request = this.dockPending.get(fields[1]);
        if (!request) return;
        clearTimeout(request.timer);
        this.dockPending.delete(fields[1]);
        const error = Buffer.from(fields[2] || '', 'base64').toString('utf8');
        if (error) request.reject(new Error(error)); else request.resolve();
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => fail('应用清单连接中断，已恢复系统任务栏'));
    child.on('error', error => fail(`应用清单组件无法启动：${error.message}`));
    child.on('exit', () => {
      fail('应用清单组件已停止，已恢复系统任务栏');
      clearTimeout(child.cleanupTimer);
      reader.close();
      if (this.dock === child) this.dock = null;
    });
    expectSnapshot();
  }
  // The shell can briefly refuse a snapshot while Explorer rebuilds its taskbar.
  // Keep retrying with backoff so one bad startup sample does not disable the
  // application list until the whole app is restarted.
  scheduleDockRestart() {
    if (this.stopping || this.dockRetryTimer) return;
    const delay = Math.min(30000, 5000 * Math.pow(2, this.dockRetryDelay++));
    this.dockRetryTimer = setTimeout(() => {
      this.dockRetryTimer = null;
      if (this.stopping) return;
      if (this.dock && this.dock.dockFailed) this.dock = null;
      if (this.dock) return;
      try { this.startDock(this.dockSnapshotHandler, this.dockFailureHandler); }
      catch { this.scheduleDockRestart(); }
    }, delay);
  }
  activateDock(id) {
    const child = this.dock;
    if (this.stopping || !child || child.dockFailed || child.exitCode !== null) return Promise.reject(new Error('应用清单不可用，请使用系统任务栏'));
    return new Promise((resolve, reject) => {
      const requestId = String(++this.nextId);
      const timer = setTimeout(() => { this.dockPending.delete(requestId); reject(new Error('应用切换超时，请使用系统任务栏')); }, 8000);
      this.dockPending.set(requestId, { resolve, reject, timer });
      child.stdin.write(`activate\t${requestId}\t${Buffer.from(id, 'utf8').toString('base64')}\n`);
    });
  }
  windowDock(id, action) {
    if (!['maximize', 'minimize', 'close'].includes(action)) return Promise.reject(new Error('未知的窗口操作'));
    const child = this.dock;
    if (this.stopping || !child || child.dockFailed || child.exitCode !== null) return Promise.reject(new Error('应用清单不可用，请使用系统任务栏'));
    return new Promise((resolve, reject) => {
      const requestId = String(++this.nextId);
      const timer = setTimeout(() => { this.dockPending.delete(requestId); reject(new Error('窗口操作超时，请重试')); }, 8000);
      this.dockPending.set(requestId, { resolve, reject, timer });
      child.stdin.write(`window\t${requestId}\t${Buffer.from(id, 'utf8').toString('base64')}\t${action}\n`);
    });
  }
  setTaskbarMode(mode) {
    const child = this.guard;
    if (this.stopping || !child || child.exitCode !== null || child.taskbarMode === mode) return;
    child.taskbarMode = mode;
    child.stdin.write(mode === 'own' ? 'taskbar-own\n' : mode === 'hidden' ? 'taskbar-hide\n' : 'taskbar-show\n');
  }
  takeDesktop(onUnexpectedExit, onTaskbarState, onEmbedLost, onEmbedFlash) {
    if (this.stopping) throw new Error('应用正在退出');
    if (this.guard) throw new Error('桌面已经接管');
    this.onEmbedLost = onEmbedLost || null;
    this.onEmbedFlash = onEmbedFlash || null;
    const child = spawn(this.executable, ['guard', String(process.pid)], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.guard = child;
    const reader = readline.createInterface({ input: child.stdout });
    let errorText = '';
    let ready = false;
    let stopping = false;
    child.stderr.on('data', buffer => { errorText += buffer.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.restore = () => { stopping = true; child.stdin.end('restore\n'); };
    const endEmbeds = message => {
      for (const request of this.embedPending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
      this.embedPending.clear();
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.restore(); reject(new Error('接管桌面超时，原桌面将自动恢复')); }, 8000);
      reader.on('line', line => {
        if (line.startsWith('READY\t')) { clearTimeout(timer); ready = true; resolve({ active: true, originalVisible: line.endsWith('1') }); }
        if (line.startsWith('TASKBAR\t')) {
          const [, hidden, encodedError] = line.split('\t');
          const error = Buffer.from(encodedError || '', 'base64').toString('utf8');
          if (error) child.taskbarMode = null;
          onTaskbarState?.({ hidden: hidden === '1', error });
        }
        if (line.startsWith('EMBED\t')) {
          const [, id, ok, encodedError] = line.split('\t');
          const request = this.embedPending.get(id);
          if (!request) return;
          clearTimeout(request.timer);
          this.embedPending.delete(id);
          const error = Buffer.from(encodedError || '', 'base64').toString('utf8');
          if (ok === '1' && !error) request.resolve();
          else request.reject(new Error(error || '应用内嵌未完成'));
        }
        if (line.startsWith('EMBED-LOST\t')) {
          const [, hwnd, encodedError] = line.split('\t');
          const reason = Buffer.from(encodedError || '', 'base64').toString('utf8');
          if (!stopping) this.onEmbedLost?.(Number(hwnd), reason);
        }
        if (line.startsWith('EMBED-FLASH\t')) {
          const [, hwnd, flashing] = line.split('\t');
          const handle = Number(hwnd);
          if (!stopping && Number.isSafeInteger(handle) && handle > 0) this.onEmbedFlash?.(handle, flashing === '1');
        }
      });
      child.on('error', error => {
        clearTimeout(timer);
        reader.close();
        endEmbeds('桌面接管组件已停止');
        if (this.guard === child) this.guard = null;
        reject(new Error(`Windows 桌面组件无法启动：${error.message}`));
      });
      child.on('exit', code => {
        clearTimeout(timer);
        reader.close();
        endEmbeds('桌面接管已结束');
        if (this.guard === child) this.guard = null;
        if (!ready) reject(new Error(errorText.trim() || '无法找到或接管 Windows 桌面'));
        else if (!stopping) onUnexpectedExit?.(code === 0 ? '桌面接管已结束，原图标已恢复' : '桌面恢复组件已停止，请检查桌面图标显示状态');
      });
    });
  }
  requestEmbed(command, values) {
    const child = this.guard;
    if (this.stopping || !child || child.exitCode !== null) return Promise.reject(new Error('桌面接管未激活，暂时不能内嵌应用'));
    if (values.some(value => !Number.isSafeInteger(value))) return Promise.reject(new Error('无效的内嵌位置'));
    return new Promise((resolve, reject) => {
      const id = String(++this.nextId);
      const timer = setTimeout(() => { this.embedPending.delete(id); reject(new Error('应用内嵌响应超时，请重试')); }, 8000);
      this.embedPending.set(id, { resolve, reject, timer });
      child.stdin.write(`${command}\t${id}\t${values.join('\t')}\n`);
    });
  }
  embedAttach(hwnd, bounds) {
    return this.requestEmbed('embed-attach', [hwnd, bounds.left, bounds.top, bounds.right, bounds.bottom]);
  }
  embedBounds(hwnd, bounds) {
    return this.requestEmbed('embed-bounds', [hwnd, bounds.left, bounds.top, bounds.right, bounds.bottom]);
  }
  embedShow(hwnd) {
    return this.requestEmbed('embed-show', [hwnd]);
  }
  embedHide(hwnd) {
    return this.requestEmbed('embed-hide', [hwnd]);
  }
  embedDetach(hwnd) {
    return this.requestEmbed('embed-detach', [hwnd]);
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.dockRetryTimer);
    this.dockRetryTimer = null;
    const iconChild = this.icons;
    const guardChild = this.guard;
    const dockChild = this.dock;
    if (dockChild) { clearTimeout(dockChild.snapshotTimer); clearTimeout(dockChild.refreshTimer); }
    const wait = (child, timeout, stop) => {
      if (!child || child.exitCode !== null) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (child !== guardChild) { child.kill(); resolve(); }
          else reject(new Error('桌面恢复仍在进行，请在退出后检查桌面图标和任务栏'));
        }, timeout);
        child.once('exit', code => {
          clearTimeout(timer);
          if (child === guardChild && code !== 0) reject(new Error('桌面恢复组件异常退出，请检查桌面图标'));
          else resolve();
        });
        child.once('error', () => { clearTimeout(timer); resolve(); });
        stop();
      });
    };
    await Promise.all([
      wait(guardChild, 6000, () => guardChild.restore()),
      wait(iconChild, 2000, () => iconChild.stdin.end()),
      wait(dockChild, 2000, () => dockChild.stdin.end())
    ]);
  }
}

module.exports = { WindowsBridge };

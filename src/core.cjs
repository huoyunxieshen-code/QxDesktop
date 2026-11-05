const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const defaults = () => ({
  version: 1,
  categories: [
    { id: 'documents', name: '工作文档', icon: 'file', color: 'blue' },
    { id: 'apps', name: '常用应用', icon: 'grid', color: 'violet' },
    { id: 'images', name: '图片素材', icon: 'image', color: 'green' },
    { id: 'others', name: '其他收纳', icon: 'folder', color: 'amber' }
  ],
  items: [],
  removedPaths: [],
  notes: [{ id: crypto.randomUUID(), title: '随手记', content: '', updatedAt: Date.now() }],
  activeNoteId: null,
  browserUrl: '',
  window: { width: 1480, height: 940, maximized: false }
});

function normalizeUrl(input) {
  const value = String(input || '').trim();
  if (!value || value.length > 8192) throw new Error('请输入有效的网址');
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  const hostWithPort = /^(localhost|[a-z\d.-]+):\d+(\/|$)/i.test(value);
  const url = new URL(explicitScheme && !hostWithPort ? value : `https://${value}`);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('仅支持不含账号密码的 HTTP / HTTPS 网页');
  }
  return url.href;
}

function classify(filePath, isDirectory = false) {
  if (isDirectory) return 'others';
  const extension = path.extname(filePath).toLowerCase();
  if (['.lnk', '.url', '.exe', '.msi', '.appref-ms'].includes(extension)) return 'apps';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.psd'].includes(extension)) return 'images';
  if (['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.txt', '.md', '.csv', '.rtf', '.json'].includes(extension)) return 'documents';
  return 'others';
}

function addPaths(state, paths, categoryId, options = {}) {
  if (categoryId && !state.categories.some(category => category.id === categoryId)) throw new Error('分区不存在');
  const includeRemoved = options.includeRemoved === true;
  let added = 0;
  let skipped = 0;
  const existing = new Set(state.items.map(item => path.resolve(item.path).toLowerCase()));
  const removed = new Set((state.removedPaths || []).map(entry => String(entry).toLowerCase()));
  for (const rawPath of paths.slice(0, 2000)) {
    if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) { skipped++; continue; }
    const filePath = path.resolve(rawPath);
    const key = filePath.toLowerCase();
    if (existing.has(key)) { skipped++; continue; }
    if (!includeRemoved && removed.has(key)) { skipped++; continue; }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() && !stat.isDirectory()) { skipped++; continue; }
      const isDirectory = stat.isDirectory();
      state.items.push({ id: crypto.randomUUID(), name: path.basename(filePath), path: filePath, isDirectory, categoryId: categoryId || classify(filePath, isDirectory) });
      existing.add(key);
      if (removed.has(key)) {
        state.removedPaths = state.removedPaths.filter(entry => String(entry).toLowerCase() !== key);
        removed.delete(key);
      }
      added++;
    } catch { skipped++; }
  }
  return { added, skipped };
}

function ignorePath(state, filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return;
  let key;
  try { key = path.resolve(filePath).toLowerCase(); }
  catch { return; }
  if (!Array.isArray(state.removedPaths)) state.removedPaths = [];
  if (!state.removedPaths.some(entry => String(entry).toLowerCase() === key)) state.removedPaths.push(key);
}

function validState(value) {
  return value && value.version === 1 && Array.isArray(value.categories) && value.categories.length > 0 &&
    value.categories.every(c => c && typeof c.id === 'string' && typeof c.name === 'string') &&
    ['documents', 'apps', 'images', 'others'].every(id => value.categories.some(c => c.id === id)) &&
    Array.isArray(value.items) && value.items.every(i => i && typeof i.id === 'string' && typeof i.name === 'string' && typeof i.path === 'string' && value.categories.some(c => c.id === i.categoryId)) &&
    (value.removedPaths === undefined || (Array.isArray(value.removedPaths) && value.removedPaths.every(entry => typeof entry === 'string'))) &&
    Array.isArray(value.notes) && value.notes.length > 0 && value.notes.every(n => n && typeof n.id === 'string' && typeof n.title === 'string' && typeof n.content === 'string') &&
    typeof value.browserUrl === 'string';
}

class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'workspace.json');
    this.timer = null;
    this.recovered = false;
    fs.mkdirSync(directory, { recursive: true });
    this.state = defaults();
    if (fs.existsSync(this.file)) {
      try {
        const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!validState(value)) throw new Error('Invalid workspace');
        this.state = { ...this.state, ...value };
      } catch {
        fs.copyFileSync(this.file, `${this.file}.recovery-${Date.now()}`);
        this.recovered = true;
      }
    }
  }
  saveSoon(onError) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { try { this.flush(); } catch (error) { onError?.(error); } }, 220);
  }
  flush() {
    clearTimeout(this.timer);
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }
}

function resolveDataDirectory(settingsDirectory) {
  const locationFile = path.join(settingsDirectory, 'data-location.json');
  try {
    try {
      fs.lstatSync(locationFile);
    } catch (error) {
      if (error.code === 'ENOENT') return settingsDirectory;
      throw error;
    }
    const location = JSON.parse(fs.readFileSync(locationFile, 'utf8'));
    if (!location || typeof location.directory !== 'string' || !path.isAbsolute(location.directory)) {
      throw new Error('配置中的 directory 必须是绝对路径');
    }
    const directory = path.resolve(location.directory);
    if (!fs.statSync(path.join(directory, 'workspace.json')).isFile()) {
      throw new Error('目标 workspace.json 不是文件');
    }
    return directory;
  } catch (error) {
    throw new Error(`无法读取数据保存路径配置（${locationFile}）：${error.message}`, { cause: error });
  }
}

function relocateStore(store, destination, settingsDirectory) {
  try {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
      throw new Error('目标数据目录必须是绝对路径');
    }
    const directory = path.resolve(destination);
    const sourceDirectory = path.resolve(store.directory);
    if (directory === sourceDirectory || (process.platform === 'win32' && directory.toLowerCase() === sourceDirectory.toLowerCase())) {
      return store;
    }
    store.flush();
    fs.mkdirSync(directory, { recursive: true });
    const destinationFile = path.join(directory, 'workspace.json');
    fs.copyFileSync(store.file, destinationFile, fs.constants.COPYFILE_EXCL);
    const value = JSON.parse(fs.readFileSync(destinationFile, 'utf8'));
    if (!validState(value)) throw new Error('目标 workspace.json 数据无效');
    // 在提交配置前加载新 Store，避免构造失败后配置已切换。
    const relocated = new Store(directory);
    if (relocated.recovered) throw new Error('目标 workspace.json 无法正常加载');
    fs.mkdirSync(settingsDirectory, { recursive: true });
    const locationFile = path.join(settingsDirectory, 'data-location.json');
    const temporary = `${locationFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ directory }, null, 2), { encoding: 'utf8', flag: 'wx' });
    try {
      fs.renameSync(temporary, locationFile);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    return relocated;
  } catch (error) {
    throw new Error(`更改数据保存路径失败，原目录仍有效（${store.directory}）：${error.message}`, { cause: error });
  }
}

module.exports = { defaults, normalizeUrl, classify, addPaths, ignorePath, validState, Store, resolveDataDirectory, relocateStore };

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const channels = new Set(['bootstrap', 'import-desktop', 'add-files', 'add-paths', 'item-action', 'item-icon', 'category-edit', 'category-remove', 'notes-save', 'browser-navigate', 'browser-action', 'browser-bounds', 'browser-visible', 'browser-zoom', 'window-action', 'close-ready', 'open-data-directory', 'change-data-directory', 'autostart-get', 'autostart-set', 'dock-ready', 'dock-activate', 'dock-window', 'embed-attach', 'embed-bounds', 'embed-show', 'embed-hide', 'embed-detach']);
const events = new Set(['state-changed', 'browser-state', 'storage-error', 'prepare-close', 'desktop-state', 'dock-changed', 'taskbar-state', 'embed-lost', 'embed-flash']);
contextBridge.exposeInMainWorld('desktop', {
  invoke: (channel, ...args) => {
    if (!channels.has(channel)) return Promise.resolve({ ok: false, error: '不支持的操作' });
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, callback) => {
    if (!events.has(channel)) return;
    ipcRenderer.on(channel, (_event, value) => callback(value));
  },
  pathForFile: file => webUtils.getPathForFile(file)
});

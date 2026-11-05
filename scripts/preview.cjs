const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'src');
const { defaults } = require('../src/core.cjs');
const { version } = require('../package.json');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/preview-bridge.js') {
    const source = `(() => {
      let state = JSON.parse(localStorage.getItem('harbor-preview') || 'null') || ${JSON.stringify(defaults())};
      const callbacks = {};
      window.desktop = {
        on: (channel, callback) => { callbacks[channel] = callback; },
        pathForFile: () => '',
        invoke: async (channel, ...args) => {
          let value;
          if (channel === 'bootstrap') value = { state, dataDirectory: '浏览器预览，不访问本地数据', preview: true, version: ${JSON.stringify(version)} };
          if (channel === 'category-edit') {
            if (args[0]) state.categories.find(c => c.id === args[0]).name = args[1];
            else state.categories.push({id: crypto.randomUUID(), name: args[1], color: 'blue', icon: 'folder'});
            callbacks['state-changed']?.(structuredClone(state));
          }
          if (channel === 'notes-save') { state.notes = args[0]; state.activeNoteId = args[1]; }
          if (channel === 'category-remove') { state.categories = state.categories.filter(c => c.id !== args[0]); callbacks['state-changed']?.(structuredClone(state)); }
          localStorage.setItem('harbor-preview', JSON.stringify(state));
          if (['import-desktop','add-files','browser-navigate','open-data-directory','change-data-directory','dock-activate'].includes(channel)) return {ok: false, error: '这是界面预览，请在 EXE 桌面程序中使用此功能'};
          return {ok: true, value};
        }
      };
    })();`;
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(source);
    return;
  }
  const names = new Set(['/', '/index.html', '/styles.css', '/renderer.js', '/icon.png']);
  if (!names.has(pathname)) { response.writeHead(404); response.end(); return; }
  const filename = path.join(root, pathname === '/' ? 'index.html' : pathname.slice(1));
  try {
    let content = fs.readFileSync(filename);
    if (path.extname(filename) === '.html') content = content.toString().replace('<script src="renderer.js"', '<script src="preview-bridge.js"></script><script src="renderer.js"');
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' });
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`QX Desktop preview: http://127.0.0.1:${port}`));

const { _electron: electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ui-'));
const fixtureDirectory = path.join(directory, 'files');
fs.mkdirSync(fixtureDirectory);
const files = ['测试文档.txt', '素材图片.png', 'archive.zip'];
files.forEach(name => fs.writeFileSync(path.join(fixtureDirectory, name), 'fixture'));
const screenshotDirectory = path.join(root, 'assets');
let application;
let testCount = 0;
const pageErrors = [];
const check = (condition, label) => { assert.ok(condition, label); testCount++; console.log(`PASS ${label}`); };
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
  response.end(`<!doctype html><html><head><title>内嵌网页测试</title></head><body style="font:20px sans-serif;padding:30px;background:#eef4ff"><h1>独立内嵌网页正常运行</h1><p id="page">${request.url === '/second' ? '第二页' : '首页'}</p><a href="/second" id="next">进入第二页</a><a href="/popup" target="_blank" id="popup">新窗口链接</a></body></html>`);
});
async function launch() {
  const env = { ...process.env, HARBOR_DATA_DIR: path.join(directory, 'data'), HARBOR_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  application = await electron.launch({ args: [root], env, timeout: 40000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('.category-card').first().waitFor();
  await page.locator('#note-content').waitFor();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  console.log(`UI ready in ${(performance.now() - started).toFixed(0)} ms (isolated test mode, excludes portable extraction and desktop import)`);
  return page;
}
async function remote(script) {
  return application.evaluate(({ webContents }, { port, script }) => {
    const contents = webContents.getAllWebContents().find(content => content.getURL().startsWith(`http://127.0.0.1:${port}`));
    return contents ? contents.executeJavaScript(script, true) : null;
  }, { port: server.address().port, script });
}
async function waitForRemote(script, expected) {
  await expect.poll(() => remote(script), { timeout: 20000 }).toBe(expected);
}
async function checkBrowserBounds(page) {
  const expected = await page.locator('#browser-viewport').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(rect[key])]));
  });
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents?.getURL().startsWith('http:'));
    return view?.getVisible() ? view.getBounds() : null;
  })).toEqual(expected);
  check(true, '原生网页与右侧网页区域的位置和尺寸一致');
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let page = await launch();
  await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-home.png') });
  check(await page.locator('.category-card').count() === 4, '默认四个文件分区');
  check(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].listenerCount('ready-to-show')) === 0, '窗口就绪初始化仅执行一次');
  check(await page.locator('#focus-web, #focus-note').count() === 0 && await page.locator('.rail-button').count() === 1, '侧边栏仅保留设置入口');
  check(await page.locator('.rail #search').count() === 1 && await page.locator('.rail #import-desktop').count() === 1, '搜索框和导入按钮位于左侧栏');
  check(await page.locator('.workspace-heading, .organizer-foot, #browser-status, .rail-caption').count() === 0, '移除顶部标语、底部提示和多余状态文字');
  await page.locator('#note-content').focus();
  await page.keyboard.press('Control+f');
  check(await page.evaluate(() => document.activeElement?.id === 'search'), 'Ctrl+F 聚焦左侧搜索框');
  const proportions = await page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    return { files: box('.organizer'), web: box('.browser-panel'), calendar: box('.calendar-panel'), notes: box('.notes-panel'), widgets: box('.right-column'), dashboard: box('.dashboard') };
  });
  check(Math.abs(proportions.files.height - proportions.dashboard.height) < 2 && proportions.files.width < proportions.widgets.width && proportions.widgets.width >= 540, '中央文件分区占满整列并缩窄，右侧工具区加宽');
  check(proportions.web.x > proportions.files.right && proportions.web.y >= proportions.calendar.bottom && Math.abs(proportions.web.width - proportions.widgets.width) < 2, '网页独占右侧下方并与中央文件区分离');
  check(Math.abs(proportions.calendar.width - proportions.notes.width) < 2 && Math.abs(proportions.calendar.height - proportions.notes.height) < 2 && proportions.notes.x > proportions.calendar.right, '右上日历和便签等比例并排放大');
  check(await page.locator('.calendar-day').count() === 42, '日历完整六周网格');
  const oldMonth = await page.locator('#calendar-month').innerText();
  await page.locator('#calendar-prev').click();
  check(await page.locator('#calendar-month').innerText() !== oldMonth, '日历切换月份');
  await page.locator('#calendar-today').click();
  check(await page.locator('#calendar-month').innerText() === oldMonth, '日历回到今天');
  await page.locator('#add-category').click();
  await page.locator('#modal-input').fill('测试专用区');
  await page.locator('#modal-confirm').click();
  await expect(page.locator('.category-card')).toHaveCount(5);
  const categoryId = await page.evaluate(() => [...document.querySelectorAll('.category-card')].find(node => node.querySelector('h3').textContent === '测试专用区').dataset.category);
  check(Boolean(categoryId), '新建自定义分区');
  const added = await page.evaluate(async paths => window.desktop.invoke('add-paths', paths), files.map(name => path.join(fixtureDirectory, name)));
  check(added.ok && added.value.added === 3, '添加文件自动分类');
  await expect(page.locator('.file-item')).toHaveCount(3);
  check(await page.locator('[data-category="documents"] .file-item').count() === 1, '文档分类正确');
  check(await page.locator('[data-category="images"] .file-item').count() === 1, '图片分类正确');
  const itemId = await page.locator('[data-category="documents"] .file-item').getAttribute('data-item');
  await page.locator('[data-category="documents"] .file-item').dragTo(page.locator('[data-category="apps"]'));
  await expect(page.locator(`[data-category="apps"] [data-item="${itemId}"]`)).toHaveCount(1);
  check(true, '拖放准确移动指定文件入口');
  await page.locator(`[data-item="${itemId}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '测试专用区', exact: true }).click();
  await expect(page.locator(`[data-category="${categoryId}"] [data-item="${itemId}"]`)).toHaveCount(1);
  check(true, '通过右键移动入口到自定义分区');
  await page.locator('#search').fill('不存在的关键词');
  await expect(page.locator('.no-results')).toBeVisible();
  check(true, '搜索无结果状态');
  await page.locator('#search').fill('测试文档');
  await expect(page.locator('.file-item')).toHaveCount(1);
  check(true, '按文件名搜索');
  await page.locator('#search').fill('');
  await page.locator(`[data-item="${itemId}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移除入口', exact: true }).click();
  await page.locator('#modal-secondary').click();
  await expect(page.locator('.file-item')).toHaveCount(3);
  check(true, '取消移除保留文件入口');
  await page.locator(`[data-item="${itemId}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移除入口', exact: true }).click();
  await page.locator('#modal-confirm').click();
  await expect(page.locator('.file-item')).toHaveCount(2);
  check(fs.existsSync(path.join(fixtureDirectory, files[0])), '移除入口不删除源文件');
  await page.locator('#note-title').fill('持久化验证');
  await page.locator('#note-content').fill('第一行：中文便签\n第二行：<script>只是文本</script>');
  await expect(page.locator('#note-save-status')).toHaveText('已保存到本机');
  await page.locator('#add-note').click();
  await page.locator('#note-title').fill('第二页便签');
  await page.locator('#note-content').fill('多页内容独立保存');
  await expect(page.locator('#note-tabs .note-tab')).toHaveCount(2);
  await page.locator('#note-tabs .note-tab').first().click();
  await expect(page.locator('#note-content')).toHaveValue('第一行：中文便签\n第二行：<script>只是文本</script>');
  check(true, '多页便签切换与文本安全');
  await page.locator('#browser-address').fill('javascript:alert(1)');
  await page.locator('#browser-form').evaluate(form => form.requestSubmit());
  await expect(page.locator('#toast')).toContainText('仅支持');
  check(true, '阻止非 HTTP 网页地址');
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.locator('#browser-address').fill(url);
  await page.locator('#browser-form').evaluate(form => form.requestSubmit());
  await waitForRemote('document.title', '内嵌网页测试');
  await waitForRemote('document.readyState', 'complete');
  check(await page.locator('#web-welcome').isHidden(), '加载禁止 iframe 的网页');
  await checkBrowserBounds(page);
  await page.screenshot({ path: path.join(screenshotDirectory, 'browser-right.png') });
  const compactWeb = await page.locator('#browser-viewport').evaluate(node => { const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height }; });
  await page.locator('#browser-expand').click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('web-focus'))).toBe(true);
  const focused = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const web = box('#browser-viewport');
    return {
      width: web.width, height: web.height, dashboardWidth: box('.dashboard').width,
      organizer: getComputedStyle(document.querySelector('.left-column')).display,
      calendar: getComputedStyle(document.querySelector('.calendar-panel')).display,
      notes: getComputedStyle(document.querySelector('.notes-panel')).display,
      fits: document.documentElement.scrollWidth === innerWidth
    };
  });
  check(focused.organizer === 'none' && focused.calendar === 'none' && focused.notes === 'none', '展开网页空间时隐藏文件、日历和便签');
  check(focused.width > compactWeb.width * 1.8 && focused.height > compactWeb.height + 300 && Math.abs(focused.width - focused.dashboardWidth) < 2 && focused.fits, '展开后网页区域占满工作台并显著增高');
  await expect.poll(() => remote('Math.round(innerHeight)')).toBeGreaterThan(Math.round(focused.height) - 3);
  await checkBrowserBounds(page);
  check(true, '展开后内嵌网页获得与网页区域一致的高度');
  await page.locator('#browser-zoom-out').click();
  await page.locator('#browser-zoom-out').click();
  await expect(page.locator('#browser-zoom-reset')).toHaveText('80%');
  await expect.poll(() => remote('Math.round(innerWidth)')).toBeGreaterThan(Math.round(focused.width) + 100);
  await checkBrowserBounds(page);
  await page.screenshot({ path: path.join(screenshotDirectory, 'browser-focus.png') });
  await page.locator('#browser-zoom-reset').click();
  await expect(page.locator('#browser-zoom-reset')).toHaveText('100%');
  await expect.poll(() => remote('Math.round(innerWidth)')).toBeLessThan(Math.round(focused.width) + 3);
  check(true, '网页可缩小整页并一键恢复 100%');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('web-focus'))).toBe(false);
  await checkBrowserBounds(page);
  check(true, 'Esc 还原网页空间');
  check(await remote('typeof window.desktop + ":" + typeof require') === 'undefined:undefined', '内嵌网页无法访问 Node 或桌面接口');
  await remote('document.querySelector("#next").click()');
  await waitForRemote('document.querySelector("#page").textContent', '第二页');
  await expect(page.locator('#browser-back')).toBeEnabled();
  await page.locator('#browser-back').click();
  await waitForRemote('document.querySelector("#page").textContent', '首页');
  check(true, '网页导航与后退');
  await remote('document.querySelector("#popup").click()');
  await waitForRemote('location.pathname', '/popup');
  check(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1, '新窗口链接留在内嵌区');
  await page.locator('#add-category').click();
  const hidden = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every(view => !view.webContents || !view.webContents.getURL().startsWith('http:') || !view.getVisible()));
  check(hidden, '打开对话框时隐藏原生网页避免遮挡');
  await page.locator('#modal-secondary').click();
  await page.locator('#help-button').click();
  await expect(page.locator('#settings')).toBeVisible();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every(view => !view.webContents?.getURL().startsWith('http:') || !view.getVisible()))).toBe(true);
  check(true, '设置窗口不被原生网页遮挡');
  await expect(page.locator('#autostart-toggle')).toBeEnabled();
  await expect(page.locator('#autostart-toggle')).not.toBeChecked();
  await expect(page.locator('#autostart-status')).toContainText('已关闭');
  await page.locator('#autostart-toggle').click();
  await expect(page.locator('#autostart-toggle')).toBeChecked();
  await expect(page.locator('#autostart-status')).toContainText('已开启');
  await page.locator('#autostart-toggle').click();
  await expect(page.locator('#autostart-toggle')).not.toBeChecked();
  check(true, '开机自启动可在设置中开启和关闭');
  await page.locator('#settings-close').click();
  await checkBrowserBounds(page);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 740));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(1124);
  const layout = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const web = box('#browser-viewport');
    const note = box('#note-content');
    const browserPanel = box('.browser-panel');
    return { fits: document.documentElement.scrollWidth === innerWidth, webHeight: web.height, noteHeight: note.height, panelBottom: browserPanel.bottom, workspaceBottom: box('.workspace').bottom, rightSide: web.x > box('.organizer').right, calendarFits: box('.calendar-day:last-child').bottom <= box('.calendar-bottom').top };
  });
  check(layout.fits && layout.webHeight > 100 && layout.noteHeight > 100 && layout.panelBottom <= layout.workspaceBottom + 1 && layout.rightSide && layout.calendarFits, '最小窗口下右侧三区完整可用且不超出工作台');
  await checkBrowserBounds(page);
  const invalidDock = await page.evaluate(() => window.desktop.invoke('dock-activate', 'arbitrary-path-or-hwnd'));
  check(!invalidDock.ok, '拒绝不属于当前应用清单的启动参数');
  const dockIcon = `data:image/png;base64,${fs.readFileSync(path.join(root, 'src', 'icon.png')).toString('base64')}`;
  const dockItems = Array.from({ length: 25 }, (_, index) => ({
    id: `fixture-${index}`, title: index ? `测试应用 ${index}` : '<script>应用标题</script>', icon: dockIcon,
    running: index < 3, active: index === 1,
    windows: index === 0 ? [{ id: 'window-a', title: '测试窗口 A' }, { id: 'window-b', title: '<script>测试窗口 B</script>' }] : index === 1 ? [{ id: 'window-single', title: '<script>单窗口</script>' }] : []
  }));
  await application.evaluate(({ ipcMain, BrowserWindow }, items) => {
    globalThis.dockTest = { calls: [], originals: new Map() };
    for (const name of ['dock-ready', 'dock-activate', 'dock-window', 'embed-bounds', 'embed-show', 'embed-hide', 'embed-detach']) {
      globalThis.dockTest.originals.set(name, ipcMain._invokeHandlers.get(name));
      ipcMain.removeHandler(name);
      ipcMain.handle(name, (_event, ...args) => { globalThis.dockTest.calls.push([name, ...args]); return { ok: true }; });
    }
    globalThis.dockTest.originals.set('embed-attach', ipcMain._invokeHandlers.get('embed-attach'));
    ipcMain.removeHandler('embed-attach');
    ipcMain.handle('embed-attach', (_event, ...args) => {
      globalThis.dockTest.calls.push(['embed-attach', ...args]);
      if (globalThis.embedFail) return { ok: false, error: globalThis.embedFail };
      return { ok: true, value: { id: `embed-${args[0]}`, title: `内嵌 ${args[0]}`, icon: '' } };
    });
    BrowserWindow.getAllWindows()[0].webContents.send('dock-changed', { supported: true, error: '', revision: 777, items });
  }, dockItems);
  await expect(page.locator('.dock-button')).toHaveCount(25);
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-ready' && call[1] === 777 && call[2] === true))).toBe(true);
  check(true, '左栏图标完成解码后才确认可以接管');
  check(await page.locator('.dock-button').first().getAttribute('aria-label') === '<script>应用标题</script>' && await page.locator('#app-dock script').count() === 0, '应用名称按文本显示，不执行脚本');
  await page.locator('.dock-button').first().click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every(view => !view.webContents?.getURL().startsWith('http:') || !view.getVisible()))).toBe(true);
  await page.getByRole('menuitem', { name: '<script>测试窗口 B</script>', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-activate' && call[1] === 'window-b'))).toBe(true);
  await checkBrowserBounds(page);
  check(true, '多窗口菜单选择指定窗口，并正确避让原生网页');
  await page.locator('.dock-button').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveCount(6);
  await expect(page.locator('#context-menu .menu-label')).toHaveCount(2);
  await page.getByRole('menuitem', { name: '最大化', exact: true }).first().click();
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-window' && call[1] === 'window-a' && call[2] === 'maximize'))).toBe(true);
  await page.locator('.dock-button').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭窗口', exact: true }).nth(1).click();
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-window' && call[1] === 'window-b' && call[2] === 'close'))).toBe(true);
  check(true, '右键多窗口应用可分别最大化、最小化和关闭指定窗口');
  await page.locator('.dock-button').nth(3).click({ button: 'right' });
  await expect(page.locator('#context-menu')).toBeHidden();
  check(true, '未运行的应用不提供窗口操作');
  await page.locator('.dock-button').last().click();
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-activate' && call[1] === 'fixture-24'))).toBe(true);
  const dockLayout = await page.evaluate(() => ({ scroll: document.querySelector('#app-dock').scrollTop, settingsBottom: document.querySelector('#help-button').getBoundingClientRect().bottom, fits: document.documentElement.scrollWidth === innerWidth }));
  check(dockLayout.scroll > 0 && dockLayout.settingsBottom < 740 && dockLayout.fits, '大量应用可滚动，设置入口保持可见');
  await page.screenshot({ path: path.join(screenshotDirectory, 'dock-preview.png') });
  await application.evaluate(({ BrowserWindow }, item) => {
    globalThis.dockTest.calls = [];
    BrowserWindow.getAllWindows()[0].webContents.send('dock-changed', { supported: true, error: '', revision: 781, items: [item] });
  }, dockItems[1]);
  await expect(page.locator('.dock-button')).toHaveCount(1);
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-ready' && call[1] === 781 && call[2] === true))).toBe(true);
  await page.locator('.dock-button').click({ button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveCount(3);
  await page.getByRole('menuitem', { name: '最小化', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-window' && call[1] === 'window-single' && call[2] === 'minimize'))).toBe(true);
  check(true, '右键单窗口应用直接提供最大化、最小化和关闭');
  const duplicateWindows = [{ id: 'duplicate-a', title: '<script>同名窗口</script>' }, { id: 'duplicate-b', title: '<script>同名窗口</script>' }, { id: 'unique-c', title: '不同标题窗口' }];
  await application.evaluate(({ BrowserWindow }, item) => {
    globalThis.dockTest.calls = [];
    BrowserWindow.getAllWindows()[0].webContents.send('dock-changed', { supported: true, error: '', revision: 780, items: [item] });
  }, { ...dockItems[0], windows: duplicateWindows });
  await expect(page.locator('.dock-button')).toHaveCount(1);
  await expect(page.locator('.dock-count')).toHaveText('3');
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-ready' && call[1] === 780 && call[2] === true))).toBe(true);
  for (const [index, entry] of duplicateWindows.entries()) {
    await page.locator('.dock-button').click();
    const title = index < 2 ? `${entry.title}（窗口 ${index + 1}）` : entry.title;
    await expect(page.getByRole('menuitem')).toHaveCount(3);
    await page.getByRole('menuitem', { name: title, exact: true }).click();
    await expect.poll(() => application.evaluate((_, id) => globalThis.dockTest.calls.filter(call => call[0] === 'dock-activate' && call[1] === id).length, entry.id)).toBe(1);
  }
  check(true, '同名窗口显示不同序号且分别使用各自窗口ID，其他标题保持原样');
  check(await page.locator('#app-dock script, #context-menu script').count() === 0, '同名窗口菜单不执行标题中的脚本');
  await application.evaluate(({ BrowserWindow }, items) => {
    globalThis.dockTest.calls = [];
    globalThis.embedFail = '';
    BrowserWindow.getAllWindows()[0].webContents.send('dock-changed', { supported: true, error: '', revision: 782, items });
  }, [dockItems[1], dockItems[3]]);
  await expect(page.locator('.dock-button')).toHaveCount(2);
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-ready' && call[1] === 782 && call[2] === true))).toBe(true);
  const startEmbedDrag = id => page.evaluate(id => {
    const data = new DataTransfer();
    data.setData('application/x-harbor-dock', id);
    globalThis.__embedDrag = data;
    document.querySelector(`.dock-button[data-dock="${id}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    document.querySelector('.browser-panel').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, id);
  const dropEmbed = () => page.evaluate(() => {
    document.querySelector('.browser-panel').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: globalThis.__embedDrag }));
  });
  await startEmbedDrag('fixture-1');
  await expect(page.locator('#embed-drop')).toBeVisible();
  await dropEmbed();
  const embeddedTab = page.locator('.embed-tab[data-tab="embed-fixture-1"]');
  await expect(embeddedTab).toHaveClass(/active/);
  await expect(page.locator('#embed-tab-list .embed-tab')).toHaveCount(2);
  const attachCall = await application.evaluate(() => globalThis.dockTest.calls.find(call => call[0] === 'embed-attach'));
  check(attachCall?.[1] === 'fixture-1' && attachCall[3].width > 0 && attachCall[3].height > 0, '拖入应用空间后按当前区域大小内嵌应用');
  check(await page.locator('#native-viewport').isVisible() && !(await page.locator('#browser-viewport').isVisible()), '内嵌标签激活后显示原生应用区域');
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'embed-show' && call[1] === 'embed-fixture-1'))).toBe(true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('embed-flash', { id: 'embed-fixture-1', flashing: true }));
  await expect(embeddedTab).toHaveClass(/flashing/);
  check((await embeddedTab.getAttribute('title')).includes('有新消息'), '应用闪动时标签同步提示新消息');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('embed-flash', { id: 'embed-fixture-1', flashing: false }));
  await expect(embeddedTab).not.toHaveClass(/flashing/);
  check(true, '应用停止闪烁后标签恢复');
  await page.locator('.embed-tab[data-tab="web"]').click();
  await page.locator('.dock-button[data-dock="fixture-1"]').click();
  await expect(embeddedTab).toHaveClass(/active/);
  check(!(await application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-activate' && call[1] === 'fixture-1'))), '再次点击已内嵌应用切回标签而不是重复启动');
  const normalAttach = await application.evaluate(() => globalThis.dockTest.calls.filter(call => call[0] === 'embed-attach' && call[1] === 'fixture-1').pop());
  check(!(await page.evaluate(() => document.body.classList.contains('web-focus'))) && normalAttach[3].height < 400, '内嵌应用保持原来的应用空间大小');
  await page.locator('#browser-expand').click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('web-focus'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#toast')).toContainText('先关闭内嵌应用标签');
  check(await page.evaluate(() => document.body.classList.contains('web-focus')), '有内嵌应用时不能收起应用空间');
  await application.evaluate(() => { globalThis.embedFail = '该应用使用系统托管窗口，暂不支持内嵌'; });
  await startEmbedDrag('fixture-3');
  await dropEmbed();
  await expect(page.locator('#modal')).toBeVisible();
  await expect(page.locator('#modal-description')).toContainText('暂不支持内嵌');
  check(await page.locator('#embed-tab-list .embed-tab').count() === 2 && await page.locator('.embed-tab.loading').count() === 0, '不支持的应用内嵌失败后不残留空标签');
  await page.locator('#modal-confirm').click();
  await application.evaluate(() => { globalThis.embedFail = ''; });
  await embeddedTab.locator('.embed-tab-close').click();
  await expect(page.locator('#embed-tab-list .embed-tab')).toHaveCount(1);
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'embed-detach' && call[1] === 'embed-fixture-1'))).toBe(true);
  check(await page.locator('#browser-viewport').isVisible() && await page.locator('.embed-tab.active').getAttribute('data-tab') === 'web', '关闭标签归还应用窗口并回到网页');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('web-focus'))).toBe(false);
  check(true, '关闭全部内嵌应用后可收起应用空间');
  await application.evaluate(({ BrowserWindow }, items) => BrowserWindow.getAllWindows()[0].webContents.send('dock-changed', { supported: true, error: '', revision: 778, items }), [{ ...dockItems[0], icon: 'data:image/png;base64,YmFk' }]);
  await expect.poll(() => application.evaluate(() => globalThis.dockTest.calls.some(call => call[0] === 'dock-ready' && call[1] === 778 && call[2] === false))).toBe(true);
  check(true, '图标加载失败时拒绝隐藏系统应用图标');
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    for (const [name, original] of globalThis.dockTest.originals) { ipcMain.removeHandler(name); ipcMain.handle(name, original); }
    delete globalThis.dockTest;
    BrowserWindow.getAllWindows()[0].webContents.send('dock-changed', { supported: false, error: '测试组件不可用', revision: 779, items: [] });
  });
  await expect(page.locator('#app-dock')).toHaveText('系统任务栏保留');
  check(true, '后端失效时清空失效入口并保留系统任务栏提示');
  await page.locator('#browser-address').fill('http://127.0.0.1:1/');
  await page.locator('#browser-form').evaluate(form => form.requestSubmit());
  await expect(page.locator('#browser-error')).toBeVisible();
  check(true, '网页加载失败显示可恢复错误');
  await page.locator('#browser-home').click();
  await expect(page.locator('#web-welcome')).toBeVisible();
  check(true, '关闭网页回到起始页');
  await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-compact.png') });
  await page.locator('#note-content').fill('切换保存位置前的最后输入');
  await page.locator('#help-button').click();
  await expect(page.locator('#data-directory')).toHaveText(path.join(directory, 'data'));
  const selectDirectory = async (target, canceled = false) => application.evaluate(({ dialog }, selection) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: selection.canceled, filePaths: selection.canceled ? [] : [selection.target] };
    };
  }, { target, canceled });
  await selectDirectory('', true);
  await page.locator('#change-data-directory').click();
  await expect(page.locator('#change-data-directory')).toBeEnabled();
  await expect(page.locator('#data-directory')).toHaveText(path.join(directory, 'data'));
  check(true, '取消修改保存位置不改变数据目录');
  const occupied = path.join(directory, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'workspace.json'), '已有数据，不可覆盖');
  await selectDirectory(occupied);
  await page.locator('#change-data-directory').click();
  await expect(page.locator('#toast')).toContainText('原目录仍有效');
  check(fs.readFileSync(path.join(occupied, 'workspace.json'), 'utf8') === '已有数据，不可覆盖', '拒绝覆盖目标目录已有数据');
  const relocated = path.join(directory, 'relocated');
  await selectDirectory(relocated);
  await page.locator('#change-data-directory').click();
  await expect(page.locator('#data-directory')).toHaveText(relocated);
  const beforeClose = JSON.parse(fs.readFileSync(path.join(relocated, 'workspace.json'), 'utf8'));
  check(beforeClose.notes.some(note => note.content === '切换保存位置前的最后输入') && beforeClose.categories.length === 5 && beforeClose.items.length === 2, '更改目录前保存最后输入并完整复制分区与便签');
  check(fs.existsSync(path.join(directory, 'data', 'workspace.json')) && fs.existsSync(path.join(fixtureDirectory, files[0])), '保留原数据副本及原桌面文件');
  await page.screenshot({ path: path.join(screenshotDirectory, 'settings-data.png') });
  await page.locator('#settings-close').click();
  await page.locator('#note-content').fill('关闭瞬间保存验证');
  const child = application.process();
  const exited = new Promise(resolve => child.once('exit', resolve));
  await page.locator('#close').click();
  await exited;
  application = null;
  const saved = JSON.parse(fs.readFileSync(path.join(relocated, 'workspace.json'), 'utf8'));
  check(saved.notes.some(note => note.content === '关闭瞬间保存验证'), '关闭前将最后输入保存到新目录');
  check(child.exitCode === 0, '关闭窗口退出主进程');
  page = await launch();
  await expect(page.locator('#note-content')).toHaveValue('关闭瞬间保存验证');
  check(await page.locator('.category-card').count() === 5, '重新启动恢复分区和便签');
  await page.locator('#help-button').click();
  await expect(page.locator('#data-directory')).toHaveText(relocated);
  await page.locator('#settings-close').click();
  check(true, '重新启动记住新的数据保存路径');
  await application.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('bootstrap');
    ipcMain.removeHandler('bootstrap');
    ipcMain.handle('bootstrap', async (event, ...args) => {
      ipcMain.removeHandler('bootstrap');
      ipcMain.handle('bootstrap', original);
      const response = await original(event, ...args);
      event.sender.send('desktop-state', { active: true });
      return response;
    });
  });
  await page.reload();
  await expect(page.locator('.local-badge')).toContainText('桌面已接管');
  check(true, '接管通知早于初始化返回时不丢失状态');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('desktop-state', { active: false }));
  await expect(page.locator('.local-badge')).toContainText('本地工作空间');
  check(pageErrors.length === 0, '无界面 JavaScript 异常');
  await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-tested.png') });
  console.log(`UI integration checks passed: ${testCount}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close().catch(() => {});
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

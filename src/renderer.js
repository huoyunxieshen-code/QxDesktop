const $ = selector => document.querySelector(selector);
const api = window.desktop;
let state;
let dataDirectory = '';
let activeNote;
let noteTimer;
let noteQueue = Promise.resolve();
let toastTimer;
let selectedItem;
let modalResolve;
let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDate = new Date();
let lastDay;
let browserLoading = false;
let currentBrowserUrl = '';
let webFocus = false;
let dockRender = 0;
let dockState = { items: [] };
let embedTabs = [];
let activeTab = 'web';
let visibleEmbed = '';
const iconCache = new Map();
const builtInCategories = new Set(['documents', 'apps', 'images', 'others']);

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${['file', 'grid', 'image', 'folder', 'plus', 'more', 'check', 'globe'].includes(name) ? name : 'file'}`);
  svg.append(use);
  return svg;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 5500 : 3000);
}
async function invoke(channel, ...args) {
  const result = await api.invoke(channel, ...args);
  if (!result.ok) { toast(result.error, true); throw new Error(result.error); }
  return result.value;
}
function run(action) { Promise.resolve().then(action).catch(() => {}); }
function buttonIcon(name, title, action) {
  const button = element('button', 'icon-button');
  button.title = title;
  button.setAttribute('aria-label', title);
  button.append(icon(name));
  button.addEventListener('click', action);
  return button;
}
function imported(result) {
  if (!result.canceled) toast(`已收纳 ${result.added} 个文件入口${result.skipped ? `，跳过 ${result.skipped} 个重复或不可用项目` : ''}`);
}
function displayName(item) { return item.isDirectory ? item.name : item.name.replace(/\.lnk$/i, ''); }
function renderCategories() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  $('#file-count').textContent = `${state.items.length} 个文件`;
  const container = $('#categories');
  container.replaceChildren();
  let matchCount = 0;
  for (const category of state.categories) {
    const allItems = state.items.filter(item => item.categoryId === category.id);
    const categoryMatches = category.name.toLocaleLowerCase().includes(query);
    const items = allItems.filter(item => !query || categoryMatches || displayName(item).toLocaleLowerCase().includes(query));
    if (query && !categoryMatches && !items.length) continue;
    matchCount++;
    const card = element('article', 'category-card');
    card.dataset.category = category.id;
    const header = element('div', 'category-header');
    const categoryIcon = element('span', `mini-icon ${['blue', 'violet', 'green', 'amber'].includes(category.color) ? category.color : 'blue'}`);
    categoryIcon.append(icon(category.icon));
    const title = element('h3', '', category.name);
    title.title = category.name;
    const actions = element('div', 'category-actions');
    actions.append(buttonIcon('plus', `添加文件到${category.name}`, () => run(async () => imported(await invoke('add-files', category.id)))), buttonIcon('more', `管理${category.name}`, event => showCategoryMenu(event, category)));
    header.append(categoryIcon, title, element('span', 'category-count', String(allItems.length)), actions);
    const list = element('div', 'category-items');
    if (!items.length) {
      const empty = element('div', 'empty-category');
      empty.append(icon('plus'), element('span', '', query ? '没有匹配的文件' : '拖入文件，或点击 + 添加'));
      list.append(empty);
    }
    for (const item of items) {
      const file = element('button', `file-item${selectedItem === item.id ? ' selected' : ''}`);
      file.dataset.item = item.id;
      file.title = `${displayName(item)}\n${item.path}\n双击打开 · 右键管理`;
      file.draggable = true;
      file.setAttribute('aria-label', displayName(item));
      file.append(icon(item.isDirectory ? 'folder' : 'file'), element('span', '', displayName(item)));
      const setIcon = image => {
        if (!image || !file.isConnected) return;
        const img = element('img');
        img.src = image;
        img.alt = '';
        img.draggable = false;
        file.firstChild.replaceWith(img);
      };
      if (iconCache.has(item.id)) requestAnimationFrame(() => setIcon(iconCache.get(item.id)));
      else api.invoke('item-icon', item.id).then(result => { if (result.ok && result.value) { iconCache.set(item.id, result.value); setIcon(result.value); } });
      file.addEventListener('click', () => {
        selectedItem = item.id;
        document.querySelectorAll('.file-item.selected').forEach(node => node.classList.remove('selected'));
        file.classList.add('selected');
      });
      file.addEventListener('dblclick', () => run(() => invoke('item-action', item.id, 'open')));
      file.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); run(() => invoke('item-action', item.id, 'open')); }
        if (event.key === 'Delete') { event.preventDefault(); removeItem(item); }
      });
      file.addEventListener('contextmenu', event => showItemMenu(event, item));
      file.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-harbor-item', item.id); event.dataTransfer.effectAllowed = 'move'; });
      file.addEventListener('dragend', () => document.querySelectorAll('.drag-over').forEach(node => node.classList.remove('drag-over')));
      list.append(file);
    }
    card.addEventListener('dragover', event => { event.preventDefault(); card.classList.add('drag-over'); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-harbor-item') ? 'move' : 'copy'; });
    card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget)) card.classList.remove('drag-over'); });
    card.addEventListener('drop', event => {
      event.preventDefault();
      card.classList.remove('drag-over');
      const id = event.dataTransfer.getData('application/x-harbor-item');
      if (id) run(() => invoke('item-action', id, 'move', category.id));
      else {
        const paths = [...event.dataTransfer.files].map(file => api.pathForFile(file)).filter(Boolean);
        if (paths.length) run(async () => imported(await invoke('add-paths', paths, category.id)));
      }
    });
    card.append(header, list);
    container.append(card);
  }
  if (!matchCount) container.append(element('div', 'no-results', '没有找到匹配的文件或分区，试试其他关键词。'));
}
function currentNativeTab() {
  return activeTab === 'web' ? null : embedTabs.find(tab => tab.id === activeTab) || null;
}
function activeReadyEmbed() {
  const tab = currentNativeTab();
  return tab && tab.status === 'ready' ? tab : null;
}
function overlayBlocked() { return $('#modal').open || $('#settings').open || !$('#context-menu').hidden; }
function syncNativeBounds() {
  const tab = activeReadyEmbed();
  if (!tab) return;
  const bounds = $('#native-viewport').getBoundingClientRect();
  if (bounds.width < 10 || bounds.height < 10) return;
  api.invoke('embed-bounds', tab.id, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}
function syncSurfaces() {
  const blocked = overlayBlocked();
  const tab = blocked ? null : activeReadyEmbed();
  const next = tab ? tab.id : '';
  api.invoke('browser-visible', !blocked && activeTab === 'web');
  if (next === visibleEmbed) return;
  if (visibleEmbed) api.invoke('embed-hide', visibleEmbed);
  visibleEmbed = next;
  if (next) { syncNativeBounds(); api.invoke('embed-show', next); }
}
function updateBrowserVisibility() { syncSurfaces(); }
function tabNode(tab) {
  const button = element('button', `embed-tab${tab.id === activeTab ? ' active' : ''}${tab.status === 'loading' ? ' loading' : ''}${tab.flash ? ' flashing' : ''}`);
  button.type = 'button';
  button.dataset.tab = tab.id;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-selected', String(tab.id === activeTab));
  button.title = tab.kind === 'web' ? '网页' : `${tab.title}${tab.flash ? ' · 有新消息' : ''} · 关闭标签可恢复窗口`;
  if (tab.kind === 'web') button.append(icon('globe'));
  else if (tab.icon) {
    const image = element('img');
    image.src = tab.icon;
    image.alt = '';
    image.draggable = false;
    button.append(image);
  } else button.append(icon('grid'));
  button.append(element('span', 'embed-tab-title', tab.kind === 'web' ? '网页' : tab.title));
  if (tab.kind !== 'web') {
    const close = element('span', 'embed-tab-close', '×');
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', `关闭${tab.title}标签并恢复窗口`);
    close.tabIndex = 0;
    const closeTab = event => { event.preventDefault(); event.stopPropagation(); run(() => closeEmbedTab(tab.id)); };
    close.addEventListener('click', closeTab);
    close.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') closeTab(event); });
    button.append(close);
  }
  button.addEventListener('click', () => activateTab(tab.id));
  return button;
}
function renderTabs() {
  $('#embed-tab-list').replaceChildren(tabNode({ id: 'web', kind: 'web', title: '网页' }), ...embedTabs.map(tabNode));
}
function renderSurface() {
  const tab = currentNativeTab();
  const native = Boolean(tab);
  document.body.classList.toggle('embed-active', native);
  $('#browser-form').hidden = native;
  $('#browser-viewport').hidden = native;
  $('#native-viewport').hidden = !native;
  $('#browser-external').hidden = native;
  $('.browser-zoom').hidden = native;
  if (native) {
    $('#browser-error').hidden = true;
  } else {
    $('#browser-error').hidden = !$('#browser-error').textContent;
  }
}
function stopTabFlash(tab) {
  clearTimeout(tab.flashTimer);
  tab.flashTimer = undefined;
  tab.flash = false;
}
function activateTab(id) {
  if (id !== 'web' && !embedTabs.some(tab => tab.id === id)) id = 'web';
  const tab = embedTabs.find(entry => entry.id === id);
  if (tab) stopTabFlash(tab);
  activeTab = id;
  renderTabs();
  renderSurface();
  syncSurfaces();
  requestAnimationFrame(() => { syncBrowserBounds(); syncNativeBounds(); });
}
async function closeEmbedTab(id) {
  const tab = embedTabs.find(entry => entry.id === id);
  if (!tab) return;
  stopTabFlash(tab);
  embedTabs = embedTabs.filter(entry => entry !== tab);
  if (activeTab === id) activeTab = embedTabs.length ? embedTabs[embedTabs.length - 1].id : 'web';
  if (visibleEmbed === id) { api.invoke('embed-hide', id); visibleEmbed = ''; }
  renderTabs();
  renderSurface();
  syncSurfaces();
  if (tab.status === 'ready') api.invoke('embed-detach', tab.id);
  requestAnimationFrame(() => { syncBrowserBounds(); syncNativeBounds(); });
}
function embedLost(value) {
  if (!value || typeof value.id !== 'string') return;
  const tab = embedTabs.find(entry => entry.id === value.id);
  if (!tab) return;
  stopTabFlash(tab);
  embedTabs = embedTabs.filter(entry => entry !== tab);
  if (activeTab === tab.id) activeTab = embedTabs.length ? embedTabs[embedTabs.length - 1].id : 'web';
  if (visibleEmbed === tab.id) visibleEmbed = '';
  renderTabs();
  renderSurface();
  syncSurfaces();
  if (value.reason) toast(value.reason);
  requestAnimationFrame(syncNativeBounds);
}
function embedFlash(value) {
  if (!value || typeof value.id !== 'string') return;
  const tab = embedTabs.find(entry => entry.id === value.id);
  if (!tab || tab.status !== 'ready') return;
  clearTimeout(tab.flashTimer);
  tab.flash = value.flashing === true;
  // Windows reports one notification per flash toggle; a short silence means
  // the app stopped asking for attention or the window was activated.
  tab.flashTimer = tab.flash ? setTimeout(() => { tab.flash = false; tab.flashTimer = undefined; renderTabs(); }, 2500) : undefined;
  renderTabs();
}
function embedAttach(dockId, windowId) {
  const bounds = $('#native-viewport').getBoundingClientRect();
  return api.invoke('embed-attach', dockId, windowId, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}
async function embedApp(dockId, windowId = '') {
  const item = (dockState.items || []).find(entry => entry.id === dockId);
  if (!item) { toast('应用入口已失效，请重试', true); return; }
  if (embedTabs.some(tab => tab.dockId === dockId && tab.status === 'loading')) { toast('这个应用正在内嵌，请稍候'); return; }
  const pendingId = `pending-${crypto.randomUUID()}`;
  const pending = { id: pendingId, dockId, windowId, title: item.title, icon: item.icon || '', status: 'loading', flash: false };
  embedTabs.push(pending);
  activateTab(pending.id);
  const result = await embedAttach(dockId, windowId);
  if (!result.ok) {
    embedTabs = embedTabs.filter(tab => tab !== pending);
    if (activeTab === pendingId) activeTab = embedTabs.length ? embedTabs[embedTabs.length - 1].id : 'web';
    renderTabs();
    renderSurface();
    syncSurfaces();
    await showModal({
      title: '这个应用暂时不能内嵌',
      description: result.error,
      confirm: '知道了',
      cancel: false
    });
    return;
  }
  const wasActive = activeTab === pendingId;
  Object.assign(pending, { id: result.value.id, title: result.value.title || item.title, icon: result.value.icon || item.icon || '', status: 'ready' });
  if (wasActive) activeTab = pending.id;
  renderTabs();
  renderSurface();
  syncSurfaces();
  if (activeTab !== pending.id) api.invoke('embed-hide', pending.id);
}
function showEmbedPicker() {
  const items = dockState.items || [];
  if (!items.length) { toast('先从左栏启动一个应用，再把它拖进应用空间'); return; }
  const anchor = $('#embed-add').getBoundingClientRect();
  menu({ preventDefault() {}, stopPropagation() {}, clientX: anchor.left, clientY: anchor.bottom + 6 }, [
    { label: '选择要内嵌的应用' },
    ...items.map(item => ({ text: item.title, action: () => embedApp(item.id) }))
  ]);
}
function embedDragActive(event) { return [...(event.dataTransfer?.types || [])].includes('application/x-harbor-dock'); }
function clearEmbedDrop() { $('.browser-panel').classList.remove('embed-dragging'); $('#embed-drop').hidden = true; }
function setWebFocus(value) {
  if (!value && embedTabs.some(tab => tab.status === 'ready' || tab.status === 'loading')) {
    toast('先关闭内嵌应用标签，再收起应用空间');
    return;
  }
  webFocus = value;
  document.body.classList.toggle('web-focus', value);
  const button = $('#browser-expand');
  button.title = value ? '还原应用空间' : '展开应用空间';
  button.setAttribute('aria-label', button.title);
  button.querySelector('use').setAttribute('href', value ? '#i-collapse' : '#i-expand');
  requestAnimationFrame(() => { syncBrowserBounds(); syncNativeBounds(); });
}
function closeContextMenu() { $('#context-menu').hidden = true; updateBrowserVisibility(); }
function menu(event, entries) {
  event.preventDefault();
  event.stopPropagation();
  const target = $('#context-menu');
  target.replaceChildren();
  for (const entry of entries) {
    if (entry.separator) { target.append(element('hr')); continue; }
    if (entry.label) { target.append(element('div', 'menu-label', entry.label)); continue; }
    const button = element('button', entry.danger ? 'danger' : '', entry.text);
    button.setAttribute('role', 'menuitem');
    button.disabled = Boolean(entry.disabled);
    button.addEventListener('click', () => { closeContextMenu(); run(entry.action); });
    target.append(button);
  }
  target.hidden = false;
  target.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - target.offsetWidth - 8))}px`;
  target.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - target.offsetHeight - 8))}px`;
  updateBrowserVisibility();
}
function showCategoryMenu(event, category) {
  menu(event, [
    { text: '添加文件', action: async () => imported(await invoke('add-files', category.id)) },
    { text: '添加文件夹', action: async () => imported(await invoke('add-files', category.id, true)) },
    { separator: true },
    { text: '重命名分区', action: () => editCategory(category) },
    ...(!builtInCategories.has(category.id) ? [{ text: '删除分区', danger: true, action: async () => {
      if (await showModal({ title: '删除这个分区？', description: '文件入口将移入「其他收纳」默认分区，不会删除源文件。', confirm: '删除分区' })) await invoke('category-remove', category.id);
    } }] : [])
  ]);
}
function showItemMenu(event, item) {
  menu(event, [
    { text: '打开文件', action: () => invoke('item-action', item.id, 'open') },
    { text: '打开所在位置', action: () => invoke('item-action', item.id, 'reveal') },
    { separator: true }, { label: '移动到分区（不移动源文件）' },
    ...state.categories.filter(category => category.id !== item.categoryId).map(category => ({ text: category.name, action: () => invoke('item-action', item.id, 'move', category.id) })),
    { separator: true }, { text: '移除入口', danger: true, action: () => removeItem(item) }
  ]);
}
async function removeItem(item) {
  if (await showModal({ title: '移除这个文件入口？', description: `仅从工作台移除「${displayName(item)}」，源文件会保留在原位置。`, confirm: '移除入口' })) await invoke('item-action', item.id, 'remove');
}
function showModal({ title, description, input, confirm = '确定', details = '', cancel = true }) {
  closeContextMenu();
  $('#modal-title').textContent = title;
  $('#modal-description').textContent = description;
  $('#modal-input').hidden = input === undefined;
  $('#modal-input').value = input || '';
  $('#modal-details').textContent = details;
  $('#modal-details').hidden = !details;
  $('#modal-confirm').textContent = confirm;
  $('#modal-secondary').textContent = '取消';
  $('#modal-secondary').hidden = !cancel;
  $('#modal').showModal();
  updateBrowserVisibility();
  if (input !== undefined) { $('#modal-input').focus(); $('#modal-input').select(); }
  return new Promise(resolve => { modalResolve = resolve; });
}
function finishModal(accepted) {
  const input = $('#modal-input');
  if (accepted && !input.hidden && !input.value.trim()) { input.focus(); return; }
  $('#modal').close();
  const result = !accepted ? false : input.hidden ? true : input.value.trim();
  modalResolve?.(result);
  modalResolve = null;
  updateBrowserVisibility();
}
async function editCategory(category) {
  const name = await showModal({ title: category ? '重命名分区' : '给文件一个新空间', description: '按项目、用途或习惯，建立属于你的桌面秩序。', input: category?.name || '', confirm: category ? '保存名称' : '创建分区' });
  if (name) await invoke('category-edit', category?.id || null, name);
}
function localDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function renderCalendar() {
  const year = month.getFullYear();
  const index = month.getMonth();
  $('#calendar-month').textContent = `${year} 年 ${index + 1} 月`;
  const start = new Date(year, index, 1);
  start.setDate(1 - (start.getDay() + 6) % 7);
  const today = localDate(new Date());
  const selected = localDate(selectedDate);
  const container = $('#calendar-days');
  container.replaceChildren();
  for (let offset = 0; offset < 42; offset++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    const key = localDate(date);
    const button = element('button', `calendar-day${date.getMonth() !== index ? ' outside' : ''}${key === today ? ' today' : ''}${key === selected ? ' selected' : ''}`, String(date.getDate()));
    button.dataset.date = key;
    button.setAttribute('aria-label', date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }));
    if (key === today) button.setAttribute('aria-current', 'date');
    button.addEventListener('click', () => { selectedDate = date; if (date.getMonth() !== index) month = new Date(date.getFullYear(), date.getMonth(), 1); renderCalendar(); });
    container.append(button);
  }
  $('#selected-date').textContent = `${selected === today ? '今天 · ' : ''}${selectedDate.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}`;
}
function updateClock() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  $('#clock').replaceChildren(document.createTextNode(`${pad(now.getHours())}:${pad(now.getMinutes())}`), element('span', '', pad(now.getSeconds())));
  $('#today-label').textContent = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('#tile-month').textContent = now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  $('#tile-day').textContent = String(now.getDate());
  if (lastDay !== localDate(now)) { lastDay = localDate(now); renderCalendar(); }
}
function renderNoteTabs() {
  const container = $('#note-tabs');
  container.replaceChildren();
  for (const note of state.notes) {
    const button = element('button', `note-tab${note.id === activeNote.id ? ' active' : ''}`, note.title || '未命名');
    button.title = note.title || '未命名';
    button.addEventListener('click', () => { activeNote = note; state.activeNoteId = note.id; renderNotes(); queueNoteSave(); });
    container.append(button);
  }
}
function renderNotes() {
  renderNoteTabs();
  $('#note-title').value = activeNote.title;
  $('#note-content').value = activeNote.content;
}
function setNoteStatus(text, error = false) {
  $('#note-save-status').replaceChildren(icon('check'), document.createTextNode(text));
  $('#note-save-status').classList.toggle('saving-error', error);
}
function queueNoteSave() {
  clearTimeout(noteTimer);
  setNoteStatus('正在保存…');
  noteTimer = setTimeout(flushNotes, 250);
}
function flushNotes() {
  clearTimeout(noteTimer);
  const notes = structuredClone(state.notes);
  const id = activeNote.id;
  noteQueue = noteQueue.catch(() => {}).then(async () => {
    const result = await api.invoke('notes-save', notes, id);
    if (result.ok) setNoteStatus('已保存到本机');
    else { setNoteStatus('保存失败，请检查磁盘', true); toast(result.error, true); }
    return result.ok;
  });
  return noteQueue;
}
function syncBrowserBounds() {
  if ($('#browser-viewport').hidden) return;
  const bounds = $('#browser-viewport').getBoundingClientRect();
  api.invoke('browser-bounds', { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}
function updateDesktop(value) {
  if (!value) return;
  $('.local-badge').replaceChildren(element('span'), document.createTextNode(value.active ? ' 桌面已接管 · 退出自动恢复' : ' 本地工作空间'));
  $('.local-badge').title = value.active ? '原桌面图标暂时隐藏，文件与图标位置保持不变，退出后恢复原来的显示状态。' : '';
  if (value.error) toast(value.error, true);
}
let lastTaskbarError = '';
function updateTaskbar(value) {
  if (!value) return;
  $('#taskbar-status').textContent = value.error || (value.hidden ? '应用图标已临时移到左侧；开始、搜索、托盘和时钟保持原样。最小化时任务栏只保留 QX桌面，退出时完全恢复。' : '底部应用图标当前保持显示；左侧应用栏准备好后自动接管，退出时恢复。');
  if (value.error && value.error !== lastTaskbarError) toast(value.error, true);
  lastTaskbarError = value.error || '';
}
function dockWindowTitle(title) { return title.length > 32 ? `${title.slice(0, 31)}…` : title; }
function embeddedTabFor(windowId, itemId) {
  const ready = embedTabs.filter(tab => tab.status === 'ready');
  return ready.find(tab => tab.windowId === windowId) || ready.find(tab => tab.dockId === itemId) || null;
}
function showDockWindowMenu(event, item) {
  const entries = [];
  item.windows.forEach((entry, index) => {
    if (index) entries.push({ separator: true });
    entries.push({ label: dockWindowTitle(item.windows.some((other, otherIndex) => otherIndex !== index && other.title === entry.title) ? `${entry.title}（窗口 ${index + 1}）` : entry.title) });
    for (const [text, action, danger] of [['最大化', 'maximize'], ['最小化', 'minimize'], ['关闭窗口', 'close', true]])
      entries.push({ text, danger, action: () => invoke('dock-window', entry.id, action) });
  });
  menu(event, entries);
}
function renderDock(value) {
  if (!value) return;
  dockState = value;
  const container = $('#app-dock');
  const scroll = container.scrollTop;
  const focused = document.activeElement?.dataset.dock;
  const render = ++dockRender;
  const nodes = [];
  for (const item of value.items || []) {
    const button = element('button', `dock-button${item.running ? ' running' : ''}${item.active ? ' active' : ''}`);
    button.dataset.dock = item.id;
    button.title = `${item.title}${item.running ? ' · 正在运行' : ' · 点击启动'}\n拖到右下角应用空间，可作为标签内嵌${item.running && item.windows?.length ? '\n右键：最大化、最小化或关闭窗口' : ''}`;
    button.setAttribute('aria-label', item.title);
    button.draggable = true;
    button.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-harbor-dock', item.id);
      event.dataTransfer.effectAllowed = 'copy';
    });
    if (item.icon) {
      const image = element('img');
      image.src = item.icon;
      image.alt = '';
      image.draggable = false;
      button.append(image);
    } else button.append(icon('grid'));
    button.append(element('span', 'dock-name', item.title));
    if (item.windows?.length > 1) button.append(element('span', 'dock-count', String(item.windows.length)));
    button.addEventListener('click', event => {
      if (item.windows?.length > 1) {
        const bounds = button.getBoundingClientRect();
        menu({ clientX: bounds.right + 7, clientY: bounds.top, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, item.windows.map((entry, index) => ({
          text: item.windows.some((other, otherIndex) => otherIndex !== index && other.title === entry.title) ? `${entry.title}（窗口 ${index + 1}）` : entry.title,
          action: () => {
            const embedded = embeddedTabFor(entry.id, item.id);
            if (embedded) activateTab(embedded.id); else invoke('dock-activate', entry.id);
          }
        })));
      } else {
        const embedded = embeddedTabFor(item.windows?.[0]?.id, item.id);
        if (embedded) activateTab(embedded.id); else run(() => invoke('dock-activate', item.id));
      }
    });
    if (item.running && item.windows?.length) {
      button.addEventListener('contextmenu', event => showDockWindowMenu(event, item));
      button.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const bounds = button.getBoundingClientRect();
        showDockWindowMenu({ preventDefault() {}, stopPropagation() {}, clientX: bounds.right + 7, clientY: bounds.top }, item);
      });
    }
    nodes.push(button);
  }
  container.replaceChildren(...nodes);
  if (!nodes.length) container.append(element('span', 'dock-empty', value.error ? '系统任务栏保留' : '暂无应用'));
  container.title = value.error || '任务栏应用：点击启动或切换';
  container.scrollTop = scroll;
  if (focused) [...container.children].find(node => node.dataset.dock === focused)?.focus({ preventScroll: true });
  if (value.supported) {
    const images = [...container.querySelectorAll('img')];
    Promise.all(images.map(image => image.decode().then(() => true, () => false))).then(decoded => {
      if (render !== dockRender) return;
      // Do not wait for requestAnimationFrame: Chromium pauses frames while the
      // window is minimized, which used to starve the takeover acknowledgement.
      api.invoke('dock-ready', value.revision, nodes.length > 0 && images.length === nodes.length && decoded.every(Boolean));
    });
  }
}
function updateBrowser(value) {
  if (value.url) {
    currentBrowserUrl = value.url;
    if (document.activeElement !== $('#browser-address')) $('#browser-address').value = value.url;
  }
  if (value.loading !== undefined) browserLoading = value.loading;
  if (value.canGoBack !== undefined) $('#browser-back').disabled = !value.canGoBack;
  if (value.canGoForward !== undefined) $('#browser-forward').disabled = !value.canGoForward;
  if (value.zoom !== undefined) $('#browser-zoom-reset').textContent = `${value.zoom}%`;
  if (value.error !== undefined) {
    $('#browser-error').textContent = value.error;
    $('#browser-error').hidden = !value.error;
  }
  if (value.home) {
    currentBrowserUrl = '';
    $('#browser-address').value = '';
    $('#web-welcome').hidden = false;
  }
  $('#browser-reload').title = browserLoading ? '停止加载' : '刷新网页';
  requestAnimationFrame(syncBrowserBounds);
}
async function refreshAutostart() {
  const toggle = $('#autostart-toggle');
  const result = await invoke('autostart-get');
  toggle.checked = result.enabled;
  toggle.disabled = !result.supported;
  $('#autostart-status').textContent = !result.supported ? '当前系统不支持开机自启动。' : result.enabled ? '已开启：登录 Windows 后自动打开 QX桌面。' : '已关闭：需要手动打开 QX桌面。';
}
async function openBrowser() {
  const raw = $('#browser-address').value.trim();
  if (!raw) { toast('请先输入要打开的网址'); $('#browser-address').focus(); return; }
  const url = await invoke('browser-navigate', raw);
  currentBrowserUrl = url;
  $('#browser-address').value = url;
  $('#browser-address').blur();
  $('#web-welcome').hidden = true;
  requestAnimationFrame(syncBrowserBounds);
}

async function initialize() {
  if (!api) { document.body.textContent = '请使用桌面程序启动QX桌面。'; return; }
  let latestDesktopState;
  let latestDock;
  let latestTaskbar;
  api.on('desktop-state', value => { latestDesktopState = value; updateDesktop(value); });
  api.on('dock-changed', value => { latestDock = value; renderDock(value); });
  api.on('taskbar-state', value => { latestTaskbar = value; updateTaskbar(value); });
  api.on('embed-lost', embedLost);
  api.on('embed-flash', embedFlash);
  const bootstrap = await invoke('bootstrap');
  state = bootstrap.state;
  dataDirectory = bootstrap.dataDirectory;
  if (bootstrap.preview) $('.local-badge').textContent = '界面预览模式';
  else updateDesktop(latestDesktopState ?? bootstrap.desktopState);
  renderDock(latestDock ?? bootstrap.dock);
  updateTaskbar(latestTaskbar ?? bootstrap.taskbarState);
  renderTabs();
  renderSurface();
  activeNote = state.notes.find(note => note.id === state.activeNoteId) || state.notes[0];
  renderCategories();
  renderNotes();
  updateClock();
  setInterval(updateClock, 1000);
  if (bootstrap.recovered) toast('数据文件异常，原文件已保留为 recovery 备份，可在数据目录找回', true);
  api.on('state-changed', next => { state = { ...next, notes: state.notes, activeNoteId: activeNote.id }; renderCategories(); });
  api.on('storage-error', message => toast(message, true));
  api.on('browser-state', updateBrowser);
  api.on('prepare-close', () => run(async () => { await flushNotes(); await invoke('close-ready'); }));
  $('#search').addEventListener('input', renderCategories);
  $('#import-desktop').addEventListener('click', () => run(async () => {
    $('#import-desktop').disabled = true;
    try { imported(await invoke('import-desktop')); } finally { $('#import-desktop').disabled = false; }
  }));
  $('#add-category').addEventListener('click', () => run(() => editCategory()));
  $('#calendar-prev').addEventListener('click', () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); renderCalendar(); });
  $('#calendar-next').addEventListener('click', () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); renderCalendar(); });
  $('#calendar-today').addEventListener('click', () => { selectedDate = new Date(); month = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1); renderCalendar(); });
  $('#note-title').addEventListener('input', () => { activeNote.title = $('#note-title').value; activeNote.updatedAt = Date.now(); renderNoteTabs(); queueNoteSave(); });
  $('#note-content').addEventListener('input', () => { activeNote.content = $('#note-content').value; activeNote.updatedAt = Date.now(); queueNoteSave(); });
  $('#add-note').addEventListener('click', () => {
    if (state.notes.length >= 100) { toast('最多支持 100 页便签'); return; }
    const note = { id: crypto.randomUUID(), title: '新便签', content: '', updatedAt: Date.now() };
    state.notes.push(note);
    activeNote = note;
    renderNotes();
    queueNoteSave();
    $('#note-title').focus();
    $('#note-title').select();
  });
  $('#delete-note').addEventListener('click', () => run(async () => {
    if (!await showModal({ title: '删除这页便签？', description: `「${activeNote.title || '未命名'}」的内容将被删除，此操作无法撤销。`, confirm: '删除便签' })) return;
    state.notes = state.notes.filter(note => note.id !== activeNote.id);
    if (!state.notes.length) state.notes.push({ id: crypto.randomUUID(), title: '随手记', content: '', updatedAt: Date.now() });
    activeNote = state.notes[0];
    renderNotes();
    await flushNotes();
  }));
  $('#browser-form').addEventListener('submit', event => { event.preventDefault(); run(openBrowser); });
  for (const action of ['back', 'forward', 'home', 'external']) $('#browser-' + action).addEventListener('click', () => run(() => invoke('browser-action', action)));
  $('#browser-expand').addEventListener('click', () => setWebFocus(!webFocus));
  for (const action of ['in', 'out', 'reset']) $('#browser-zoom-' + action).addEventListener('click', () => run(async () => {
    $('#browser-zoom-reset').textContent = `${await invoke('browser-zoom', action)}%`;
  }));
  $('#browser-reload').addEventListener('click', () => run(() => invoke('browser-action', browserLoading ? 'stop' : 'reload')));
  $('#start-browsing').addEventListener('click', () => $('#browser-address').focus());
  $('#embed-add').addEventListener('click', showEmbedPicker);
  const surfacePanel = $('.browser-panel');
  surfacePanel.addEventListener('dragover', event => {
    if (!embedDragActive(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    $('#embed-drop').hidden = false;
  });
  surfacePanel.addEventListener('dragleave', event => { if (!surfacePanel.contains(event.relatedTarget)) clearEmbedDrop(); });
  surfacePanel.addEventListener('drop', event => {
    const dockId = event.dataTransfer.getData('application/x-harbor-dock');
    clearEmbedDrop();
    if (!dockId) return;
    event.preventDefault();
    run(() => embedApp(dockId));
  });
  $('#modal-form').addEventListener('submit', event => { event.preventDefault(); finishModal(true); });
  $('#modal-secondary').addEventListener('click', () => finishModal(false));
  $('#modal-close').addEventListener('click', () => finishModal(false));
  $('#modal').addEventListener('cancel', event => { event.preventDefault(); finishModal(false); });
  $('#help-button').addEventListener('click', () => {
    closeContextMenu();
    $('#data-directory').textContent = dataDirectory;
    $('#settings').showModal();
    updateBrowserVisibility();
    run(refreshAutostart);
  });
  $('#autostart-toggle').addEventListener('change', event => {
    const toggle = event.target;
    const desired = toggle.checked;
    toggle.disabled = true;
    run(async () => {
      try {
        const result = await invoke('autostart-set', desired);
        toggle.checked = result.enabled;
        $('#autostart-status').textContent = result.enabled ? '已开启：登录 Windows 后自动打开 QX桌面。' : '已关闭：需要手动打开 QX桌面。';
        toast(result.enabled === desired ? (desired ? '已开启开机自启动' : '已关闭开机自启动') : '开机自启动未能更改，请检查系统权限');
      } catch { toggle.checked = !desired; }
      finally { toggle.disabled = false; }
    });
  });
  $('#settings-close').addEventListener('click', () => $('#settings').close());
  $('#settings').addEventListener('close', updateBrowserVisibility);
  $('#settings-open-directory').addEventListener('click', () => run(() => invoke('open-data-directory')));
  $('#change-data-directory').addEventListener('click', () => run(async () => {
    const button = $('#change-data-directory');
    button.disabled = true;
    try {
      if (!await flushNotes()) return;
      const result = await invoke('change-data-directory');
      if (result.canceled) return;
      dataDirectory = result.directory;
      $('#data-directory').textContent = dataDirectory;
      toast('保存位置已更新，原目录副本已保留');
    } finally { button.disabled = false; }
  }));
  for (const action of ['minimize', 'maximize', 'close']) $('#' + action).addEventListener('click', () => run(() => invoke('window-action', action)));
  document.addEventListener('pointerdown', event => { if (!$('#context-menu').contains(event.target)) closeContextMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!$('#context-menu').hidden) closeContextMenu();
      else if (webFocus && !$('#modal').open && !$('#settings').open) setWebFocus(false);
    }
    if (event.ctrlKey && currentBrowserUrl && !event.altKey && ['=', '+', '-', '_', '0'].includes(event.key)) {
      event.preventDefault();
      const action = event.key === '0' ? 'reset' : event.key === '-' || event.key === '_' ? 'out' : 'in';
      run(async () => { $('#browser-zoom-reset').textContent = `${await invoke('browser-zoom', action)}%`; });
    }
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f' && !$('#modal').open && !$('#settings').open) { event.preventDefault(); $('#search').focus(); $('#search').select(); }
    if (event.ctrlKey && event.key.toLowerCase() === 'l' && !$('#modal').open && !$('#settings').open && activeTab === 'web') { event.preventDefault(); $('#browser-address').focus(); $('#browser-address').select(); }
  });
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => event.preventDefault());
  document.addEventListener('dragend', clearEmbedDrop);
  new ResizeObserver(syncBrowserBounds).observe($('#browser-viewport'));
  new ResizeObserver(() => syncNativeBounds()).observe($('#native-viewport'));
  window.addEventListener('resize', () => { syncBrowserBounds(); syncNativeBounds(); });
  requestAnimationFrame(() => { syncBrowserBounds(); syncNativeBounds(); });
  if (state.browserUrl) { $('#browser-address').value = state.browserUrl; await openBrowser(); }
}
initialize().catch(error => toast(`启动失败：${error.message}`, true));

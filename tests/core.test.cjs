'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults, normalizeUrl, classify, addPaths, ignorePath, validState, Store, resolveDataDirectory, relocateStore } = require('../src/core.cjs');

const categoryIds = ['documents', 'apps', 'images', 'others'];

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-tools-core-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sourceFixture(t) {
  const root = temporaryDirectory(t);
  const directory = path.join(root, 'sources');
  fs.mkdirSync(directory);
  const files = [
    { name: 'report.PdF', categoryId: 'documents', content: Buffer.from('original document\r\n') },
    { name: 'photo.JpG', categoryId: 'images', content: Buffer.from([0, 1, 127, 128, 255]) },
    { name: 'shortcut.LNK', categoryId: 'apps', content: Buffer.from('original shortcut') },
    { name: 'archive.bin', categoryId: 'others', content: Buffer.from('original archive') }
  ].map(file => ({ ...file, path: path.join(directory, file.name) }));
  for (const file of files) fs.writeFileSync(file.path, file.content);
  const folder = path.join(directory, 'folder.EXE');
  fs.mkdirSync(folder);
  const child = { path: path.join(folder, 'keep.txt'), content: Buffer.from('keep this child\n') };
  fs.writeFileSync(child.path, child.content);
  return { root, directory, files, folder, child };
}

function assertSourcesUnchanged(fixture) {
  assert.deepEqual(
    fs.readdirSync(fixture.directory).sort(),
    [...fixture.files.map(file => file.name), path.basename(fixture.folder)].sort()
  );
  assert.equal(fs.statSync(fixture.folder).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(fixture.folder), ['keep.txt']);
  for (const file of [...fixture.files, fixture.child]) {
    assert.equal(fs.statSync(file.path).isFile(), true, file.path);
    assert.deepEqual(fs.readFileSync(file.path), file.content, file.path);
  }
}

function relocationFixture(t, configured = true) {
  const fixture = sourceFixture(t);
  const settingsDirectory = path.join(fixture.root, 'settings');
  fs.mkdirSync(settingsDirectory);
  const directory = configured ? path.join(fixture.root, 'current') : settingsDirectory;
  const store = new Store(directory);
  store.state.categories.push({ id: 'custom', name: '自定义分区', color: 'green' });
  addPaths(store.state, [...fixture.files.map(file => file.path), fixture.folder]);
  store.state.items[0].categoryId = 'custom';
  store.state.notes[0].content = '原始便签\r\n第二行';
  store.state.notes.push({ id: 'note-2', title: '另一便签', content: '完整保留', updatedAt: 123 });
  store.state.activeNoteId = 'note-2';
  store.state.browserUrl = 'https://example.com/workspace';
  store.state.window.width = 1234;
  store.flush();
  const locationFile = path.join(settingsDirectory, 'data-location.json');
  const locationBytes = configured ? Buffer.from(` \r\n${JSON.stringify({ directory })}\r\n`) : null;
  if (configured) fs.writeFileSync(locationFile, locationBytes);
  return {
    sources: fixture, store, directory, settingsDirectory, locationFile, locationBytes,
    file: store.file, bytes: fs.readFileSync(store.file), state: structuredClone(store.state),
    destination: path.join(fixture.root, 'selected', 'data')
  };
}

function assertOriginalLocation(fixture) {
  assert.equal(fixture.store.directory, fixture.directory);
  assert.equal(fixture.store.file, fixture.file);
  assert.deepEqual(fixture.store.state, fixture.state);
  assert.deepEqual(fs.readFileSync(fixture.file), fixture.bytes);
  if (fixture.locationBytes) assert.deepEqual(fs.readFileSync(fixture.locationFile), fixture.locationBytes);
  else assert.equal(fs.existsSync(fixture.locationFile), false);
  assert.equal(resolveDataDirectory(fixture.settingsDirectory), fixture.directory);
  assertSourcesUnchanged(fixture.sources);
}

test('defaults contains all required categories and a valid initial state', () => {
  const state = defaults();
  assert.equal(state.version, 1);
  assert.deepEqual(state.categories.map(category => category.id), categoryIds);
  for (const category of state.categories) {
    assert.equal(typeof category.name, 'string');
    assert.ok(category.name.length > 0);
  }
  assert.deepEqual(state.items, []);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].content, '');
  assert.equal(state.browserUrl, '');
  assert.equal(validState(state), true);
});

test('defaults returns independent mutable collections and settings', () => {
  const first = defaults();
  const second = defaults();
  first.categories[0].name = 'changed';
  first.items.push({ id: 'only-in-first' });
  first.notes[0].content = 'changed';
  first.window.width = 1;
  assert.notEqual(second.categories[0].name, 'changed');
  assert.deepEqual(second.items, []);
  assert.equal(second.notes[0].content, '');
  assert.notEqual(second.window.width, 1);
  assert.notEqual(first.notes[0].id, second.notes[0].id);
});

test('normalizeUrl supplies HTTPS and trims surrounding whitespace', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  example.com/docs?q=test#part  '), 'https://example.com/docs?q=test#part');
});

test('normalizeUrl preserves explicit HTTP localhost ports and HTTPS URLs', () => {
  assert.equal(normalizeUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeUrl('http://localhost:8080/page?q=1#part'), 'http://localhost:8080/page?q=1#part');
  assert.equal(normalizeUrl('https://example.com:8443/page'), 'https://example.com:8443/page');
});

test('normalizeUrl treats bare host ports as HTTPS rather than URL schemes', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'https://localhost:3000/');
  assert.equal(normalizeUrl('localhost:3000/page'), 'https://localhost:3000/page');
  assert.equal(normalizeUrl('example.com:8443/page'), 'https://example.com:8443/page');
});

for (const [label, input] of [
  ['file URLs', 'file:///C:/not-a-real-file.txt'],
  ['javascript URLs', 'javascript:alert(1)'],
  ['data URLs', 'data:text/plain,hello'],
  ['HTTP credentials', 'http://user:password@localhost:3000/'],
  ['HTTPS credentials', 'https://user:password@example.com/'],
  ['username-only credentials', 'https://user@example.com/'],
  ['password-only credentials', 'https://:password@example.com/']
]) {
  test(`normalizeUrl rejects ${label}`, () => {
    assert.throws(() => normalizeUrl(input), /仅支持不含账号密码的 HTTP \/ HTTPS 网页/);
  });
}

test('classify handles every supported extension regardless of case', () => {
  const extensions = {
    apps: ['.lnk', '.url', '.exe', '.msi', '.appref-ms'],
    images: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.psd'],
    documents: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.txt', '.md', '.csv', '.rtf', '.json']
  };
  for (const [categoryId, values] of Object.entries(extensions)) {
    for (const extension of values) {
      for (const suffix of [extension, extension.toUpperCase()]) {
        assert.equal(classify(`sample${suffix}`), categoryId, suffix);
      }
    }
  }
  assert.equal(classify('sample.JpEg'), 'images');
  assert.equal(classify('sample.DoCx'), 'documents');
  assert.equal(classify('sample.ExE'), 'apps');
});

test('classify sends unknown and missing extensions to others', () => {
  for (const name of ['archive.zip', 'file.unknown', 'README', '.gitignore', 'image.png.bak']) {
    assert.equal(classify(name), 'others', name);
  }
});

test('classify always sends directories to others', () => {
  for (const name of ['folder.exe', 'folder.JPG', 'folder.pdf', 'folder']) {
    assert.equal(classify(name, true), 'others', name);
  }
});

test('addPaths batches files and skips duplicates within and across calls', t => {
  const fixture = sourceFixture(t);
  const state = defaults();
  const paths = fixture.files.map(file => file.path);
  assert.deepEqual(addPaths(state, [...paths, paths[0]]), { added: 4, skipped: 1 });
  assert.deepEqual(
    state.items.map(({ name, path: filePath, categoryId, isDirectory }) => ({ name, path: filePath, categoryId, isDirectory })),
    fixture.files.map(file => ({ name: file.name, path: file.path, categoryId: file.categoryId, isDirectory: false }))
  );
  assert.ok(state.items.every(item => typeof item.id === 'string' && item.id.length > 0));
  assert.equal(new Set(state.items.map(item => item.id)).size, 4);
  const before = structuredClone(state);
  assert.deepEqual(addPaths(state, paths), { added: 0, skipped: 4 });
  assert.deepEqual(addPaths(state, [paths[0].toUpperCase()]), { added: 0, skipped: 1 });
  const equivalentPath = `${fixture.directory}${path.sep}.${path.sep}${fixture.files[0].name}`;
  assert.deepEqual(addPaths(state, [equivalentPath]), { added: 0, skipped: 1 });
  assert.deepEqual(state, before);
  assertSourcesUnchanged(fixture);
});

test('addPaths adds a folder as one item without importing its children', t => {
  const fixture = sourceFixture(t);
  const state = defaults();
  assert.deepEqual(addPaths(state, [fixture.folder, fixture.folder]), { added: 1, skipped: 1 });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].name, 'folder.EXE');
  assert.equal(state.items[0].path, fixture.folder);
  assert.equal(state.items[0].categoryId, 'others');
  assert.equal(state.items[0].isDirectory, true);
  assertSourcesUnchanged(fixture);
});

test('addPaths skips removed paths until they are explicitly added again', t => {
  const fixture = sourceFixture(t);
  const state = defaults();
  const file = fixture.files[0].path;
  assert.deepEqual(addPaths(state, [file]), { added: 1, skipped: 0 });
  state.items = [];
  ignorePath(state, file);
  assert.deepEqual(addPaths(state, [file]), { added: 0, skipped: 1 });
  assert.deepEqual(state.items, []);
  assert.equal(state.removedPaths.length, 1);
  assert.deepEqual(addPaths(state, [file], undefined, { includeRemoved: true }), { added: 1, skipped: 0 });
  assert.equal(state.items[0].path, file);
  assert.deepEqual(state.removedPaths, []);
  assert.equal(validState(state), true);
  assertSourcesUnchanged(fixture);
});

test('ignorePath stores one case-insensitive key per source', () => {
  const state = defaults();
  const file = path.join('C:\\', 'Data', 'Example.txt');
  ignorePath(state, file);
  ignorePath(state, file.toLowerCase());
  ignorePath(state, file.toUpperCase());
  ignorePath(state, 'relative.txt');
  assert.equal(state.removedPaths.length, 1);
  assert.equal(state.removedPaths[0], path.resolve(file).toLowerCase());
});

test('addPaths honors an explicit existing category for files and folders', t => {
  const fixture = sourceFixture(t);
  const state = defaults();
  state.categories.push({ id: 'custom', name: 'Custom' });
  assert.deepEqual(addPaths(state, [fixture.files[0].path, fixture.folder], 'custom'), { added: 2, skipped: 0 });
  assert.deepEqual(state.items.map(item => item.categoryId), ['custom', 'custom']);
  assert.deepEqual(state.items.map(item => item.isDirectory), [false, true]);
  assert.equal(validState(state), true);
  assertSourcesUnchanged(fixture);
});

test('addPaths rejects an unknown category without changing state or sources', t => {
  const fixture = sourceFixture(t);
  const state = defaults();
  const before = structuredClone(state);
  assert.throws(() => addPaths(state, [fixture.files[0].path], 'not-a-category'), /分区不存在/);
  assert.deepEqual(state, before);
  assertSourcesUnchanged(fixture);
});

test('addPaths skips nonexistent, relative and non-string paths and continues the batch', t => {
  const fixture = sourceFixture(t);
  const state = defaults();
  const missing = path.join(fixture.directory, 'missing.txt');
  const invalid = [missing, path.join(fixture.directory, 'missing-folder'), 'relative.txt', '', null, undefined, 42, {}];
  assert.deepEqual(addPaths(state, [...invalid, fixture.files[0].path]), { added: 1, skipped: invalid.length });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].path, fixture.files[0].path);
  assert.equal(fs.existsSync(missing), false);
  assertSourcesUnchanged(fixture);
});

test('validState accepts defaults and a populated state with a custom category', () => {
  assert.equal(validState(defaults()), true);
  const state = defaults();
  state.categories.push({ id: 'custom', name: 'Custom' });
  state.items.push({ id: 'item-1', name: 'Example', path: 'example.txt', categoryId: 'custom' });
  state.notes.push({ id: 'note-2', title: 'Title', content: 'Content' });
  state.browserUrl = 'https://example.com/';
  assert.equal(validState(state), true);
});

test('validState rejects malformed structures and broken category references', () => {
  for (const input of [null, undefined, false, 0, 'invalid', [], {}]) {
    assert.ok(!validState(input), `unexpected valid state: ${String(input)}`);
  }
  const mutations = [
    ['wrong version', state => { state.version = 2; }],
    ['missing categories', state => { delete state.categories; }],
    ['non-array categories', state => { state.categories = {}; }],
    ['empty categories', state => { state.categories = []; }],
    ...categoryIds.map(id => [`missing ${id}`, state => { state.categories = state.categories.filter(category => category.id !== id); }]),
    ['null category', state => { state.categories.push(null); }],
    ['invalid category id', state => { state.categories.push({ id: 1, name: 'Invalid' }); }],
    ['invalid category name', state => { state.categories[0].name = 1; }],
    ['missing items', state => { delete state.items; }],
    ['non-array items', state => { state.items = {}; }],
    ['null item', state => { state.items = [null]; }],
    ...['id', 'name', 'path'].map(field => [`invalid item ${field}`, state => {
      state.items = [{ id: 'item', name: 'Example', path: 'example.txt', categoryId: 'documents', [field]: 1 }];
    }]),
    ['unknown item category', state => { state.items = [{ id: 'item', name: 'Example', path: 'example.txt', categoryId: 'missing' }]; }],
    ['missing notes', state => { delete state.notes; }],
    ['non-array notes', state => { state.notes = {}; }],
    ['empty notes', state => { state.notes = []; }],
    ['null note', state => { state.notes = [null]; }],
    ...['id', 'title', 'content'].map(field => [`invalid note ${field}`, state => { state.notes[0][field] = 1; }]),
    ['missing browserUrl', state => { delete state.browserUrl; }],
    ['invalid browserUrl', state => { state.browserUrl = null; }],
    ['invalid removedPaths', state => { state.removedPaths = {}; }],
    ['invalid removed path entry', state => { state.removedPaths = [1]; }]
  ];
  for (const [label, mutate] of mutations) {
    const state = defaults();
    mutate(state);
    assert.ok(!validState(state), label);
  }
});

test('Store creates its directory, persists and rereads state without moving or deleting sources', t => {
  const fixture = sourceFixture(t);
  const directory = path.join(fixture.root, 'nested', 'store');
  const store = new Store(directory);
  assert.equal(fs.statSync(directory).isDirectory(), true);
  assert.equal(store.file, path.join(directory, 'workspace.json'));
  assert.equal(fs.existsSync(store.file), false);
  assert.equal(store.recovered, false);
  assert.equal(validState(store.state), true);
  addPaths(store.state, [...fixture.files.map(file => file.path), fixture.folder]);
  store.state.browserUrl = 'http://localhost:3000/';
  store.state.notes[0].content = '持久化测试\r\nsecond line';
  store.state.activeNoteId = store.state.notes[0].id;
  store.state.window.width = 1280;
  const expected = structuredClone(store.state);
  store.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), expected);
  assert.deepEqual(fs.readdirSync(directory), ['workspace.json']);
  const reopened = new Store(directory);
  assert.equal(reopened.recovered, false);
  assert.deepEqual(reopened.state, expected);
  assertSourcesUnchanged(fixture);
});

test('Store.flush writes a sibling temporary file before atomically replacing existing JSON', t => {
  const store = new Store(temporaryDirectory(t));
  store.flush();
  const previous = fs.readFileSync(store.file);
  store.state.browserUrl = 'https://example.com/updated';
  const expected = structuredClone(store.state);
  const temporary = `${store.file}.tmp`;
  const events = [];
  const writeFileSync = fs.writeFileSync;
  const renameSync = fs.renameSync;
  // These synchronous spies still perform real writes/renames inside our temporary directory.
  t.mock.method(fs, 'writeFileSync', (file, data, encoding) => {
    events.push('write');
    assert.equal(file, temporary);
    assert.equal(encoding, 'utf8');
    assert.equal(data, JSON.stringify(expected, null, 2));
    assert.deepEqual(fs.readFileSync(store.file), previous);
    return writeFileSync(file, data, encoding);
  });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    events.push('rename');
    assert.equal(source, temporary);
    assert.equal(destination, store.file);
    assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), expected);
    assert.deepEqual(fs.readFileSync(destination), previous);
    return renameSync(source, destination);
  });
  store.flush();
  assert.deepEqual(events, ['write', 'rename']);
  assert.equal(fs.existsSync(temporary), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), expected);
  assert.deepEqual(new Store(store.directory).state, expected);
});

for (const method of ['writeFileSync', 'renameSync']) {
  test(`Store.flush preserves saved JSON when ${method} fails and can retry`, t => {
    const store = new Store(temporaryDirectory(t));
    store.flush();
    const previous = fs.readFileSync(store.file);
    const previousState = JSON.parse(previous.toString('utf8'));
    store.state.notes[0].content = 'new unsaved content';
    const expected = structuredClone(store.state);
    const failure = new Error(`simulated ${method} failure`);
    const original = fs[method];
    let calls = 0;
    const mocked = t.mock.method(fs, method, (...args) => {
      if (args[0] === `${store.file}.tmp`) {
        calls++;
        throw failure;
      }
      return original(...args);
    });
    assert.throws(() => store.flush(), error => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(store.file), previous);
    const reopened = new Store(store.directory);
    assert.equal(reopened.recovered, false);
    assert.deepEqual(reopened.state, previousState);
    mocked.mock.restore();
    store.flush();
    assert.equal(fs.existsSync(`${store.file}.tmp`), false);
    assert.deepEqual(new Store(store.directory).state, expected);
  });
}

for (const [label, original] of [
  ['corrupt JSON', '  {"version": 1,\r\n "备注": "原始内容",\r\n BROKEN JSON\r\n'],
  ['structurally invalid JSON', ' \r\n{ "version": 1, "categories": [], "items": [], "notes": [], "browserUrl": "", "备注": "保留格式" }\r\n']
]) {
  test(`Store preserves the exact recovery bytes for ${label}`, t => {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, 'workspace.json');
    const originalBytes = Buffer.from(original, 'utf8');
    fs.writeFileSync(file, originalBytes);
    const store = new Store(directory);
    assert.equal(store.recovered, true);
    assert.equal(validState(store.state), true);
    assert.deepEqual(store.state.categories.map(category => category.id), categoryIds);
    assert.deepEqual(store.state.items, []);
    assert.deepEqual(fs.readFileSync(file), originalBytes);
    const recoveries = fs.readdirSync(directory).filter(name => /^workspace\.json\.recovery-\d+$/.test(name));
    assert.equal(recoveries.length, 1);
    const recoveryFile = path.join(directory, recoveries[0]);
    assert.deepEqual(fs.readFileSync(recoveryFile), originalBytes);
    store.flush();
    assert.deepEqual(fs.readFileSync(recoveryFile), originalBytes);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['workspace.json', recoveries[0]].sort());
    const reopened = new Store(directory);
    assert.equal(reopened.recovered, false);
    assert.deepEqual(reopened.state, store.state);
    assert.deepEqual(fs.readFileSync(recoveryFile), originalBytes);
  });
}

test('resolveDataDirectory defaults to the settings directory without creating files', t => {
  const directory = temporaryDirectory(t);
  assert.equal(resolveDataDirectory(directory), directory);
  const missing = path.join(directory, 'not-created');
  assert.equal(resolveDataDirectory(missing), missing);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('resolveDataDirectory reopens the selected normalized directory after restart', t => {
  const fixture = relocationFixture(t);
  const selected = `${fixture.directory}${path.sep}..${path.sep}current${path.sep}`;
  fs.writeFileSync(fixture.locationFile, JSON.stringify({ directory: selected }));
  const bytes = fs.readFileSync(fixture.locationFile);
  const directory = resolveDataDirectory(fixture.settingsDirectory);
  assert.equal(directory, fixture.directory);
  assert.deepEqual(new Store(directory).state, fixture.state);
  assert.deepEqual(fs.readFileSync(fixture.locationFile), bytes);
  assert.deepEqual(fs.readFileSync(fixture.file), fixture.bytes);
  assertSourcesUnchanged(fixture.sources);
});

for (const [label, content] of [
  ['corrupt JSON', '{"directory":'],
  ['null', 'null'],
  ['array', '[]'],
  ['missing directory', '{}'],
  ['non-string directory', '{"directory":42}'],
  ['empty directory', '{"directory":""}'],
  ['relative directory', '{"directory":"relative/path"}']
]) {
  test(`resolveDataDirectory rejects ${label} without falling back to defaults`, t => {
    const directory = temporaryDirectory(t);
    const locationFile = path.join(directory, 'data-location.json');
    fs.writeFileSync(locationFile, content);
    assert.throws(() => resolveDataDirectory(directory), /无法读取数据保存路径配置/);
    assert.equal(fs.readFileSync(locationFile, 'utf8'), content);
    assert.deepEqual(fs.readdirSync(directory), ['data-location.json']);
  });
}

for (const kind of ['missing directory', 'missing workspace', 'workspace is a directory']) {
  test(`resolveDataDirectory rejects a selected target with ${kind}`, t => {
    const settingsDirectory = temporaryDirectory(t);
    const directory = path.join(settingsDirectory, 'selected');
    const file = path.join(directory, 'workspace.json');
    if (kind !== 'missing directory') fs.mkdirSync(directory);
    if (kind === 'workspace is a directory') fs.mkdirSync(file);
    const locationFile = path.join(settingsDirectory, 'data-location.json');
    fs.writeFileSync(locationFile, JSON.stringify({ directory }));
    const bytes = fs.readFileSync(locationFile);
    assert.throws(() => resolveDataDirectory(settingsDirectory), /workspace\.json/);
    assert.deepEqual(fs.readFileSync(locationFile), bytes);
    assert.equal(fs.existsSync(directory), kind !== 'missing directory');
    assert.equal(fs.existsSync(file), kind === 'workspace is a directory');
    assert.equal(fs.existsSync(path.join(settingsDirectory, 'workspace.json')), false);
  });
}

test('resolveDataDirectory reports unreadable settings rather than treating them as absent', t => {
  const fixture = relocationFixture(t);
  const failure = Object.assign(new Error('simulated unreadable settings'), { code: 'EACCES' });
  const readFileSync = fs.readFileSync;
  const mocked = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === fixture.locationFile) throw failure;
    return readFileSync(file, ...args);
  });
  assert.throws(() => resolveDataDirectory(fixture.settingsDirectory), error => error.cause === failure);
  mocked.mock.restore();
  assertOriginalLocation(fixture);
});

test('relocateStore flushes pending state, preserves sources and excludes browser profiles', t => {
  const fixture = relocationFixture(t, false);
  const { store, destination, settingsDirectory } = fixture;
  const profileDirectory = path.join(settingsDirectory, 'Session Storage');
  fs.mkdirSync(profileDirectory);
  const profileFile = path.join(profileDirectory, 'profile-fixture');
  fs.writeFileSync(profileFile, 'isolated browser profile fixture');
  store.state.notes[0].content = '切换前已提交、尚未延迟写入的内容';
  store.state.extra = { preserved: ['unknown future state fields'] };
  const expected = structuredClone(store.state);
  const stateReference = store.state;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = t.mock.method(store, 'flush');
  store.saveSoon(error => assert.fail(error.message));
  const relocated = relocateStore(store, `${destination}${path.sep}.${path.sep}`, settingsDirectory);
  assert.notEqual(relocated, store);
  assert.equal(relocated.directory, destination);
  assert.equal(relocated.recovered, false);
  assert.deepEqual(relocated.state, expected);
  assert.equal(store.state, stateReference);
  assert.equal(store.directory, fixture.directory);
  assert.equal(store.file, fixture.file);
  assert.equal(flush.mock.callCount(), 1);
  const sourceBytes = fs.readFileSync(store.file);
  assert.deepEqual(JSON.parse(sourceBytes), expected);
  assert.deepEqual(fs.readFileSync(relocated.file), sourceBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.locationFile, 'utf8')), { directory: destination });
  assert.deepEqual(new Store(resolveDataDirectory(settingsDirectory)).state, expected);
  store.state.notes[0].content = 'old reference must not overwrite the retained source';
  t.mock.timers.tick(1000);
  assert.equal(flush.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(store.file), sourceBytes);
  assert.deepEqual(relocated.state, expected);
  assert.deepEqual(fs.readdirSync(destination), ['workspace.json']);
  assert.equal(fs.readFileSync(profileFile, 'utf8'), 'isolated browser profile fixture');
  assertSourcesUnchanged(fixture.sources);
});

test('relocateStore keeps the fixed settings pointer and subsequent flushes write only the new directory', t => {
  const fixture = relocationFixture(t);
  const relocated = relocateStore(fixture.store, fixture.destination, fixture.settingsDirectory);
  const locationBytes = fs.readFileSync(fixture.locationFile);
  const writes = [];
  const writeFileSync = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    writes.push(file);
    return writeFileSync(file, ...args);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  relocated.state.notes[0].content = 'only in the new directory';
  relocated.saveSoon(error => assert.fail(error.message));
  t.mock.timers.tick(220);
  relocated.state.browserUrl = 'https://example.com/new';
  relocated.flush();
  assert.deepEqual(writes, [`${relocated.file}.tmp`, `${relocated.file}.tmp`]);
  assert.deepEqual(new Store(resolveDataDirectory(fixture.settingsDirectory)).state, relocated.state);
  assert.deepEqual(fs.readFileSync(fixture.file), fixture.bytes);
  assert.deepEqual(fs.readFileSync(fixture.locationFile), locationBytes);
  assert.equal(fs.existsSync(path.join(fixture.directory, 'data-location.json')), false);
  assert.equal(fs.existsSync(path.join(fixture.destination, 'data-location.json')), false);
  assertSourcesUnchanged(fixture.sources);
});

test('relocateStore validates and loads the copy before atomically replacing the settings pointer', t => {
  const fixture = relocationFixture(t);
  const destinationFile = path.join(fixture.destination, 'workspace.json');
  const events = [];
  const copyFileSync = fs.copyFileSync;
  const readFileSync = fs.readFileSync;
  const writeFileSync = fs.writeFileSync;
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    assert.equal(source, fixture.file);
    assert.equal(destination, destinationFile);
    assert.equal(flags, fs.constants.COPYFILE_EXCL);
    events.push('copy');
    return copyFileSync(source, destination, flags);
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === destinationFile) events.push('read-copy');
    return readFileSync(file, ...args);
  });
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (file.startsWith(`${fixture.locationFile}.`)) {
      assert.equal(path.dirname(file), fixture.settingsDirectory);
      assert.equal(options.flag, 'wx');
      assert.deepEqual(JSON.parse(data), { directory: fixture.destination });
      assert.deepEqual(fs.readFileSync(fixture.locationFile), fixture.locationBytes);
      events.push('write-pointer');
    }
    return writeFileSync(file, data, options);
  });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === fixture.locationFile) {
      assert.ok(source.startsWith(`${fixture.locationFile}.`));
      assert.ok(source.endsWith('.tmp'));
      assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), { directory: fixture.destination });
      assert.deepEqual(fs.readFileSync(destination), fixture.locationBytes);
      events.push('rename-pointer');
    }
    return renameSync(source, destination);
  });
  const relocated = relocateStore(fixture.store, fixture.destination, fixture.settingsDirectory);
  assert.deepEqual(events, ['copy', 'read-copy', 'read-copy', 'write-pointer', 'rename-pointer']);
  assert.deepEqual(relocated.state, fixture.state);
  assert.deepEqual(fs.readdirSync(fixture.settingsDirectory), ['data-location.json']);
});

for (const kind of ['valid workspace', 'unrelated bytes', 'file created during copy']) {
  test(`relocateStore never overwrites a target containing ${kind}`, t => {
    const fixture = relocationFixture(t);
    const destinationFile = path.join(fixture.destination, 'workspace.json');
    const bytes = kind === 'valid workspace' ? Buffer.from(JSON.stringify(defaults())) : Buffer.from([0, 255, 13, 10, 42]);
    fs.mkdirSync(fixture.destination, { recursive: true });
    if (kind !== 'file created during copy') fs.writeFileSync(destinationFile, bytes);
    const copyFileSync = fs.copyFileSync;
    const copy = t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
      assert.equal(flags, fs.constants.COPYFILE_EXCL);
      if (kind === 'file created during copy') fs.writeFileSync(destination, bytes);
      return copyFileSync(source, destination, flags);
    });
    assert.throws(
      () => relocateStore(fixture.store, fixture.destination, fixture.settingsDirectory),
      error => /原目录仍有效/.test(error.message) && error.cause.code === 'EEXIST'
    );
    assert.equal(copy.mock.callCount(), 1);
    assert.deepEqual(fs.readFileSync(destinationFile), bytes);
    assertOriginalLocation(fixture);
  });
}

for (const configured of [false, true]) {
  for (const stage of ['copy', 'pointer write', 'pointer rename']) {
    test(`relocateStore preserves ${configured ? 'existing' : 'absent'} settings and source data on ${stage} failure`, t => {
      const fixture = relocationFixture(t, configured);
      const destinationFile = path.join(fixture.destination, 'workspace.json');
      const failure = new Error(`simulated ${stage} failure`);
      const method = { copy: 'copyFileSync', 'pointer write': 'writeFileSync', 'pointer rename': 'renameSync' }[stage];
      const original = fs[method];
      let failures = 0;
      const mocked = t.mock.method(fs, method, (...args) => {
        const matches = stage === 'copy' ? args[1] === destinationFile :
          stage === 'pointer write' ? args[0].startsWith(`${fixture.locationFile}.`) : args[1] === fixture.locationFile;
        if (matches) {
          failures++;
          if (stage === 'pointer write') original(args[0], '{"directory":', args[2]);
          throw failure;
        }
        return original(...args);
      });
      assert.throws(
        () => relocateStore(fixture.store, fixture.destination, fixture.settingsDirectory),
        error => error.cause === failure && /原目录仍有效/.test(error.message) && error.message.includes(fixture.directory)
      );
      assert.equal(failures, 1);
      assertOriginalLocation(fixture);
      assert.equal(fs.existsSync(destinationFile), stage !== 'copy');
      if (stage !== 'copy') assert.deepEqual(fs.readFileSync(destinationFile), fixture.bytes);
      mocked.mock.restore();
      fixture.store.state.notes[0].content = 'the original store remains usable';
      fixture.store.flush();
      assert.deepEqual(new Store(resolveDataDirectory(fixture.settingsDirectory)).state, fixture.store.state);
      if (stage !== 'copy') assert.deepEqual(fs.readFileSync(destinationFile), fixture.bytes);
    });
  }
}

for (const method of ['writeFileSync', 'renameSync']) {
  test(`relocateStore stops before copying when the source flush ${method} fails`, t => {
    const fixture = relocationFixture(t);
    const failure = new Error('simulated source flush failure');
    const original = fs[method];
    t.mock.method(fs, method, (...args) => {
      if (args[0] === `${fixture.file}.tmp`) throw failure;
      return original(...args);
    });
    const copy = t.mock.method(fs, 'copyFileSync');
    assert.throws(
      () => relocateStore(fixture.store, fixture.destination, fixture.settingsDirectory),
      error => error.cause === failure && /原目录仍有效/.test(error.message)
    );
    assert.equal(copy.mock.callCount(), 0);
    assert.equal(fs.existsSync(fixture.destination), false);
    assertOriginalLocation(fixture);
  });
}

for (const kind of ['unreadable', 'corrupt JSON', 'invalid state']) {
  test(`relocateStore rejects an ${kind} copy before changing settings`, t => {
    const fixture = relocationFixture(t);
    const destinationFile = path.join(fixture.destination, 'workspace.json');
    const readFileSync = fs.readFileSync;
    const mocked = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === destinationFile) {
        if (kind === 'unreadable') throw new Error('simulated unreadable copy');
        return kind === 'corrupt JSON' ? '{"version":' : JSON.stringify({ ...defaults(), categories: [] });
      }
      return readFileSync(file, ...args);
    });
    assert.throws(() => relocateStore(fixture.store, fixture.destination, fixture.settingsDirectory), /原目录仍有效/);
    mocked.mock.restore();
    assertOriginalLocation(fixture);
    assert.deepEqual(fs.readFileSync(destinationFile), fixture.bytes);
    assert.deepEqual(fs.readdirSync(fixture.destination), ['workspace.json']);
  });
}

test('relocateStore leaves settings unchanged if constructing the new Store fails', t => {
  const fixture = relocationFixture(t);
  const failure = new Error('simulated constructor failure');
  const mkdirSync = fs.mkdirSync;
  let targetCalls = 0;
  t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
    if (directory === fixture.destination && ++targetCalls === 2) throw failure;
    return mkdirSync(directory, ...args);
  });
  assert.throws(
    () => relocateStore(fixture.store, fixture.destination, fixture.settingsDirectory),
    error => error.cause === failure && /原目录仍有效/.test(error.message)
  );
  assert.equal(targetCalls, 2);
  assertOriginalLocation(fixture);
  assert.deepEqual(fs.readFileSync(path.join(fixture.destination, 'workspace.json')), fixture.bytes);
});

test('relocateStore rejects non-absolute destinations without flushing or changing settings', t => {
  const fixture = relocationFixture(t);
  const flush = t.mock.method(fixture.store, 'flush');
  for (const destination of ['', 'relative/path', 'C:relative', null, undefined, 42, {}]) {
    assert.throws(() => relocateStore(fixture.store, destination, fixture.settingsDirectory), /必须是绝对路径/);
  }
  assert.equal(flush.mock.callCount(), 0);
  assertOriginalLocation(fixture);
});

test('relocateStore returns the same Store for normalized equivalent directories without touching its timer', t => {
  const fixture = relocationFixture(t);
  const { store, directory, settingsDirectory } = fixture;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = t.mock.method(store, 'flush');
  store.saveSoon(error => assert.fail(error.message));
  const timer = store.timer;
  const state = store.state;
  const equivalent = [directory, `${directory}${path.sep}.${path.sep}`, `${directory}${path.sep}..${path.sep}current`];
  if (process.platform === 'win32') equivalent.push(directory.toUpperCase(), directory.replaceAll('\\', '/'));
  for (const destination of equivalent) {
    assert.equal(relocateStore(store, destination, settingsDirectory), store);
    assert.equal(store.timer, timer);
    assert.equal(store.state, state);
  }
  assert.equal(flush.mock.callCount(), 0);
  assertOriginalLocation(fixture);
  assert.deepEqual(fs.readdirSync(settingsDirectory), ['data-location.json']);
  assert.deepEqual(fs.readdirSync(directory), ['workspace.json']);
  t.mock.timers.tick(220);
  assert.equal(flush.mock.callCount(), 1);
});

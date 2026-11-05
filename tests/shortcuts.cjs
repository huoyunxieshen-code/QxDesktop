const { _electron: electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-shortcuts-'));
let application;

async function main() {
  const env = { ...process.env, HARBOR_DATA_DIR: path.join(directory, 'data'), HARBOR_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [root], env, timeout: 40000 });
  const page = await application.firstWindow();
  await page.locator('.category-card').first().waitFor();
  const fixtures = await application.evaluate(({ shell }, { directory, root }) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const specs = [
      { name: '记事本.lnk', target: path.join(process.env.WINDIR, 'System32', 'notepad.exe') },
      { name: '命令提示符.LNK', target: path.join(process.env.WINDIR, 'System32', 'cmd.exe') },
      { name: '自定义图标.lnk', target: path.join(process.env.WINDIR, 'System32', 'notepad.exe'), icon: path.join(root, 'assets', 'icon.ico'), iconIndex: 0 },
      { name: '资源图标.lnk', target: path.join(process.env.WINDIR, 'System32', 'notepad.exe'), icon: path.join(process.env.WINDIR, 'System32', 'shell32.dll'), iconIndex: 14 },
      { name: '另一个资源图标.lnk', target: path.join(process.env.WINDIR, 'System32', 'notepad.exe'), icon: path.join(process.env.WINDIR, 'System32', 'shell32.dll'), iconIndex: 15 }
    ];
    for (const spec of specs) {
      spec.path = path.join(directory, spec.name);
      if (!shell.writeShortcutLink(spec.path, 'create', spec)) throw new Error('创建测试快捷方式失败');
      spec.original = fs.readFileSync(spec.path).toString('base64');
    }
    fs.writeFileSync(path.join(directory, '普通文件.txt'), 'source');
    fs.mkdirSync(path.join(directory, '保留名称.lnk'));
    return specs;
  }, { directory, root });
  const paths = [...fixtures.map(entry => entry.path), path.join(directory, '普通文件.txt'), path.join(directory, '保留名称.lnk')];
  await page.evaluate(paths => window.desktop.invoke('add-paths', paths), paths);
  await expect(page.locator('.file-item')).toHaveCount(paths.length);
  const bootstrap = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  const results = [];
  for (const fixture of fixtures) {
    const item = bootstrap.value.state.items.find(item => item.path === fixture.path);
    const result = await page.evaluate(id => window.desktop.invoke('item-icon', id), item.id);
    assert.ok(result.ok && result.value, `图标应可读取: ${fixture.name}`);
    const rendered = page.locator(`[data-item="${item.id}"]`);
    await expect(rendered.locator('img')).toBeVisible();
    results.push({ name: fixture.name, label: await rendered.locator('span').textContent(), icon: result.value });
    assert.equal(fs.readFileSync(fixture.path).toString('base64'), fixture.original, '不能改动快捷方式源文件');
  }
  await page.screenshot({ path: path.join(root, 'assets', 'shortcut-icons.png') });
  console.log(results.map(result => ({ name: result.name, label: result.label, iconHash: crypto.createHash('sha256').update(result.icon).digest('hex').slice(0, 12) })));
  for (const result of results) assert.equal(result.label, result.name.replace(/\.lnk$/i, ''), '只隐藏快捷方式的 .lnk 后缀');
  assert.equal(new Set(results.map(result => result.icon)).size, fixtures.length, '不同目标及不同资源索引的快捷方式必须显示不同图标');
  await expect(page.getByRole('button', { name: '普通文件.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保留名称.lnk', exact: true })).toBeVisible();
  await page.locator('#search').fill('记事本');
  await expect(page.locator('.file-item')).toHaveCount(1);
  await expect(page.locator('.file-item > span')).toHaveText('记事本');
  console.log('PASS 快捷方式名称、真实图标、资源索引、文件夹名称和原文件保护');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close().catch(() => {});
  fs.rmSync(directory, { recursive: true, force: true });
});

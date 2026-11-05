const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sourceDirectory = path.join(root, 'src', 'native');
const sources = fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.cs')).map(name => path.join(sourceDirectory, name));
const output = path.join(root, 'assets', 'QXDesktopBridge.exe');
const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(output) || sources.some(source => fs.statSync(source).mtimeMs > fs.statSync(output).mtimeMs)) {
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', `/out:${output}`, ...sources], { stdio: 'inherit', windowsHide: true });
  console.log('Windows desktop / taskbar / icon bridge compiled');
}

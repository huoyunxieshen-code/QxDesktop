const { build, Platform, Arch } = require('electron-builder');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require('./build-native.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-build-'));
const output = path.join(root, 'release');

// Workspace indexers can lock Electron archives on Windows; assemble outside the workspace.
build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64), config: { directories: { output: temporary } } })
  .then(artifacts => {
    fs.mkdirSync(output, { recursive: true });
    for (const artifact of artifacts.filter(file => file.endsWith('.exe'))) {
      const destination = path.join(output, path.basename(artifact));
      fs.copyFileSync(artifact, destination);
      console.log(`EXE ready: ${destination}`);
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  })
  .catch(error => { console.error(error); console.error(`Build files preserved: ${temporary}`); process.exitCode = 1; });

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const source = path.join(repoRoot, 'extension');
const fixtures = path.join(here, 'fixtures');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const out = path.resolve(argValue('--out', path.join(here, '.build', 'extension')));

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.cp(source, out, { recursive: true });

const manifestPath = path.join(out, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

const permissions = new Set(manifest.permissions || []);
for (const permission of ['activeTab', 'storage', 'tabs', 'menus', 'scripting', 'notifications', 'bookmarks']) {
  permissions.add(permission);
}
manifest.permissions = [...permissions];
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.optional_permissions = (manifest.optional_permissions || []).filter((permission) => permission !== 'bookmarks');
manifest.browser_specific_settings = {
  ...(manifest.browser_specific_settings || {}),
  gecko: {
    ...(manifest.browser_specific_settings?.gecko || {}),
    strict_min_version: '142.0'
  }
};

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const fixtureFiles = await fs.readdir(fixtures).catch(() => []);
for (const file of fixtureFiles) {
  await fs.copyFile(path.join(fixtures, file), path.join(out, file));
}

const popupBridge = `

globalThis.__ncTest = {
  state,
  loadForTab(url, title) {
    if (!state.client) return Promise.resolve('no-client');
    return state.client.findCurrentBookmark(url).then((bookmark) => {
      if (bookmark) {
        populateAddForm(bookmark, url, title);
        return bookmark.id;
      }
      resetAddForm(url, title);
      return null;
    });
  },
  applyMainTab() {
    applyMainTab();
  }
};
`;
const popupPath = path.join(out, 'src', 'popup.mjs');
const popupSource = await fs.readFile(popupPath, 'utf8');
await fs.writeFile(popupPath, `${popupSource}${popupBridge}`);

const optionsBridge = `

globalThis.__ncTest = { state };
`;
const optionsPath = path.join(out, 'src', 'options.mjs');
const optionsSource = await fs.readFile(optionsPath, 'utf8');
await fs.writeFile(optionsPath, `${optionsSource}${optionsBridge}`);

const backgroundPath = path.join(out, 'src', 'background.mjs');
try {
  const backgroundSource = await fs.readFile(backgroundPath, 'utf8');
  await fs.writeFile(backgroundPath, `${backgroundSource}
if (globalThis.browser?.runtime?.onMessage) {
  globalThis.browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'test-quick-save') {
      return quickSaveForTab(message.tab || {}).then((result) => ({ ok: true, result }));
    }
    return false;
  });
}
`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log(out);

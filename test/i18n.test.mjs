import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

async function readMessages(locale) {
  const file = path.join(root, 'extension', '_locales', locale, 'messages.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

const english = await readMessages('en');
const norwegian = await readMessages('nb-NO');

test('English and Norwegian have the same message keys', () => {
  assert.deepEqual(Object.keys(norwegian).sort(), Object.keys(english).sort());
});

test('every data-i18n key used in HTML exists in English', async () => {
  for (const file of ['popup.html', 'options.html']) {
    const html = await fs.readFile(path.join(root, 'extension', file), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(keys.length > 0, `${file} has no i18n keys`);
    for (const key of keys) {
      assert.ok(english[key], `${file} uses missing key ${key}`);
    }
  }
});

test('every literal t() key used in page scripts exists in English', async () => {
  for (const file of ['popup.mjs', 'options.mjs']) {
    const source = await fs.readFile(path.join(root, 'extension', 'src', file), 'utf8');
    const keys = [...source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const key of keys) {
      assert.ok(english[key], `${file} uses missing key ${key}`);
    }
  }
});

test('manifest __MSG_ keys exist in English', async () => {
  const manifest = await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8');
  const keys = [...manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((match) => match[1]);
  for (const key of keys) {
    assert.ok(english[key], `manifest uses missing key ${key}`);
  }
});

test('t falls back to the key without an i18n API', async () => {
  const module = await import(`../extension/src/i18n.mjs?fallback=${Date.now()}`);
  assert.equal(module.t('missingKey'), 'missingKey');
});

test('t applies positional substitutions', async () => {
  const previous = globalThis.browser;
  globalThis.browser = {
    i18n: {
      getMessage(key) {
        return key === 'greeting' ? 'Hello {{1}}' : '';
      }
    }
  };
  try {
    const module = await import(`../extension/src/i18n.mjs?substitution=${Date.now()}`);
    assert.equal(module.t('greeting', ['World']), 'Hello World');
  } finally {
    globalThis.browser = previous;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { createMockServer } from './integration/mock-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const realFetch = globalThis.fetch;
const messages = JSON.parse(
  await fs.readFile(path.join(root, 'extension', '_locales', 'en', 'messages.json'), 'utf8')
);
const optionsHtml = await fs.readFile(path.join(root, 'extension', 'options.html'), 'utf8');

let server;
let base;
let moduleCounter = 0;

test.before(async () => {
  server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out: ${last?.message ?? 'condition not met'}`);
}

function storageApi(initial) {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    }
  };
}

async function loadOptions() {
  const dom = new JSDOM(optionsHtml, {
    url: 'moz-extension://test/options.html',
    pretendToBeVisual: true
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    browser: globalThis.browser,
    fetch: globalThis.fetch,
    Option: globalThis.Option,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    getComputedStyle: globalThis.getComputedStyle
  };
  const calls = [];

  const browser = {
    storage: {
      local: storageApi({
        settings: {
          serverUrl: base,
          username: 'test',
          password: 'secret',
          searchMainTab: false
        }
      })
    },
    permissions: {
      async contains() {
        return true;
      },
      async request() {
        return true;
      }
    },
    bookmarks: {
      async getTree() {
        return [];
      }
    },
    runtime: {
      openOptionsPage() {},
      getManifest() {
        return { version: '0.2.0' };
      },
      getURL(pathname) {
        return `moz-extension://test/${pathname}`;
      }
    },
    i18n: {
      getMessage(key) {
        return messages[key]?.message ?? '';
      },
      getUILanguage() {
        return 'en-US';
      }
    }
  };

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.browser = browser;
  globalThis.Option = dom.window.Option;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return realFetch(url, options);
  };

  moduleCounter += 1;
  await import(`../extension/src/options.mjs?dom=${moduleCounter}`);
  await waitFor(() => dom.window.document.getElementById('folder-list').textContent.includes('Work'));

  return {
    dom,
    calls,
    cleanup() {
      dom.window.close();
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.browser = previous.browser;
      globalThis.fetch = previous.fetch;
      globalThis.Option = previous.Option;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.Event = previous.Event;
      globalThis.CustomEvent = previous.CustomEvent;
      globalThis.getComputedStyle = previous.getComputedStyle;
    }
  };
}

test('renames a folder inline and sends the existing parent', async () => {
  const options = await loadOptions();
  try {
    const document = options.dom.window.document;
    const row = [...document.querySelectorAll('#folder-list .folder-row')]
      .find((entry) => entry.textContent.includes('Work'));
    assert.ok(row);
    row.querySelector('button').click();

    const renameRow = [...document.querySelectorAll('#folder-list .folder-row')]
      .find((entry) => entry.querySelector('input'));
    const input = renameRow.querySelector('input');
    assert.ok(input);
    input.value = 'Renamed Work';
    [...renameRow.querySelectorAll('button')].find((button) => button.textContent === 'Save').click();

    await waitFor(() => document.getElementById('folder-list').textContent.includes('Renamed Work'));
    const put = options.calls.find((call) => call.url.endsWith('/folder/10') && call.options?.method === 'PUT');
    assert.ok(put);
    const body = new URLSearchParams(put.options.body);
    assert.equal(body.get('title'), 'Renamed Work');
    assert.equal(body.get('parent_folder'), '-1');
  } finally {
    options.cleanup();
  }
});

test('creates a folder from the settings page', async () => {
  const options = await loadOptions();
  try {
    const document = options.dom.window.document;
    document.getElementById('new-folder-options-title').value = 'Settings Folder';
    document.getElementById('new-folder-options-parent').value = '10';
    document.getElementById('create-folder-options').click();

    await waitFor(() => document.getElementById('folder-list').textContent.includes('Settings Folder'));
    const post = options.calls.find((call) => call.url.endsWith('/folder') && call.options?.method === 'POST');
    assert.ok(post);
    const body = new URLSearchParams(post.options.body);
    assert.equal(body.get('title'), 'Settings Folder');
    assert.equal(body.get('parent_folder'), '10');
  } finally {
    options.cleanup();
  }
});

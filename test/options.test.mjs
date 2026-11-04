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

function findNode(nodes, id) {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

async function loadOptions({ tree = [], importJob = null } = {}) {
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
        },
        ...(importJob ? { importJob } : {})
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
        return tree;
      },
      async getSubTree(id) {
        const node = findNode(tree, id);
        return node ? [node] : [];
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

test('previews and imports a Firefox folder tree with folder recreation', async () => {
  const tree = [{
    type: 'folder',
    id: 'root________',
    title: '',
    children: [{
      type: 'folder',
      id: 'toolbar_____',
      title: 'Bookmarks Toolbar',
      children: [{
        type: 'folder',
        id: 'import-test',
        title: 'Import Test',
        children: [
          {
            type: 'bookmark',
            id: 'b1',
            title: 'Firefox One',
            url: 'https://firefox-one.example/'
          },
          {
            type: 'folder',
            id: 'nested',
            title: 'Nested',
            children: [{
              type: 'bookmark',
              id: 'b2',
              title: 'Firefox Two',
              url: 'https://firefox-two.example/'
            }]
          }
        ]
      }]
    }]
  }];

  const options = await loadOptions({ tree });
  try {
    const document = options.dom.window.document;
    await waitFor(() => [...document.getElementById('firefox-folder').options]
      .some((option) => option.value === 'import-test'));

    document.getElementById('firefox-folder').value = 'import-test';
    document.getElementById('import-folder').value = '10';
    document.getElementById('import-recreate-folders').checked = true;
    document.getElementById('preview-import').click();

    await waitFor(() => document.getElementById('import-status').textContent.includes('2 new'));
    assert.match(document.getElementById('import-status').textContent, /1 new folders/);

    document.getElementById('start-import').click();
    await waitFor(() => document.getElementById('import-status').textContent.includes('Imported 2'), 8000);

    const state = await realFetch(base + '/__state').then((response) => response.json());
    const nested = state.folders.find((folder) => folder.title === 'Nested' && folder.parent_folder === 10);
    assert.ok(nested);
    const one = state.bookmarks.find((bookmark) => bookmark.url === 'https://firefox-one.example/');
    const two = state.bookmarks.find((bookmark) => bookmark.url === 'https://firefox-two.example/');
    assert.deepEqual(one.folders, [10]);
    assert.deepEqual(two.folders, [nested.id]);
    assert.equal(document.getElementById('import-job').hidden, true);
  } finally {
    options.cleanup();
  }
});

test('shows and discards a persisted import job', async () => {
  const account = `${base}|test`;
  const importJob = {
    account,
    items: [
      { url: 'https://one.example/', title: 'One', path: [] },
      { url: 'https://two.example/', title: 'Two', path: [] }
    ],
    folderPlans: [],
    destinationId: -1,
    folderIds: {},
    completed: [0],
    created: 1,
    skipped: 0,
    failed: 0,
    errors: []
  };

  const options = await loadOptions({ importJob });
  try {
    const document = options.dom.window.document;
    await waitFor(() => document.getElementById('import-job').hidden === false);
    assert.match(document.getElementById('import-job-text').textContent, /1 of 2 bookmarks remaining/);

    document.getElementById('discard-import').click();
    await waitFor(() => document.getElementById('import-job').hidden === true);
    assert.match(document.getElementById('import-status').textContent, /discarded/);
  } finally {
    options.cleanup();
  }
});

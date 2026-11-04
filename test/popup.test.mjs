import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

import { createMockServer } from './integration/mock-server.mjs';
import { cacheKey } from '../extension/src/cache.mjs';
import { accountKey } from '../extension/src/settings.mjs';
import { BookmarkStore } from '../extension/src/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const realFetch = globalThis.fetch;
const messages = JSON.parse(
  await fs.readFile(path.join(root, 'extension', '_locales', 'en', 'messages.json'), 'utf8')
);
const popupHtml = await fs.readFile(path.join(root, 'extension', 'popup.html'), 'utf8');

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

function settingsFor(serverUrl = base) {
  return {
    serverUrl,
    username: 'test',
    password: 'secret',
    searchMainTab: false
  };
}

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
    data,
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) {
        data.set(key, value);
      }
    },
    async remove(key) {
      data.delete(key);
    }
  };
}

async function loadPopup({
  settings = settingsFor(),
  cacheFolders = null,
  cacheTags = null,
  index = null,
  indexSyncedAt = Date.now(),
  fetchOverride = null,
  currentTab = { url: 'https://example.com/', title: 'Example Domain' }
} = {}) {
  const dom = new JSDOM(popupHtml, {
    url: 'moz-extension://test/popup.html',
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

  const account = accountKey(settings.serverUrl, settings.username);
  const initialStorage = { settings, lastFolder: 10 };
  if (cacheFolders) {
    initialStorage[cacheKey('folders', account)] = {
      v: 1,
      fetchedAt: Date.now(),
      value: cacheFolders
    };
  }
  if (cacheTags) {
    initialStorage[cacheKey('tags', account)] = {
      v: 1,
      fetchedAt: Date.now(),
      value: cacheTags
    };
  }

  const browser = {
    storage: { local: storageApi(initialStorage) },
    tabs: {
      async query() {
        return [currentTab];
      }
    },
    permissions: {
      async contains() {
        return true;
      },
      async request() {
        return true;
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
    if (fetchOverride) {
      const override = await fetchOverride(String(url), options);
      if (override !== undefined) {
        return override;
      }
    }
    return realFetch(url, options);
  };

  if (index) {
    const store = new BookmarkStore();
    await store.replaceAll(account, index, indexSyncedAt);
  }

  moduleCounter += 1;
  await import(`../extension/src/popup.mjs?dom=${moduleCounter}`);
  await waitFor(() => dom.window.document.getElementById('bookmark-title'));

  const cleanup = () => {
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
  };

  return { dom, browser, cleanup, account };
}

function optionValues(select) {
  return Array.from(select.options).map((option) => option.value);
}

test('renders cached folders and tags while the server refresh hangs', async () => {
  const cachedFolders = [
    { id: 10, title: 'Work', parent_folder: -1, userId: 'test' },
    { id: 11, title: 'Projects', parent_folder: 10, userId: 'test' },
    { id: 12, title: 'Personal', parent_folder: -1, userId: 'test' }
  ];
  const popup = await loadPopup({
    cacheFolders: cachedFolders,
    cacheTags: ['cloud', 'news'],
    fetchOverride(url) {
      if (url.includes('/folder') || url.includes('/tag')) {
        return new Promise(() => {});
      }
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    const folder = document.getElementById('bookmark-folder');
    await waitFor(() => folder.options.length > 1);
    assert.deepEqual(optionValues(folder), ['-1', '12', '10', '11']);

    const tags = document.getElementById('bookmark-tags');
    tags.value = 'cl';
    tags.dispatchEvent(new popup.dom.window.Event('input', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('#tag-suggestions li').length > 0);
    assert.match(document.getElementById('tag-suggestions').textContent, /cloud/);
  } finally {
    popup.cleanup();
  }
});

test('keeps cached folders when the folder refresh fails', async () => {
  const popup = await loadPopup({
    cacheFolders: [{ id: 10, title: 'Cached Work', parent_folder: -1, userId: 'test' }],
    fetchOverride(url) {
      if (url.includes('/folder')) {
        return new Response(JSON.stringify({ status: 'error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    const folder = document.getElementById('bookmark-folder');
    await waitFor(() => folder.options.length > 1);
    assert.ok(optionValues(folder).includes('10'));
    assert.match(folder.textContent, /Cached Work/);
  } finally {
    popup.cleanup();
  }
});

test('searches the local index, pages results, and edits and opens a result', async () => {
  const bookmarks = Array.from({ length: 35 }, (_, index) => ({
    id: index + 1,
    url: `https://site-${index + 1}.example/`,
    title: `Site ${String(index + 1).padStart(2, '0')}`,
    description: '',
    tags: index % 2 === 0 ? ['even'] : ['odd'],
    folders: index === 0 ? [10] : [-1],
    lastmodified: 1700000000 + index,
    clickcount: index,
    available: true
  }));

  const popup = await loadPopup({
    index: bookmarks,
    cacheFolders: [{ id: 10, title: 'Work', parent_folder: -1, userId: 'test' }],
    currentTab: { url: 'https://site-1.example/', title: 'Site 01' }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.body.dataset.indexReady === '1');
    document.getElementById('search-sort').value = 'title';

    document.getElementById('search-button').click();
    await waitFor(() => document.querySelectorAll('#search-results .result').length === 30);
    assert.equal(document.body.dataset.searchSource, 'local');
    assert.equal(document.getElementById('load-more').hidden, false);

    document.getElementById('load-more').click();
    await waitFor(() => document.querySelectorAll('#search-results .result').length === 35);
    assert.equal(document.getElementById('load-more').hidden, true);

    const first = document.querySelector('#search-results .result');
    assert.match(first.textContent, /Site 01/);
    const open = first.querySelector('.result-open');
    assert.equal(
      open.href,
      `${base}/index.php/apps/bookmarks/bookmarks/1`
    );

    first.querySelector('.result-edit').click();
    await waitFor(() => document.getElementById('bookmark-id').value === '1');
    assert.equal(document.getElementById('panel-add').hidden, false);
    assert.equal(document.getElementById('panel-search').hidden, true);
    assert.equal(document.getElementById('bookmark-title').value, 'Site 01');
    assert.equal(document.getElementById('save-bookmark').textContent, 'Update');
  } finally {
    popup.cleanup();
  }
});

test('falls back to cached results when the server search fails', async () => {
  const bookmarks = [
    {
      id: 1,
      url: 'https://cached.example/',
      title: 'Cached example',
      description: '',
      tags: ['cached'],
      folders: [-1],
      lastmodified: 1,
      clickcount: 0,
      available: true
    }
  ];

  const popup = await loadPopup({
    index: bookmarks,
    indexSyncedAt: Date.now() - 10 * 60 * 1000,
    fetchOverride(url) {
      if (url.includes('/bookmark') && !url.includes('url=')) {
        return Promise.reject(new Error('offline'));
      }
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.body.dataset.indexReady === '1');
    document.getElementById('search-button').click();
    await waitFor(() => document.querySelectorAll('#search-results .result').length === 1);
    assert.equal(document.body.dataset.searchSource, 'cached');
    assert.match(document.getElementById('search-results').textContent, /Cached example/);
    assert.match(document.getElementById('notification').textContent, /Cached results/);
  } finally {
    popup.cleanup();
  }
});

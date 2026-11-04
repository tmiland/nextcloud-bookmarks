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

async function waitFor(predicate, timeout = 10000) {
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
  permissionsGranted = true,
  lastFolder = 10,
  currentTab = { url: 'https://example.com/', title: 'Example Domain' }
} = {}) {
  moduleCounter += 1;
  const dbName = `nextcloud-bookmarks-test-${moduleCounter}`;
  const previousDbName = globalThis.__ncTestDbName;
  globalThis.__ncTestDbName = dbName;
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
    getComputedStyle: globalThis.getComputedStyle,
    ncTestDbName: globalThis.__ncTestDbName
  };

  const account = accountKey(settings.serverUrl, settings.username);
  const initialStorage = { settings, lastFolder };
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
        return permissionsGranted;
      },
      async request() {
        return permissionsGranted;
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
    const store = new BookmarkStore({ dbName });
    await store.replaceAll(account, index, indexSyncedAt);
  }

  const module = await import(`../extension/src/popup.mjs?dom=${moduleCounter}`);
  await waitFor(() => dom.window.document.getElementById('bookmark-title'));
  await waitFor(() => module.state.initialized);

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
    if (previousDbName === undefined) {
      delete globalThis.__ncTestDbName;
    } else {
      globalThis.__ncTestDbName = previousDbName;
    }
  };

  return { dom, browser, cleanup, account, state: module.state };
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
    const boxes = await waitFor(() => {
      const list = [...document.querySelectorAll('#folder-options input[type="checkbox"]')];
      return list.length > 1 ? list : null;
    });
    assert.deepEqual(boxes.map((box) => box.value), ['-1', '12', '10', '11']);

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
    const boxes = await waitFor(() => {
      const list = [...document.querySelectorAll('#folder-options input[type="checkbox"]')];
      return list.length > 1 ? list : null;
    });
    assert.ok(boxes.map((box) => box.value).includes('10'));
    assert.match(document.getElementById('folder-options').textContent, /Cached Work/);
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
    indexSyncedAt: Date.now() + 60_000,
    cacheFolders: [{ id: 10, title: 'Work', parent_folder: -1, userId: 'test' }],
    currentTab: { url: 'https://site-1.example/', title: 'Site 01' }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.body.dataset.indexReady === '1');
    assert.equal(popup.state.indexedBookmarks.length, 35);
    document.getElementById('search-sort').value = 'title';

    document.getElementById('search-button').click();
    try {
      await waitFor(() => document.querySelectorAll('#search-results .result').length === 30);
    } catch (error) {
      console.log('DEBUG search', {
        indexed: popup.state.indexedBookmarks.length,
        syncedAt: popup.state.indexSyncedAt,
        ready: popup.state.indexReady,
        lastSearch: popup.state.lastSearch,
        source: document.body.dataset.searchSource,
        cards: document.querySelectorAll('#search-results .result').length,
        notification: document.getElementById('notification').textContent
      });
      throw error;
    }
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

test('preserves shared and unknown folder IDs when editing a bookmark', async () => {
  const bookmark = {
    id: 5,
    url: 'https://multi.example/',
    title: 'Multi folder',
    description: '',
    tags: ['multi'],
    folders: [10, 13, 99],
    lastmodified: 1700000000,
    clickcount: 0,
    available: true
  };
  const calls = [];

  const popup = await loadPopup({
    index: [bookmark],
    cacheFolders: [
      { id: 10, title: 'Work', parent_folder: -1, userId: 'test' },
      { id: 13, title: 'Shared', parent_folder: -1, userId: 'other' }
    ],
    fetchOverride(url, options) {
      calls.push({ url, options });
      if (url.includes('/bookmark/5') && options?.method === 'PUT') {
        return new Response(JSON.stringify({
          status: 'success',
          item: { ...bookmark, title: 'Multi folder updated', folders: [13, 99] }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.body.dataset.indexReady === '1');
    document.getElementById('search-button').click();
    await waitFor(() => document.querySelectorAll('#search-results .result').length === 1);
    document.querySelector('#search-results .result-edit').click();
    await waitFor(() => document.getElementById('bookmark-id').value === '5');

    const work = document.querySelector('#folder-options input[value="10"]');
    const shared = document.querySelector('#folder-options input[value="13"]');
    const unknown = document.querySelector('#folder-options input[value="99"]');
    assert.equal(work.checked, true);
    assert.equal(shared.checked, true);
    assert.equal(unknown.checked, true);

    work.checked = false;
    work.dispatchEvent(new popup.dom.window.Event('change', { bubbles: true }));
    document.getElementById('save-bookmark').click();

    await waitFor(() => calls.some((call) => call.url.includes('/bookmark/5') && call.options?.method === 'PUT'));
    const put = calls.find((call) => call.url.includes('/bookmark/5') && call.options?.method === 'PUT');
    const body = new URLSearchParams(put.options.body);
    assert.deepEqual(body.getAll('folders[]'), ['13', '99']);
    assert.equal(body.getAll('folders[]').includes('10'), false);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    popup.cleanup();
  }
});

test('creates a folder from the popup and selects it', async () => {
  const calls = [];
  const popup = await loadPopup({
    cacheFolders: [
      { id: 10, title: 'Work', parent_folder: -1, userId: 'test' }
    ],
    lastFolder: -1,
    currentTab: { url: 'https://unsaved.example/', title: 'Unsaved' },
    fetchOverride(url, options) {
      calls.push({ url, options });
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.getElementById('bookmark-url').value === 'https://unsaved.example/');
    await waitFor(() => document.querySelectorAll('#folder-options input[type="checkbox"]').length > 1);
    document.getElementById('new-folder').click();
    document.getElementById('new-folder-title').value = 'New Folder';
    document.getElementById('new-folder-parent').value = '10';
    document.getElementById('create-folder').click();

    const created = await waitFor(() => {
      const row = [...document.querySelectorAll('#folder-options .folder-option')]
        .find((entry) => entry.textContent.includes('New Folder'));
      return row?.querySelector('input') ?? null;
    }, 6000);
    assert.equal(created.checked, true);
    assert.match(document.getElementById('folder-summary').textContent, /New Folder/);

    const post = calls.find((call) => call.url.endsWith('/folder') && call.options?.method === 'POST');
    const body = new URLSearchParams(post.options.body);
    assert.equal(body.get('title'), 'New Folder');
    assert.equal(body.get('parent_folder'), '10');
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    popup.cleanup();
  }
});

test('shows the current page before a slow bookmark lookup resolves', async () => {
  const popup = await loadPopup({
    fetchOverride(url) {
      if (url.includes('/bookmark') && url.includes('url=')) {
        return new Promise(() => {});
      }
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.getElementById('bookmark-url').value === 'https://example.com/');
    assert.equal(document.getElementById('bookmark-title').value, 'Example Domain');
    assert.equal(document.getElementById('save-bookmark').textContent, 'Save');
  } finally {
    popup.cleanup();
  }
});

test('does not hide an authentication error behind cached search results', async () => {
  const popup = await loadPopup({
    index: [{
      id: 1,
      url: 'https://cached.example/',
      title: 'Cached example',
      description: '',
      tags: ['cached'],
      folders: [-1],
      lastmodified: 1,
      clickcount: 0,
      available: true
    }],
    indexSyncedAt: Date.now() - 10 * 60 * 1000,
    fetchOverride(url) {
      if (url.includes('/bookmark')) {
        return new Response(JSON.stringify({ status: 'error', message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.body.dataset.indexReady === '1');
    document.getElementById('search-button').click();
    await waitFor(() => document.getElementById('search-results').textContent.includes('Authentication failed'));
    assert.equal(document.getElementById('search-results').textContent.includes('Cached example'), false);
  } finally {
    popup.cleanup();
  }
});

test('does not render another account cache when the account changes', async () => {
  const accountABookmark = {
    id: 77,
    url: 'https://account-a.example/',
    title: 'Account A only',
    description: '',
    tags: [],
    folders: [-1],
    lastmodified: 1,
    clickcount: 0,
    available: true
  };

  const first = await loadPopup({ index: [accountABookmark] });
  try {
    await waitFor(() => first.dom.window.document.body.dataset.indexReady === '1');
  } finally {
    first.cleanup();
  }

  const second = await loadPopup({
    settings: settingsFor(base.replace('127.0.0.1', 'localhost')),
    fetchOverride(url) {
      if (url.includes('/bookmark') && !url.includes('url=')) {
        return Promise.reject(new Error('offline'));
      }
      return undefined;
    }
  });

  try {
    const document = second.dom.window.document;
    document.getElementById('search-button').click();
    await waitFor(() => document.getElementById('search-results').textContent.includes('Could not reach'));
    assert.equal(document.getElementById('search-results').textContent.includes('Account A only'), false);
  } finally {
    second.cleanup();
  }
});

test('applies the last-used folder after the first folder refresh', async () => {
  const popup = await loadPopup({
    lastFolder: 10,
    currentTab: { url: 'https://unsaved.example/', title: 'Unsaved' },
    fetchOverride(url) {
      if (url.includes('/folder')) {
        return new Promise((resolve) => setTimeout(() => resolve(undefined), 80));
      }
      return undefined;
    }
  });

  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.querySelector('#folder-options input[value="10"]')?.checked === true);
    assert.match(document.getElementById('folder-summary').textContent, /Work/);
  } finally {
    popup.cleanup();
  }
});

test('shows the current page and a clear error when host permission is denied', async () => {
  const popup = await loadPopup({ permissionsGranted: false });
  try {
    const document = popup.dom.window.document;
    await waitFor(() => document.getElementById('notification').textContent.includes('Access to your Nextcloud server'));
    assert.equal(document.getElementById('bookmark-url').value, 'https://example.com/');
    assert.equal(document.getElementById('bookmark-title').value, 'Example Domain');
  } finally {
    popup.cleanup();
  }
});

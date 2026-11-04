import test from 'node:test';
import assert from 'node:assert/strict';

import { NextcloudClient, NextcloudError } from '../extension/src/api.mjs';

const originalFetch = globalThis.fetch;

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data)
  };
}

function captureFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return response;
  };
  return calls;
}

function client() {
  return new NextcloudClient({
    serverUrl: 'https://cloud.example.com/nextcloud',
    username: 'user',
    password: 'pass'
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('findByUrl sends the url and limit parameters', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', data: [{ id: 3 }] }));
  const bookmark = await client().findByUrl('https://example.com/path');

  assert.equal(bookmark.id, 3);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/nextcloud/index.php/apps/bookmarks/public/rest/v2/bookmark');
  assert.equal(url.searchParams.get('url'), 'https://example.com/path');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(calls[0].options.method, 'GET');
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
});

test('findCurrentBookmark retries without a fragment', async () => {
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return count === 1
      ? jsonResponse({ status: 'success', data: [] })
      : jsonResponse({ status: 'success', data: [{ id: 9 }] });
  };

  const bookmark = await client().findCurrentBookmark('https://example.com/#section');
  assert.equal(bookmark.id, 9);
  assert.equal(count, 2);
});

test('findCurrentBookmark retries without tracking parameters', async () => {
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return count === 1
      ? jsonResponse({ status: 'success', data: [] })
      : jsonResponse({ status: 'success', data: [{ id: 10 }] });
  };

  const bookmark = await client().findCurrentBookmark('https://example.com/?utm_source=newsletter');
  assert.equal(bookmark.id, 10);
  assert.equal(count, 2);
});

test('findCurrentBookmark keeps meaningful query parameters', async () => {
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return jsonResponse({ status: 'success', data: [] });
  };

  const bookmark = await client().findCurrentBookmark('https://example.com/?page=2');
  assert.equal(bookmark, null);
  assert.equal(count, 1);
});

test('createBookmark sends top-level tags[] and folders[]', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', item: { id: 4 } }));
  await client().createBookmark({
    url: 'https://example.com',
    title: 'Example',
    description: 'Note',
    tags: ['one', 'two'],
    folders: [10]
  });

  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  const body = new URLSearchParams(options.body);
  assert.equal(body.get('url'), 'https://example.com');
  assert.deepEqual(body.getAll('tags[]'), ['one', 'two']);
  assert.deepEqual(body.getAll('folders[]'), ['10']);
  assert.equal(body.has('item[tags][]'), false);
});

test('updateBookmark uses PUT and the bookmark id', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', item: { id: 7 } }));
  await client().updateBookmark(7, {
    url: 'https://example.com',
    title: 'Updated',
    description: '',
    tags: ['cloud'],
    folders: [-1]
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/nextcloud/index.php/apps/bookmarks/public/rest/v2/bookmark/7');
  assert.equal(calls[0].options.method, 'PUT');
  const body = new URLSearchParams(calls[0].options.body);
  assert.deepEqual(body.getAll('folders[]'), ['-1']);
});

test('getBookmarks sends search[], tags[], conjunction, page and limit', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', data: [] }));
  await client().getBookmarks({
    terms: ['alpha', 'beta'],
    tags: ['daily'],
    conjunction: 'or',
    page: -1,
    limit: 30
  });

  const url = new URL(calls[0].url);
  assert.deepEqual(url.searchParams.getAll('search[]'), ['alpha', 'beta']);
  assert.deepEqual(url.searchParams.getAll('tags[]'), ['daily']);
  assert.equal(url.searchParams.get('conjunction'), 'or');
  assert.equal(url.searchParams.get('page'), '-1');
  assert.equal(url.searchParams.get('limit'), '30');
});

test('getTags accepts a raw array', async () => {
  captureFetch(jsonResponse(['cloud', 'news']));
  const tags = await client().getTags();
  assert.deepEqual(tags, ['cloud', 'news']);
});

test('request throws NextcloudError with status and data', async () => {
  captureFetch(jsonResponse({ status: 'error', message: 'nope' }, 401));

  await assert.rejects(
    () => client().getBookmarks(),
    (error) => {
      assert.ok(error instanceof NextcloudError);
      assert.equal(error.status, 401);
      assert.equal(error.data.message, 'nope');
      return true;
    }
  );
});

test('getExistingUrlSet normalizes URLs', async () => {
  captureFetch(jsonResponse({
    status: 'success',
    data: [
      { url: 'https://example.com/' },
      { url: 'https://example.com/path/' }
    ]
  }));

  const urls = await client().getExistingUrlSet();
  assert.equal(urls.has('https://example.com/'), true);
  assert.equal(urls.has('https://example.com/path'), true);
});

test('createFolder posts the title and parent folder', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', item: { id: 5 } }));
  await client().createFolder({ title: 'New folder', parent_folder: 10 });

  assert.equal(calls[0].options.method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/nextcloud/index.php/apps/bookmarks/public/rest/v2/folder');
  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get('title'), 'New folder');
  assert.equal(body.get('parent_folder'), '10');
});

test('updateFolder uses PUT and the folder id', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', item: { id: 5 } }));
  await client().updateFolder(5, { title: 'Renamed', parent_folder: -1 });

  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(new URL(calls[0].url).pathname, '/nextcloud/index.php/apps/bookmarks/public/rest/v2/folder/5');
  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get('title'), 'Renamed');
  assert.equal(body.get('parent_folder'), '-1');
});

test('getBookmarks sends sortby and folder when set', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', data: [] }));
  await client().getBookmarks({ sortby: 'title', folder: 10 });

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('sortby'), 'title');
  assert.equal(url.searchParams.get('folder'), '10');
});

test('getBookmarks maps filter names to API flags', async () => {
  for (const [filter, key] of [
    ['untagged', 'untagged'],
    ['unavailable', 'unavailable'],
    ['duplicated', 'duplicated']
  ]) {
    const calls = captureFetch(jsonResponse({ status: 'success', data: [] }));
    await client().getBookmarks({ filter });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get(key), 'true', filter);
  }
});

test('getBookmarks omits the folder for the all-folders view', async () => {
  const calls = captureFetch(jsonResponse({ status: 'success', data: [] }));
  await client().getBookmarks({ folder: null, filter: 'all' });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.has('folder'), false);
  assert.equal(url.searchParams.has('untagged'), false);
  assert.equal(url.searchParams.has('unavailable'), false);
  assert.equal(url.searchParams.has('duplicated'), false);
});

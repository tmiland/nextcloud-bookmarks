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

test('findCurrentBookmark retries without a trailing slash', async () => {
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return count === 1
      ? jsonResponse({ status: 'success', data: [] })
      : jsonResponse({ status: 'success', data: [{ id: 9 }] });
  };

  const bookmark = await client().findCurrentBookmark('https://example.com/');
  assert.equal(bookmark.id, 9);
  assert.equal(count, 2);
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
  assert.equal(urls.has('https://example.com'), true);
  assert.equal(urls.has('https://example.com/path'), true);
});

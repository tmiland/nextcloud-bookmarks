import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { BookmarkStore } from '../extension/src/store.mjs';

let counter = 0;

function makeStore() {
  counter += 1;
  return new BookmarkStore({ dbName: `nextcloud-bookmarks-test-${counter}` });
}

const bookmarks = [
  { id: 1, url: 'https://one.example/', title: 'One', tags: ['a'], folders: [-1] },
  { id: 2, url: 'https://two.example/', title: 'Two', tags: ['b'], folders: [10] }
];

test('replaceAll stores account records and metadata', async () => {
  const store = makeStore();
  await store.replaceAll('account-a', bookmarks, 1000);

  assert.deepEqual(await store.getAll('account-a'), bookmarks);
  assert.deepEqual(await store.meta('account-a'), {
    key: 'account-a:meta',
    account: 'account-a',
    syncedAt: 1000,
    count: 2
  });
  assert.deepEqual(await store.getAll('account-b'), []);
});

test('replaceAll replaces only the named account', async () => {
  const store = makeStore();
  await store.replaceAll('account-a', bookmarks, 1000);
  await store.replaceAll('account-b', [{ id: 9, url: 'https://nine.example/', title: 'Nine' }], 2000);
  await store.replaceAll('account-a', [bookmarks[0]], 3000);

  assert.deepEqual((await store.getAll('account-a')).map((item) => item.id), [1]);
  assert.deepEqual((await store.getAll('account-b')).map((item) => item.id), [9]);
});

test('upsert and remove update one record', async () => {
  const store = makeStore();
  await store.replaceAll('account-a', bookmarks, 1000);
  await store.upsert('account-a', { ...bookmarks[0], title: 'Updated' });

  assert.equal((await store.getAll('account-a'))[0].title, 'Updated');
  await store.remove('account-a', 2);
  assert.deepEqual((await store.getAll('account-a')).map((item) => item.id), [1]);
});

test('clear removes one account and keeps the other', async () => {
  const store = makeStore();
  await store.replaceAll('account-a', bookmarks, 1000);
  await store.replaceAll('account-b', [{ id: 9, url: 'https://nine.example/' }], 2000);

  await store.clear('account-a');
  assert.deepEqual(await store.getAll('account-a'), []);
  assert.equal(await store.meta('account-a'), null);
  assert.deepEqual((await store.getAll('account-b')).map((item) => item.id), [9]);
});

test('write epochs advance and block a stale replaceAll', async () => {
  const store = makeStore();
  assert.equal(await store.writeEpoch('account-a'), 0);
  await store.upsert('account-a', { id: 1, url: 'https://one.example/' });
  assert.equal(await store.writeEpoch('account-a'), 1);
  await store.remove('account-a', 1);
  assert.equal(await store.writeEpoch('account-a'), 2);

  const replaced = await store.replaceAll(
    'account-a',
    [{ id: 2, url: 'https://two.example/' }],
    1000,
    { expectedEpoch: 1 }
  );
  assert.equal(replaced, false);
  assert.deepEqual(await store.getAll('account-a'), []);
});

test('projects records down to the searchable fields', async () => {
  const store = makeStore();
  await store.replaceAll('account-a', [{
    id: 1,
    url: 'https://one.example/',
    title: 'One',
    tags: ['a'],
    folders: [-1],
    htmlContent: '<p>archived</p>',
    textContent: 'archived text',
    archivedFile: 7
  }], 1000);

  const stored = (await store.getAll('account-a'))[0];
  assert.equal(stored.title, 'One');
  assert.equal(stored.htmlContent, undefined);
  assert.equal(stored.textContent, undefined);
  assert.equal(stored.archivedFile, undefined);
});

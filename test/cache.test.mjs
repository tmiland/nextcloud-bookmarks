import test from 'node:test';
import assert from 'node:assert/strict';

import { cacheKey, clearCache, readCache, writeCache } from '../extension/src/cache.mjs';

function fakeApi(initial = {}) {
  const data = { ...initial };
  return {
    data,
    storage: {
      local: {
        async get(key) {
          return { [key]: data[key] };
        },
        async set(values) {
          Object.assign(data, values);
        },
        async remove(key) {
          delete data[key];
        }
      }
    }
  };
}

test('cacheKey includes the version, kind, and account', () => {
  assert.equal(
    cacheKey('folders', 'https://cloud.example.com|alice'),
    'nextcloud-bookmarks:v1:folders:https://cloud.example.com|alice'
  );
});

test('writeCache and readCache round-trip with a timestamp', async () => {
  const api = fakeApi();
  const key = cacheKey('tags', 'account');
  await writeCache(api, key, ['one', 'two'], 1000);

  assert.deepEqual(await readCache(api, key, { now: 1500 }), {
    value: ['one', 'two'],
    fetchedAt: 1000
  });
});

test('readCache returns null and removes an expired entry', async () => {
  const api = fakeApi();
  const key = cacheKey('folders', 'account');
  await writeCache(api, key, [{ id: 1 }], 1000);

  assert.equal(await readCache(api, key, { maxAge: 100, now: 1200 }), null);
  assert.equal(api.data[key], undefined);
});

test('readCache rejects malformed entries', async () => {
  const api = fakeApi({ bad: { v: 0, value: 'nope' } });
  assert.equal(await readCache(api, 'bad'), null);
});

test('clearCache removes only the named key', async () => {
  const api = fakeApi();
  const first = cacheKey('folders', 'account-a');
  const second = cacheKey('folders', 'account-b');
  await writeCache(api, first, ['a'], 1);
  await writeCache(api, second, ['b'], 1);

  await clearCache(api, first);
  assert.equal(api.data[first], undefined);
  assert.ok(api.data[second]);
});

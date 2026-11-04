import test from 'node:test';
import assert from 'node:assert/strict';

import { syncBookmarks, updateIndexAfterWrite } from '../extension/src/sync.mjs';

function fakeStore(meta = null) {
  const state = { meta, bookmarks: [], replaced: [] };
  return {
    state,
    async meta() {
      return state.meta;
    },
    async writeEpoch() {
      return state.epoch || 0;
    },
    async replaceAll(account, bookmarks, syncedAt) {
      state.replaced.push({ account, bookmarks, syncedAt });
      state.bookmarks = bookmarks;
      state.meta = { syncedAt, count: bookmarks.length };
      return true;
    },
    async upsert(account, bookmark) {
      state.replaced.push({ account, bookmark });
    },
    async remove(account, id) {
      state.replaced.push({ account, deletedId: id });
    }
  };
}

test('syncBookmarks skips a fresh index', async () => {
  const store = fakeStore({ syncedAt: 900, count: 2 });
  let calls = 0;
  const client = {
    async getAllBookmarks() {
      calls++;
      return { status: 'success', data: [] };
    }
  };

  const result = await syncBookmarks({
    client,
    store,
    account: 'a',
    maxAge: 200,
    now: 1000
  });
  assert.deepEqual(result, { synced: false, count: 2, syncedAt: 900 });
  assert.equal(calls, 0);
});

test('syncBookmarks replaces a stale index', async () => {
  const store = fakeStore({ syncedAt: 100, count: 0 });
  const client = {
    async getAllBookmarks() {
      return { status: 'success', data: [{ id: 1 }, { id: 2 }] };
    }
  };

  const result = await syncBookmarks({
    client,
    store,
    account: 'a',
    maxAge: 200,
    now: 1000
  });
  assert.deepEqual(result, { synced: true, count: 2, syncedAt: 1000 });
  assert.equal(store.state.replaced[0].account, 'a');
  assert.equal(store.state.replaced[0].syncedAt, 1000);
});

test('syncBookmarks forces a sync and leaves old data on failure', async () => {
  const store = fakeStore({ syncedAt: 900, count: 2 });
  const client = {
    async getAllBookmarks() {
      return { status: 'error', data: [] };
    }
  };

  await assert.rejects(
    () => syncBookmarks({ client, store, account: 'a', force: true, now: 1000 }),
    /Could not sync/
  );
  assert.equal(store.state.replaced.length, 0);
  assert.deepEqual(store.state.meta, { syncedAt: 900, count: 2 });
});

test('updateIndexAfterWrite upserts and removes records', async () => {
  const store = fakeStore();
  await updateIndexAfterWrite({ store, account: 'a', bookmark: { id: 3 } });
  await updateIndexAfterWrite({ store, account: 'a', deletedId: 3 });
  assert.deepEqual(store.state.replaced, [
    { account: 'a', bookmark: { id: 3 } },
    { account: 'a', deletedId: 3 }
  ]);
});

test('syncBookmarks does not replace a write that happened during the fetch', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });

  const store = {
    epoch: 0,
    data: [],
    async meta() {
      return null;
    },
    async writeEpoch() {
      return this.epoch;
    },
    async replaceAll(account, bookmarks, syncedAt, { expectedEpoch } = {}) {
      if (expectedEpoch !== this.epoch) return false;
      this.data = bookmarks;
      return true;
    }
  };

  const client = {
    async getAllBookmarks() {
      started();
      await gate;
      return { status: 'success', data: [{ id: 1, title: 'Server copy' }] };
    }
  };

  const pending = syncBookmarks({ client, store, account: 'a', force: true, now: 1000 });
  await startedPromise;
  store.epoch = 1;
  release();

  const result = await pending;
  assert.equal(result.synced, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(store.data, []);
});

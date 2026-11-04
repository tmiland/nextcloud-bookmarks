import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearImportJob,
  countMissingFolders,
  dedupeImportItems,
  ensureImportFolders,
  folderIdForPath,
  loadImportJob,
  mapLimit,
  planImport,
  runImport,
  saveImportJob,
  withRetry
} from '../extension/src/import.mjs';

function bookmark(url, title = '') {
  return { type: 'bookmark', url, title };
}

function folder(id, title, children = []) {
  return { type: 'folder', id, title, children };
}

const tree = [
  folder('toolbar_____', 'Toolbar', [
    bookmark('https://one.example/', 'One'),
    folder('f1', 'Work', [
      bookmark('https://two.example/', 'Two'),
      folder('f2', 'Projects', [
        bookmark('https://three.example/', 'Three')
      ])
    ]),
    bookmark('javascript:alert(1)', 'Unsupported')
  ])
];

test('planImport keeps paths relative to the selected folder', () => {
  const plan = planImport({
    firefoxTree: tree,
    selectedFolderId: 'toolbar_____',
    destinationId: 10
  });

  assert.deepEqual(plan.items, [
    { url: 'https://one.example/', title: 'One', path: [] },
    { url: 'https://two.example/', title: 'Two', path: ['Work'] },
    { url: 'https://three.example/', title: 'Three', path: ['Work', 'Projects'] }
  ]);
  assert.deepEqual(plan.folderPlans, [
    ['Work'],
    ['Work', 'Projects']
  ]);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.destinationId, 10);
});

test('planImport includes top-level folder names for all bookmarks', () => {
  const plan = planImport({
    firefoxTree: tree,
    selectedFolderId: 'all',
    destinationId: -1
  });
  assert.deepEqual(plan.items.map((item) => item.path), [
    ['Toolbar'],
    ['Toolbar', 'Work'],
    ['Toolbar', 'Work', 'Projects']
  ]);
});

test('planImport flattens paths when folder recreation is off', () => {
  const plan = planImport({
    firefoxTree: tree,
    selectedFolderId: 'toolbar_____',
    destinationId: 10,
    recreateFolders: false
  });
  assert.deepEqual(plan.items.map((item) => item.path), [[], [], []]);
  assert.deepEqual(plan.folderPlans, []);
});

test('countMissingFolders reuses existing siblings and nested folders', () => {
  const existing = [
    { id: 10, title: 'Work', parent_folder: -1 },
    { id: 11, title: 'Projects', parent_folder: 10 }
  ];
  assert.equal(countMissingFolders(existing, [['Work'], ['Work', 'Projects']], -1), 0);
  assert.equal(countMissingFolders(existing, [['Work', 'Projects', '2026']], -1), 1);
  assert.equal(countMissingFolders([], [['Work'], ['Work', 'Projects']], -1), 2);
});

test('ensureImportFolders creates parent-first and maps full paths', async () => {
  const created = [];
  const client = {
    async createFolder({ title, parent_folder }) {
      const item = { id: 100 + created.length, title, parent_folder };
      created.push(item);
      return { status: 'success', item };
    }
  };

  const result = await ensureImportFolders({
    client,
    folders: [{ id: 10, title: 'Work', parent_folder: -1 }],
    plans: [['Work'], ['Work', 'Projects'], ['Work', 'Projects', '2026']],
    destinationId: -1
  });

  assert.deepEqual(created.map((item) => [item.title, item.parent_folder]), [
    ['Projects', 10],
    ['2026', 100]
  ]);
  assert.equal(result.folderIds.get(JSON.stringify(['Work'])), 10);
  assert.equal(result.folderIds.get(JSON.stringify(['Work', 'Projects'])), 100);
  assert.equal(result.folderIds.get(JSON.stringify(['Work', 'Projects', '2026'])), 101);
});

test('folderIdForPath reads maps and plain objects', () => {
  const map = new Map([[JSON.stringify(['Work']), 10]]);
  assert.equal(folderIdForPath(map, ['Work'], -1), 10);
  assert.equal(folderIdForPath(map, ['Missing'], 10), 10);
  assert.equal(folderIdForPath({ '["Work"]': 11 }, ['Work'], -1), 11);
  assert.equal(folderIdForPath(null, ['Work'], -1), -1);
});

test('mapLimit never exceeds the limit and preserves order', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });

  assert.equal(maxActive <= 3, true);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12, 14]);
});

test('withRetry retries retryable errors and stops on 400', async () => {
  let attempts = 0;
  const value = await withRetry(async () => {
    attempts++;
    if (attempts < 3) {
      throw Object.assign(new Error('busy'), { status: 500 });
    }
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);

  let badAttempts = 0;
  await assert.rejects(
    () => withRetry(async () => {
      badAttempts++;
      throw Object.assign(new Error('bad'), { status: 400 });
    }, { sleep: async () => {} }),
    /bad/
  );
  assert.equal(badAttempts, 1);
});

test('runImport uses concurrency, skips duplicates, and resumes completed items', async () => {
  let active = 0;
  let maxActive = 0;
  const created = [];
  const client = {
    async createBookmark(payload) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      if (payload.url === 'https://duplicate.example/') {
        throw Object.assign(new Error('already exists'), {
          status: 400,
          data: { data: 'Bookmark already exists' }
        });
      }
      created.push(payload.url);
      return { status: 'success', item: { id: created.length } };
    }
  };

  const items = Array.from({ length: 12 }, (_, index) => ({
    url: index === 3 ? 'https://duplicate.example/' : `https://item-${index}.example/`,
    title: `Item ${index}`,
    path: []
  }));

  const job = {
    items,
    destinationId: -1,
    folderIds: {},
    completed: [0, 1],
    created: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };

  const result = await runImport({
    client,
    job,
    concurrency: 5,
    onProgress: () => {}
  });

  assert.equal(maxActive <= 5, true);
  assert.equal(result.created, 9);
  assert.equal(result.skipped, 1);
  assert.equal(result.remaining, 0);
  assert.equal(created.includes('https://item-0.example/'), false);
  assert.equal(created.includes('https://item-11.example/'), true);
});

test('runImport stops on cancel and keeps completed indexes', async () => {
  let cancelled = false;
  const client = {
    async createBookmark() {
      cancelled = true;
      return { status: 'success', item: { id: 1 } };
    }
  };

  const job = {
    items: [
      { url: 'https://a.example/', title: 'A', path: [] },
      { url: 'https://b.example/', title: 'B', path: [] },
      { url: 'https://c.example/', title: 'C', path: [] }
    ],
    destinationId: -1,
    folderIds: {},
    completed: [],
    created: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };

  const result = await runImport({
    client,
    job,
    concurrency: 1,
    shouldCancel: () => cancelled
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.remaining > 0, true);
  assert.equal(job.completed.length, 1);
});

test('loadImportJob only returns a job for the same account', async () => {
  const storage = new Map();
  const api = {
    storage: {
      local: {
        async get(key) {
          return { [key]: storage.get(key) };
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        },
        async remove(key) {
          storage.delete(key);
        }
      }
    }
  };

  const job = { account: 'account-a', items: [{ url: 'https://a.example/' }] };
  await saveImportJob(api, job);
  assert.deepEqual(await loadImportJob(api, 'account-a'), job);
  assert.equal(await loadImportJob(api, 'account-b'), null);

  await clearImportJob(api, 'account-a');
  assert.equal(await loadImportJob(api, 'account-a'), null);
});

test('runImport keeps failed items resumable and retries them', async () => {
  let attempts = 0;
  const client = {
    async createBookmark() {
      attempts++;
      if (attempts <= 3) {
        throw Object.assign(new Error('server down'), { status: 503 });
      }
      return { status: 'success', item: { id: 1 } };
    }
  };

  const job = {
    items: [{ url: 'https://retry.example/', title: 'Retry', path: [] }],
    destinationId: -1,
    folderIds: {},
    completed: [],
    created: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };

  const first = await runImport({ client, job, sleep: async () => {} });
  assert.equal(first.created, 0);
  assert.equal(first.failed, 1);
  assert.equal(first.remaining, 1);
  assert.deepEqual(job.completed, []);

  const second = await runImport({ client, job, sleep: async () => {} });
  assert.equal(second.created, 1);
  assert.equal(second.remaining, 0);
  assert.deepEqual(job.completed, [0]);
});

test('dedupeImportItems skips server duplicates and duplicates within the tree', () => {
  const existing = new Set(['https://existing.example/']);
  const result = dedupeImportItems([
    { url: 'https://existing.example/', title: 'Existing', path: [] },
    { url: 'https://new.example/', title: 'New', path: [] },
    { url: 'https://new.example', title: 'New again', path: [] },
    { url: 'https://other.example/?utm_source=x', title: 'Other', path: [] }
  ], existing);

  assert.deepEqual(result.items.map((item) => item.title), ['New', 'Other']);
  assert.equal(result.duplicates, 2);
});

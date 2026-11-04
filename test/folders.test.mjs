import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFolder,
  ensureFolderPath,
  fetchFolders,
  folderPath,
  folderTree,
  renameFolder
} from '../extension/src/folders.mjs';

test('fetchFolders marks folders owned by another user as shared', async () => {
  const client = {
    async getFolders() {
      return {
        data: [
          { id: 1, title: 'Work', parent_folder: -1, userId: 'alice' },
          { id: 2, title: 'Shared', parent_folder: -1, userId: 'bob' },
          { id: 3, title: 'No owner', parent_folder: -1 }
        ]
      };
    }
  };

  const folders = await fetchFolders(client, 'Alice');
  assert.deepEqual(folders.map((folder) => [folder.id, folder.shared]), [
    [1, false],
    [2, true],
    [3, false]
  ]);
});

test('folderPath returns the ancestor titles', () => {
  const folders = [
    { id: 1, title: 'Work', parent_folder: -1 },
    { id: 2, title: 'Projects', parent_folder: 1 },
    { id: 3, title: 'Q4', parent_folder: 2 }
  ];
  assert.deepEqual(folderPath(folders, 3), ['Work', 'Projects', 'Q4']);
  assert.deepEqual(folderPath(folders, -1), []);
  assert.deepEqual(folderPath(folders, 99), []);
});

test('folderTree hides shared folders unless asked to include them', () => {
  const folders = [
    { id: 1, title: 'Work', parent_folder: -1, shared: false },
    { id: 2, title: 'Shared', parent_folder: -1, shared: true }
  ];
  assert.deepEqual(folderTree(folders).map((folder) => folder.id), [1]);
  assert.deepEqual(folderTree(folders, { includeShared: true }).map((folder) => folder.id), [2, 1]);
});

test('ensureFolderPath reuses existing siblings and creates only the missing tail', async () => {
  const created = [];
  const client = {
    async createFolder({ title, parent_folder }) {
      const folder = { id: 100 + created.length, title, parent_folder };
      created.push(folder);
      return { status: 'success', item: folder };
    }
  };

  let folders = [
    { id: 1, title: 'Work', parent_folder: -1 },
    { id: 2, title: 'Projects', parent_folder: 1 }
  ];
  let result = await ensureFolderPath(client, folders, ['Work', 'Projects']);
  assert.equal(result.id, 2);
  assert.deepEqual(created, []);

  result = await ensureFolderPath(client, folders, ['Work', 'Projects', '2026']);
  assert.equal(result.id, 100);
  assert.deepEqual(created.map((folder) => [folder.title, folder.parent_folder]), [['2026', 2]]);

  result = await ensureFolderPath(client, result.folders, ['work', 'projects', '2026', 'Q4']);
  assert.equal(result.id, 101);
  assert.deepEqual(created.map((folder) => folder.title), ['2026', 'Q4']);
});

test('createFolder and renameFolder return the server item', async () => {
  const calls = [];
  const client = {
    async createFolder(payload) {
      calls.push({ type: 'create', payload });
      return { status: 'success', item: { id: 5, ...payload } };
    },
    async updateFolder(id, payload) {
      calls.push({ type: 'update', id, payload });
      return { status: 'success', item: { id, ...payload } };
    }
  };

  const created = await createFolder(client, 'New', 1);
  assert.equal(created.id, 5);
  const renamed = await renameFolder(client, 5, 'Renamed', 1);
  assert.equal(renamed.title, 'Renamed');
  assert.deepEqual(calls, [
    { type: 'create', payload: { title: 'New', parent_folder: 1 } },
    { type: 'update', id: 5, payload: { title: 'Renamed', parent_folder: 1 } }
  ]);
});

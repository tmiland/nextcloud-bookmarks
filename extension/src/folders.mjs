import { AppError, buildFolderTree } from './utils.mjs';

function sameTitle(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

export async function fetchFolders(client, username) {
  const result = await client.getFolders();
  const list = Array.isArray(result?.data) ? result.data : [];
  const ownUser = String(username ?? '').toLowerCase();

  return list.map((folder) => ({
    ...folder,
    shared: Boolean(folder.userId && ownUser && String(folder.userId).toLowerCase() !== ownUser)
  }));
}

export async function createFolder(client, title, parentFolder = -1) {
  const result = await client.createFolder({ title, parent_folder: parentFolder });
  if (!result?.item?.id) {
    throw new AppError('folderCreateFailed');
  }
  return result.item;
}

export async function renameFolder(client, id, title, parentFolder = -1) {
  const result = await client.updateFolder(id, { title, parent_folder: parentFolder });
  if (!result?.item?.id) {
    throw new AppError('folderRenameFailed');
  }
  return result.item;
}

export function folderPath(folders, id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric) || numeric === -1) {
    return [];
  }

  const byId = new Map(folders.map((folder) => [Number(folder.id), folder]));
  const path = [];
  const seen = new Set();
  let current = byId.get(numeric);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.title || '');
    const parent = Number(current.parent_folder ?? -1);
    if (parent === -1) {
      break;
    }
    current = byId.get(parent);
  }

  return path;
}

export function folderTree(folders, { includeShared = false } = {}) {
  const list = (folders || []).filter((folder) => includeShared || !folder.shared);
  return buildFolderTree(list);
}

export async function ensureFolderPath(client, folders, path, parentId = -1) {
  let current = Array.isArray(folders) ? folders.slice() : [];
  let parent = Number.isFinite(Number(parentId)) ? Number(parentId) : -1;

  for (const title of path) {
    const existing = current.find((folder) =>
      Number(folder.parent_folder) === parent && sameTitle(folder.title, title)
    );

    if (existing) {
      parent = Number(existing.id);
      continue;
    }

    const created = await createFolder(client, title, parent);
    current = [...current, created];
    parent = Number(created.id);
  }

  return { folders: current, id: parent };
}

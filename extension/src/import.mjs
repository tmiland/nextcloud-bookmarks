import { ensureFolderPath } from './folders.mjs';
import { isSupportedUrl, normalizeUrlForCompare } from './utils.mjs';

function pathKey(path) {
  return JSON.stringify(path || []);
}

function findFolderNode(nodes, id) {
  for (const node of nodes || []) {
    if (node.type === 'folder' && node.id === id) {
      return node;
    }
    if (node.children) {
      const found = findFolderNode(node.children, id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function planImport({
  firefoxTree,
  selectedFolderId,
  destinationId = -1,
  recreateFolders = true,
  existingFolders = []
} = {}) {
  const tree = Array.isArray(firefoxTree) ? firefoxTree : [];
  let roots = tree;

  if (selectedFolderId !== 'all') {
    const selected = findFolderNode(tree, selectedFolderId);
    roots = selected?.children || [];
  }

  const items = [];
  let skipped = 0;

  function walk(nodes, path) {
    for (const node of nodes || []) {
      if (node.type === 'bookmark' && node.url) {
        if (isSupportedUrl(node.url)) {
          items.push({
            url: node.url,
            title: node.title || node.url,
            path: recreateFolders ? [...path] : []
          });
        } else {
          skipped++;
        }
      }
      if (node.type === 'folder' && node.children) {
        const title = node.title || 'Untitled folder';
        walk(node.children, recreateFolders ? [...path, title] : path);
      }
    }
  }

  walk(roots, []);

  const planKeys = new Map();
  for (const item of items) {
    if (!item.path.length) {
      continue;
    }
    planKeys.set(pathKey(item.path), item.path);
  }

  const folderPlans = [...planKeys.values()].sort((a, b) => a.length - b.length);

  return {
    items,
    folderPlans,
    skipped,
    destinationId: Number.isFinite(Number(destinationId)) ? Number(destinationId) : -1,
    existingFolders: Array.isArray(existingFolders) ? existingFolders : []
  };
}

export function dedupeImportItems(items, existingUrls = new Set()) {
  const newItems = [];
  const seen = new Set();
  let duplicates = 0;

  for (const item of items || []) {
    const key = normalizeUrlForCompare(item.url);
    if (existingUrls.has(key) || seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
      newItems.push(item);
    }
  }

  return { items: newItems, duplicates };
}

export function countMissingFolders(folders, folderPlans, destinationId = -1) {
  const known = new Map(
    (folders || []).map((folder) => [
      `${Number(folder.parent_folder ?? -1)}|${String(folder.title ?? '').toLowerCase()}`,
      String(folder.id)
    ])
  );
  let count = 0;

  for (const plan of [...(folderPlans || [])].sort((a, b) => a.length - b.length)) {
    let parent = String(Number(destinationId));
    for (const title of plan) {
      const key = `${parent}|${String(title ?? '').toLowerCase()}`;
      if (known.has(key)) {
        parent = known.get(key);
      } else {
        count++;
        parent = `new:${key}`;
        known.set(key, parent);
      }
    }
  }

  return count;
}

export async function ensureImportFolders({
  client,
  folders = [],
  plans = [],
  destinationId = -1
} = {}) {
  let current = Array.isArray(folders) ? folders.slice() : [];
  const folderIds = new Map();
  const destination = Number.isFinite(Number(destinationId)) ? Number(destinationId) : -1;

  for (const plan of [...plans].sort((a, b) => a.length - b.length)) {
    const result = await ensureFolderPath(client, current, plan, destination);
    current = result.folders;
    folderIds.set(pathKey(plan), result.id);
  }

  return { folders: current, folderIds };
}

export function folderIdForPath(folderIds, path, destinationId = -1) {
  const key = pathKey(path);
  if (folderIds instanceof Map) {
    return folderIds.get(key) ?? destinationId;
  }
  return folderIds?.[key] ?? destinationId;
}

export async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, list.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= list.length) {
          return;
        }
        results[index] = await fn(list[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryable(error) {
  const status = Number(error?.status);
  return !status || status === 429 || status >= 500;
}

export async function withRetry(fn, {
  attempts = 3,
  baseDelay = 200,
  sleep = defaultSleep
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === attempts - 1) {
        throw error;
      }
      await sleep(baseDelay * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function runImport({
  client,
  job,
  onProgress,
  shouldCancel = () => false,
  concurrency = 5,
  sleep = defaultSleep
} = {}) {
  const items = job.items || [];
  const completed = new Set(job.completed || []);
  const pending = [];
  for (let index = 0; index < items.length; index++) {
    if (!completed.has(index)) {
      pending.push(index);
    }
  }

  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, pending.length)) },
    async () => {
      while (true) {
        if (shouldCancel()) {
          return;
        }
        const position = cursor++;
        if (position >= pending.length) {
          return;
        }
        const index = pending[position];
        const item = items[index];
        const folderId = folderIdForPath(job.folderIds, item.path, job.destinationId ?? -1);
        const folders = folderId === -1 ? [] : [folderId];

        try {
          await withRetry(
            () => client.createBookmark({
              url: item.url,
              title: item.title,
              description: '',
              tags: [],
              folders
            }),
            { sleep }
          );
          job.created = (job.created || 0) + 1;
          completed.add(index);
        } catch (error) {
          const detail = error?.data?.data ?? error?.data?.message;
          const text = Array.isArray(detail) ? detail.join(' ') : String(detail ?? '');
          if (/already exists|exists/i.test(text)) {
            job.skipped = (job.skipped || 0) + 1;
            completed.add(index);
          } else {
            job.failed = (job.failed || 0) + 1;
            job.errors = job.errors || [];
            if (job.errors.length < 3) {
              job.errors.push(error?.message || String(error));
            }
          }
        }

        job.completed = [...completed].sort((a, b) => a - b);
        onProgress?.(job);
      }
    }
  );

  await Promise.all(workers);

  return {
    created: job.created || 0,
    skipped: job.skipped || 0,
    failed: job.failed || 0,
    errors: job.errors || [],
    cancelled: shouldCancel(),
    remaining: items.length - completed.size,
    completed: [...completed].sort((a, b) => a - b)
  };
}

function importJobKey(account) {
  return `importJob:${account}`;
}

export async function loadImportJob(api, account) {
  try {
    const key = importJobKey(account);
    const result = await api.storage.local.get(key);
    const job = result?.[key];
    if (!job || job.account !== account || !Array.isArray(job.items)) {
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

export async function saveImportJob(api, job) {
  await api.storage.local.set({ [importJobKey(job.account)]: job });
}

export async function clearImportJob(api, account) {
  try {
    await api.storage.local.remove(importJobKey(account));
  } catch {
    // The job is best effort; a stale job can be discarded later.
  }
}

export { pathKey };

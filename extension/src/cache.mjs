const CACHE_VERSION = 1;

export function cacheKey(kind, account) {
  return `nextcloud-bookmarks:v${CACHE_VERSION}:${kind}:${account}`;
}

export async function readCache(api, key, { maxAge = Infinity, now = Date.now() } = {}) {
  try {
    const result = await api.storage.local.get(key);
    const entry = result?.[key];
    if (!entry || entry.v !== CACHE_VERSION || typeof entry.fetchedAt !== 'number') {
      return null;
    }
    if (maxAge !== Infinity && now - entry.fetchedAt > maxAge) {
      await api.storage.local.remove(key);
      return null;
    }
    return { value: entry.value, fetchedAt: entry.fetchedAt };
  } catch {
    return null;
  }
}

export async function writeCache(api, key, value, now = Date.now()) {
  await api.storage.local.set({
    [key]: { v: CACHE_VERSION, fetchedAt: now, value }
  });
}

export async function clearCache(api, key) {
  try {
    await api.storage.local.remove(key);
  } catch {
    // Cache removal is best effort.
  }
}

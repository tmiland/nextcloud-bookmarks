export async function syncBookmarks({
  client,
  store,
  account,
  maxAge = 5 * 60 * 1000,
  force = false,
  now = Date.now()
}) {
  const meta = await store.meta(account);
  if (!force && meta && now - meta.syncedAt < maxAge) {
    return { synced: false, count: meta.count ?? 0, syncedAt: meta.syncedAt };
  }

  const epoch = await store.writeEpoch(account);
  const result = await client.getAllBookmarks();
  if (result?.status !== 'success' || !Array.isArray(result.data)) {
    throw new Error('Could not sync bookmarks.');
  }

  const replaced = await store.replaceAll(account, result.data, now, { expectedEpoch: epoch });
  if (replaced === false) {
    return {
      synced: false,
      skipped: true,
      count: meta?.count ?? 0,
      syncedAt: meta?.syncedAt ?? 0
    };
  }
  return { synced: true, count: result.data.length, syncedAt: now };
}

export async function updateIndexAfterWrite({ store, account, bookmark = null, deletedId = null }) {
  if (deletedId !== null && deletedId !== undefined) {
    await store.remove(account, deletedId);
  }
  if (bookmark) {
    await store.upsert(account, bookmark);
  }
}

const DEFAULT_DB = 'nextcloud-bookmarks';
const DEFAULT_VERSION = 1;
const INDEX_FIELDS = [
  'id',
  'url',
  'title',
  'description',
  'tags',
  'folders',
  'lastmodified',
  'added',
  'clickcount',
  'available'
];

export function projectBookmark(bookmark) {
  const projected = {};
  for (const field of INDEX_FIELDS) {
    if (bookmark?.[field] !== undefined) {
      projected[field] = bookmark[field];
    }
  }
  return projected;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function recordKey(account, id) {
  return `${account}:${id}`;
}

function epochKey(account) {
  return `${account}:epoch`;
}

function bumpEpoch(store, account) {
  const request = store.get(epochKey(account));
  request.onsuccess = () => {
    const current = Number(request.result?.value) || 0;
    store.put({ key: epochKey(account), value: current + 1 });
  };
}

export class BookmarkStore {
  constructor({
    indexedDB = globalThis.indexedDB,
    dbName = DEFAULT_DB,
    version = DEFAULT_VERSION
  } = {}) {
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.version = version;
    this.db = null;
    this.opening = null;
  }

  async open() {
    if (this.db) {
      return this.db;
    }
    if (!this.indexedDB) {
      throw new Error('IndexedDB is not available.');
    }

    this.opening ??= new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('bookmarks')) {
          const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'key' });
          bookmarks.createIndex('account', 'account', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
    });

    return this.opening;
  }

  close() {
    this.db?.close();
    this.db = null;
    this.opening = null;
  }

  async replaceAll(account, bookmarks, syncedAt = Date.now(), { expectedEpoch = null } = {}) {
    const db = await this.open();
    if (expectedEpoch !== null) {
      const current = await this.writeEpoch(account);
      if (current !== expectedEpoch) {
        return false;
      }
    }
    const transaction = db.transaction(['bookmarks', 'meta'], 'readwrite');
    const store = transaction.objectStore('bookmarks');
    const meta = transaction.objectStore('meta');
    const index = store.index('account');
    const done = transactionDone(transaction);

    await new Promise((resolve, reject) => {
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(account));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });

    for (const bookmark of bookmarks || []) {
      store.put({ ...projectBookmark(bookmark), key: recordKey(account, bookmark.id), account });
    }

    meta.put({
      key: `${account}:meta`,
      account,
      syncedAt,
      count: (bookmarks || []).length
    });

    await done;
    return true;
  }

  async upsert(account, bookmark) {
    const db = await this.open();
    const transaction = db.transaction(['bookmarks', 'meta'], 'readwrite');
    bumpEpoch(transaction.objectStore('meta'), account);
    transaction.objectStore('bookmarks').put({
      ...projectBookmark(bookmark),
      key: recordKey(account, bookmark.id),
      account
    });
    await transactionDone(transaction);
  }

  async remove(account, id) {
    const db = await this.open();
    const transaction = db.transaction(['bookmarks', 'meta'], 'readwrite');
    bumpEpoch(transaction.objectStore('meta'), account);
    transaction.objectStore('bookmarks').delete(recordKey(account, id));
    await transactionDone(transaction);
  }

  async writeEpoch(account) {
    const db = await this.open();
    const transaction = db.transaction('meta', 'readonly');
    const request = transaction.objectStore('meta').get(epochKey(account));
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    return Number(result?.value) || 0;
  }

  async getAll(account) {
    const db = await this.open();
    const transaction = db.transaction('bookmarks', 'readonly');
    const request = transaction.objectStore('bookmarks').index('account').getAll(account);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    return result.map(({ key, account: owner, ...bookmark }) => bookmark);
  }

  async meta(account) {
    const db = await this.open();
    const transaction = db.transaction('meta', 'readonly');
    const request = transaction.objectStore('meta').get(`${account}:meta`);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    return result;
  }

  async clear(account) {
    const db = await this.open();
    const transaction = db.transaction(['bookmarks', 'meta'], 'readwrite');
    const store = transaction.objectStore('bookmarks');
    const index = store.index('account');
    const done = transactionDone(transaction);

    await new Promise((resolve, reject) => {
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(account));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });

    transaction.objectStore('meta').delete(`${account}:meta`);
    transaction.objectStore('meta').delete(epochKey(account));
    await done;
  }
}

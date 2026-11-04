const DEFAULT_DB = 'nextcloud-bookmarks';
const DEFAULT_VERSION = 1;

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

  async replaceAll(account, bookmarks, syncedAt = Date.now()) {
    const db = await this.open();
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
      store.put({ ...bookmark, key: recordKey(account, bookmark.id), account });
    }

    meta.put({
      key: `${account}:meta`,
      account,
      syncedAt,
      count: (bookmarks || []).length
    });

    await done;
  }

  async upsert(account, bookmark) {
    const db = await this.open();
    const transaction = db.transaction('bookmarks', 'readwrite');
    transaction.objectStore('bookmarks').put({
      ...bookmark,
      key: recordKey(account, bookmark.id),
      account
    });
    await transactionDone(transaction);
  }

  async remove(account, id) {
    const db = await this.open();
    const transaction = db.transaction('bookmarks', 'readwrite');
    transaction.objectStore('bookmarks').delete(recordKey(account, id));
    await transactionDone(transaction);
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
    await done;
  }
}

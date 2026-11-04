import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterBookmarks,
  paginateBookmarks,
  searchLocal,
  sortBookmarks
} from '../extension/src/search.mjs';

const bookmarks = [
  {
    id: 1,
    url: 'https://example.com/',
    title: 'Example Domain',
    description: 'Example bookmark',
    tags: ['news', 'example'],
    folders: [-1],
    lastmodified: 100,
    clickcount: 3,
    available: true
  },
  {
    id: 2,
    url: 'https://nextcloud.com/',
    title: 'Nextcloud',
    description: 'Your cloud',
    tags: ['cloud'],
    folders: [10],
    lastmodified: 200,
    clickcount: 7,
    available: true
  },
  {
    id: 3,
    url: 'https://untagged.example/',
    title: 'Untagged',
    description: '',
    tags: [],
    folders: [-1],
    lastmodified: 300,
    clickcount: 1,
    available: false
  },
  {
    id: 4,
    url: 'https://duplicate.example/',
    title: 'Duplicate',
    description: '',
    tags: ['news'],
    folders: [10, 12],
    lastmodified: 400,
    clickcount: 0,
    available: true
  }
];

function ids(items) {
  return items.map((item) => item.id);
}

test('filterBookmarks applies terms with AND and OR', () => {
  assert.deepEqual(
    ids(filterBookmarks(bookmarks, { terms: ['example', 'bookmark'], conjunction: 'and' })),
    [1]
  );
  assert.deepEqual(
    ids(filterBookmarks(bookmarks, { terms: ['example', 'cloud'], conjunction: 'or' })),
    [1, 2, 3, 4]
  );
});

test('filterBookmarks applies tags with AND and OR', () => {
  assert.deepEqual(
    ids(filterBookmarks(bookmarks, { tags: ['news'], conjunction: 'and' })),
    [1, 4]
  );
  assert.deepEqual(
    ids(filterBookmarks(bookmarks, { tags: ['news', 'cloud'], conjunction: 'or' })),
    [1, 2, 4]
  );
  assert.deepEqual(
    ids(filterBookmarks(bookmarks, { tags: ['news', 'cloud'], conjunction: 'and' })),
    []
  );
});

test('filterBookmarks combines terms and tags', () => {
  assert.deepEqual(
    ids(filterBookmarks(bookmarks, { terms: ['nextcloud'], tags: ['cloud'] })),
    [2]
  );
  assert.deepEqual(
    ids(filterBookmarks(bookmarks, { terms: ['example'], tags: ['cloud'] })),
    []
  );
});

test('filterBookmarks filters by folder, including root', () => {
  assert.deepEqual(ids(filterBookmarks(bookmarks, { folderId: -1 })), [1, 3]);
  assert.deepEqual(ids(filterBookmarks(bookmarks, { folderId: 10 })), [2, 4]);
  assert.deepEqual(ids(filterBookmarks(bookmarks, { folderId: 12 })), [4]);
});

test('filterBookmarks supports untagged, unavailable, and duplicated', () => {
  assert.deepEqual(ids(filterBookmarks(bookmarks, { filter: 'untagged' })), [3]);
  assert.deepEqual(ids(filterBookmarks(bookmarks, { filter: 'unavailable' })), [3]);
  assert.deepEqual(ids(filterBookmarks(bookmarks, { filter: 'duplicated' })), [4]);
});

test('sortBookmarks supports title, url, clickcount, and lastmodified', () => {
  assert.deepEqual(ids(sortBookmarks(bookmarks, 'title')), [4, 1, 2, 3]);
  assert.deepEqual(ids(sortBookmarks(bookmarks, 'url')), [4, 1, 2, 3]);
  assert.deepEqual(ids(sortBookmarks(bookmarks, 'clickcount')), [2, 1, 3, 4]);
  assert.deepEqual(ids(sortBookmarks(bookmarks, 'lastmodified')), [4, 3, 2, 1]);
});

test('paginateBookmarks slices pages and reports whether more remain', () => {
  const first = paginateBookmarks(bookmarks, { page: 0, limit: 2 });
  assert.deepEqual(ids(first.data), [1, 2]);
  assert.equal(first.total, 4);
  assert.equal(first.hasMore, true);

  const second = paginateBookmarks(bookmarks, { page: 1, limit: 2 });
  assert.deepEqual(ids(second.data), [3, 4]);
  assert.equal(second.hasMore, false);

  const all = paginateBookmarks(bookmarks, { page: -1, limit: 1 });
  assert.equal(all.data.length, 4);
  assert.equal(all.hasMore, false);
});

test('searchLocal combines filter, sort, and pagination without mutating input', () => {
  const before = ids(bookmarks);
  const result = searchLocal(bookmarks, {
    terms: ['example'],
    sortby: 'title',
    page: 0,
    limit: 1
  });
  assert.deepEqual(ids(result.data), [4]);
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(ids(bookmarks), before);
});

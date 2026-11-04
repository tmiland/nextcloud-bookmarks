function haystack(bookmark) {
  return [
    bookmark.url,
    bookmark.title,
    bookmark.description,
    ...(Array.isArray(bookmark.tags) ? bookmark.tags : [])
  ]
    .join(' ')
    .toLowerCase();
}

function matchesTerms(bookmark, terms, conjunction) {
  if (!terms.length) {
    return true;
  }
  const text = haystack(bookmark);
  return conjunction === 'and'
    ? terms.every((term) => text.includes(term.toLowerCase()))
    : terms.some((term) => text.includes(term.toLowerCase()));
}

function matchesTags(bookmark, tags, conjunction) {
  if (!tags.length) {
    return true;
  }
  const bookmarkTags = (bookmark.tags || []).map((tag) => tag.toLowerCase());
  return conjunction === 'and'
    ? tags.every((tag) => bookmarkTags.includes(tag.toLowerCase()))
    : tags.some((tag) => bookmarkTags.includes(tag.toLowerCase()));
}

function matchesFilter(bookmark, filter) {
  if (filter === 'untagged') {
    return !(bookmark.tags || []).length;
  }
  if (filter === 'unavailable') {
    return bookmark.available === false;
  }
  if (filter === 'duplicated') {
    return (bookmark.folders || []).length > 1;
  }
  return true;
}

export function filterBookmarks(bookmarks, {
  terms = [],
  tags = [],
  conjunction = 'and',
  folderId = null,
  filter = 'all'
} = {}) {
  const folder = folderId === null || folderId === undefined || folderId === ''
    ? null
    : Number(folderId);
  const normalizedTerms = terms.filter(Boolean);
  const normalizedTags = tags.filter(Boolean);

  return (bookmarks || []).filter((bookmark) => {
    if (!matchesTerms(bookmark, normalizedTerms, conjunction)) return false;
    if (!matchesTags(bookmark, normalizedTags, conjunction)) return false;
    if (!matchesFilter(bookmark, filter)) return false;
    if (folder !== null && !(bookmark.folders || []).map(Number).includes(folder)) return false;
    return true;
  });
}

export function sortBookmarks(bookmarks, sortby = 'lastmodified') {
  return (bookmarks || []).slice().sort((a, b) => {
    if (sortby === 'title') {
      return String(a.title ?? '').localeCompare(String(b.title ?? ''));
    }
    if (sortby === 'url') {
      return String(a.url ?? '').localeCompare(String(b.url ?? ''));
    }
    if (sortby === 'clickcount') {
      return (Number(b.clickcount) || 0) - (Number(a.clickcount) || 0);
    }
    if (sortby === 'added') {
      return (Number(b.added) || 0) - (Number(a.added) || 0);
    }
    return (Number(b.lastmodified) || 0) - (Number(a.lastmodified) || 0);
  });
}

export function paginateBookmarks(bookmarks, { page = 0, limit = 30 } = {}) {
  const total = bookmarks.length;
  if (page === -1) {
    return { data: bookmarks.slice(), total, hasMore: false };
  }

  const start = Math.max(0, page) * limit;
  const end = start + limit;
  return {
    data: bookmarks.slice(start, end),
    total,
    hasMore: end < total
  };
}

export function searchLocal(bookmarks, query = {}) {
  const filtered = filterBookmarks(bookmarks, query);
  const sorted = sortBookmarks(filtered, query.sortby);
  return paginateBookmarks(sorted, {
    page: query.page ?? 0,
    limit: query.limit ?? 30
  });
}

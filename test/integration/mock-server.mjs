import http from 'node:http';
import { URL } from 'node:url';

export const API_ROOT = '/index.php/apps/bookmarks/public/rest/v2';
export const DEFAULT_PORT = 8799;
export const TEST_USER = 'test';
export const TEST_PASSWORD = 'secret';

const AUTH = 'Basic ' + Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`, 'utf8').toString('base64');

function defaultFolders() {
  return [
    { id: 10, title: 'Work', parent_folder: -1, userId: 'test' },
    { id: 11, title: 'Projects', parent_folder: 10, userId: 'test' },
    { id: 12, title: 'Personal', parent_folder: -1, userId: 'test' },
    { id: 13, title: 'Shared', parent_folder: -1, userId: 'other' }
  ];
}

function defaultBookmarks() {
  return [
    {
      id: 1,
      url: 'https://example.com/',
      title: 'Example Domain',
      description: 'Example bookmark',
      tags: ['news', 'example'],
      folders: [-1],
      lastmodified: 1700000000,
      clickcount: 3,
      available: true
    },
    {
      id: 2,
      url: 'https://nextcloud.com/',
      title: 'Nextcloud',
      description: 'Your cloud',
      tags: ['cloud'],
      folders: [-1],
      lastmodified: 1700000100,
      clickcount: 7,
      available: true
    },
    {
      id: 3,
      url: 'https://daily.example/',
      title: 'Daily example',
      description: 'A daily bookmark',
      tags: ['daily'],
      folders: [-1],
      lastmodified: 1700000200,
      clickcount: 1,
      available: true
    }
  ];
}

export function createState() {
  return {
    folders: defaultFolders(),
    bookmarks: defaultBookmarks(),
    requests: [],
    failures: [],
    nextBookmarkId: 4,
    nextFolderId: 14
  };
}

function send(res, status, data, extraHeaders = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };
  res.writeHead(status, { ...headers, ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function asNumber(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalized(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function matchesTerm(bookmark, term) {
  const needle = term.toLowerCase();
  const haystack = [bookmark.url, bookmark.title, bookmark.description]
    .concat(bookmark.tags || [])
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function filterBookmarks(bookmarks, url) {
  const terms = url.searchParams.getAll('search[]').filter(Boolean);
  const tags = url.searchParams.getAll('tags[]').filter(Boolean);
  const conjunction = url.searchParams.get('conjunction') || 'and';
  const urlFilter = url.searchParams.get('url');
  const folderFilter = url.searchParams.get('folder');
  const unavailable = url.searchParams.get('unavailable');
  const duplicated = url.searchParams.get('duplicated');
  const untagged = url.searchParams.get('untagged');

  let data = bookmarks.slice();

  if (urlFilter) {
    data = data.filter((bookmark) => normalized(bookmark.url) === normalized(urlFilter));
  }

  if (folderFilter !== null) {
    const folderId = asNumber(folderFilter);
    data = data.filter((bookmark) => (bookmark.folders || []).includes(folderId));
  }

  if (unavailable !== null) {
    data = data.filter((bookmark) => bookmark.available === false);
  }

  if (duplicated !== null) {
    data = data.filter((bookmark) => (bookmark.folders || []).filter((id) => id !== -1).length > 1);
  }

  if (untagged !== null) {
    data = data.filter((bookmark) => !(bookmark.tags || []).length);
  }

  if (terms.length) {
    data = data.filter((bookmark) => conjunction === 'and'
      ? terms.every((term) => matchesTerm(bookmark, term))
      : terms.some((term) => matchesTerm(bookmark, term)));
  }

  if (tags.length) {
    const tagMatch = (bookmark) => {
      const bookmarkTags = (bookmark.tags || []).map((tag) => tag.toLowerCase());
      return conjunction === 'and'
        ? tags.every((tag) => bookmarkTags.includes(tag.toLowerCase()))
        : tags.some((tag) => bookmarkTags.includes(tag.toLowerCase()));
    };
    data = data.filter(tagMatch);
  }

  const sortby = url.searchParams.get('sortby') || 'lastmodified';
  data.sort((a, b) => {
    if (sortby === 'title') return String(a.title).localeCompare(String(b.title));
    if (sortby === 'url') return String(a.url).localeCompare(String(b.url));
    if (sortby === 'clickcount') return (b.clickcount || 0) - (a.clickcount || 0);
    return (b.lastmodified || 0) - (a.lastmodified || 0);
  });

  const page = asNumber(url.searchParams.get('page'), 0);
  const limit = asNumber(url.searchParams.get('limit'), 10);

  if (page >= 0) {
    data = data.slice(page * limit, (page + 1) * limit);
  }

  return data;
}

function folderTree(folders) {
  return folders.map((folder) => ({ ...folder }));
}

export function createMockServer({ port = DEFAULT_PORT } = {}) {
  const state = createState();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'OPTIONS') {
      send(res, 204, undefined);
      return;
    }

    if (url.pathname === '/test-page' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Test Page</title></head><body><h1 id="page">Test Page</h1></body></html>');
      return;
    }

    const body = await readBody(req);
    state.requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      authorization: req.headers.authorization || '',
      contentType: req.headers['content-type'] || ''
    });

    if (url.pathname === '/__reset' && req.method === 'POST') {
      let replacement = {};
      if (body) {
        try {
          replacement = JSON.parse(body);
        } catch {
          replacement = {};
        }
      }
      const fresh = createState();
      if (Array.isArray(replacement.bookmarks)) fresh.bookmarks = replacement.bookmarks;
      if (Array.isArray(replacement.folders)) fresh.folders = replacement.folders;
      state.folders = fresh.folders;
      state.bookmarks = fresh.bookmarks;
      state.requests = [];
      state.failures = [];
      state.nextBookmarkId = Math.max(0, ...fresh.bookmarks.map((bookmark) => bookmark.id)) + 1;
      state.nextFolderId = Math.max(0, ...fresh.folders.map((folder) => folder.id)) + 1;
      send(res, 200, { status: 'success' });
      return;
    }

    if (url.pathname === '/__state' && req.method === 'GET') {
      send(res, 200, {
        bookmarks: state.bookmarks,
        folders: state.folders,
        requests: state.requests
      });
      return;
    }

    if (url.pathname === '/__requests' && req.method === 'GET') {
      send(res, 200, state.requests);
      return;
    }

    if (url.pathname === '/__fail' && req.method === 'POST') {
      let failure = {};
      try {
        failure = body ? JSON.parse(body) : {};
      } catch {
        failure = {};
      }
      state.failures.push({
        method: failure.method || 'GET',
        pathIncludes: failure.pathIncludes || '',
        status: failure.status || 500,
        times: Number(failure.times || 1)
      });
      send(res, 200, { status: 'success' });
      return;
    }

    const failure = state.failures.find((entry) =>
      entry.times > 0 &&
      entry.method === req.method &&
      url.pathname.includes(entry.pathIncludes)
    );
    if (failure) {
      failure.times--;
      send(res, failure.status, { status: 'error', message: 'Injected failure' });
      return;
    }

    if (!url.pathname.startsWith(`${API_ROOT}/`)) {
      send(res, 404, { status: 'error', message: 'Not found' });
      return;
    }

    if (req.headers.authorization !== AUTH) {
      send(res, 401, { status: 'error', message: 'Unauthorized' }, {
        'WWW-Authenticate': 'Basic realm="Nextcloud"'
      });
      return;
    }

    const bookmarkPath = `${API_ROOT}/bookmark`;
    const folderPath = `${API_ROOT}/folder`;
    const tagPath = `${API_ROOT}/tag`;

    if (url.pathname === bookmarkPath && req.method === 'GET') {
      send(res, 200, { status: 'success', data: filterBookmarks(state.bookmarks, url) });
      return;
    }

    if (url.pathname === bookmarkPath && req.method === 'POST') {
      const params = new URLSearchParams(body);
      const bookmarkUrl = params.get('url') || '';
      if (state.bookmarks.some((bookmark) => normalized(bookmark.url) === normalized(bookmarkUrl))) {
        send(res, 400, { status: 'error', data: 'Bookmark already exists' });
        return;
      }
      const bookmark = {
        id: state.nextBookmarkId++,
        url: bookmarkUrl,
        title: params.get('title') || '',
        description: params.get('description') || '',
        tags: params.getAll('tags[]'),
        folders: params.getAll('folders[]').map(Number).filter(Number.isFinite),
        lastmodified: Math.floor(Date.now() / 1000),
        clickcount: 0,
        available: true
      };
      if (!bookmark.folders.length) bookmark.folders = [-1];
      state.bookmarks.push(bookmark);
      send(res, 200, { status: 'success', item: bookmark });
      return;
    }

    if (url.pathname.startsWith(`${bookmarkPath}/`) && req.method === 'GET') {
      const id = asNumber(url.pathname.slice(bookmarkPath.length + 1));
      const bookmark = state.bookmarks.find((entry) => entry.id === id);
      if (!bookmark) {
        send(res, 404, { status: 'error', message: 'Not found' });
        return;
      }
      send(res, 200, { status: 'success', item: bookmark });
      return;
    }

    if (url.pathname.startsWith(`${bookmarkPath}/`) && req.method === 'PUT') {
      const id = asNumber(url.pathname.slice(bookmarkPath.length + 1));
      const params = new URLSearchParams(body);
      const bookmark = state.bookmarks.find((entry) => entry.id === id);
      if (!bookmark) {
        send(res, 404, { status: 'error', message: 'Not found' });
        return;
      }
      if (params.has('url')) bookmark.url = params.get('url') || bookmark.url;
      if (params.has('title')) bookmark.title = params.get('title') || '';
      if (params.has('description')) bookmark.description = params.get('description') || '';
      if (params.has('tags[]')) bookmark.tags = params.getAll('tags[]');
      if (params.has('folders[]')) bookmark.folders = params.getAll('folders[]').map(Number).filter(Number.isFinite);
      bookmark.lastmodified = Math.floor(Date.now() / 1000);
      send(res, 200, { status: 'success', item: bookmark });
      return;
    }

    if (url.pathname.startsWith(`${bookmarkPath}/`) && req.method === 'DELETE') {
      const id = asNumber(url.pathname.slice(bookmarkPath.length + 1));
      const before = state.bookmarks.length;
      state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== id);
      send(res, 200, { status: state.bookmarks.length < before ? 'success' : 'error' });
      return;
    }

    if (url.pathname === folderPath && req.method === 'GET') {
      send(res, 200, { status: 'success', data: folderTree(state.folders) });
      return;
    }

    if (url.pathname === folderPath && req.method === 'POST') {
      const params = new URLSearchParams(body);
      const folder = {
        id: state.nextFolderId++,
        title: params.get('title') || '',
        parent_folder: asNumber(params.get('parent_folder'), -1),
        userId: TEST_USER
      };
      state.folders.push(folder);
      send(res, 200, { status: 'success', item: folder });
      return;
    }

    if (url.pathname.startsWith(`${folderPath}/`) && req.method === 'GET') {
      const remainder = url.pathname.slice(folderPath.length + 1);
      if (remainder.endsWith('/hash')) {
        const id = asNumber(remainder.slice(0, -5));
        const contents = state.bookmarks.filter((bookmark) => (bookmark.folders || []).includes(id));
        send(res, 200, { status: 'success', data: String(contents.length) });
        return;
      }
      const id = asNumber(remainder);
      const folder = state.folders.find((entry) => entry.id === id);
      if (!folder) {
        send(res, 404, { status: 'error', message: 'Not found' });
        return;
      }
      send(res, 200, { status: 'success', item: folder });
      return;
    }

    if (url.pathname.startsWith(`${folderPath}/`) && req.method === 'PUT') {
      const id = asNumber(url.pathname.slice(folderPath.length + 1));
      const params = new URLSearchParams(body);
      const folder = state.folders.find((entry) => entry.id === id);
      if (!folder) {
        send(res, 404, { status: 'error', message: 'Not found' });
        return;
      }
      if (params.has('title')) folder.title = params.get('title') || '';
      if (params.has('parent_folder')) folder.parent_folder = asNumber(params.get('parent_folder'), folder.parent_folder);
      send(res, 200, { status: 'success', item: folder });
      return;
    }

    if (url.pathname === tagPath && req.method === 'GET') {
      const tags = [...new Set(state.bookmarks.flatMap((bookmark) => bookmark.tags || []))].sort();
      send(res, 200, tags);
      return;
    }

    send(res, 405, { status: 'error', message: 'Method not allowed' });
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createMockServer({ port });
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock Nextcloud listening on http://127.0.0.1:${port}`);
  });
}

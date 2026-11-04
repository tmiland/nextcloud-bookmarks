export const API_BASE = '/index.php/apps/bookmarks/public/rest/v2';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname);
}

export function normalizeServerUrl(raw) {
  let value = String(raw ?? '').trim();
  if (!value) {
    return '';
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid server URL, for example https://cloud.example.com');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The server URL must use http:// or https://');
  }

  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('Use HTTPS for a remote Nextcloud server.');
  }

  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/, '');
  return url.origin + (path && path !== '/' ? path : '');
}

export function originPattern(serverUrl) {
  const url = new URL(serverUrl);
  // Match patterns do not include ports; a host permission covers every port.
  return `${url.protocol}//${url.hostname}/*`;
}

export function utf8ToBinary(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return binary;
}

export function basicAuthHeader(username, password) {
  return `Basic ${btoa(utf8ToBinary(`${username ?? ''}:${password ?? ''}`))}`;
}

export function toParams(values) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(`${key}[]`, item);
      }
    } else if (value !== undefined && value !== null) {
      params.append(key, value);
    }
  }

  return params;
}

export function buildFolderTree(folders) {
  const list = Array.isArray(folders) ? folders : [];
  const childrenByParent = new Map();
  const result = [];
  const added = new Set();

  for (const folder of list) {
    const parent = folder.parent_folder ?? -1;
    if (!childrenByParent.has(parent)) {
      childrenByParent.set(parent, []);
    }
    childrenByParent.get(parent).push(folder);
  }

  function sort(items) {
    return items.sort((a, b) =>
      String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, {
        sensitivity: 'base'
      })
    );
  }

  function walk(parent, depth) {
    for (const folder of sort(childrenByParent.get(parent) ?? [])) {
      if (added.has(folder.id)) {
        continue;
      }
      added.add(folder.id);
      result.push({
        id: folder.id,
        title: folder.title || '(untitled folder)',
        depth,
        parentFolder: parent
      });
      walk(folder.id, depth + 1);
    }
  }

  walk(-1, 0);

  for (const folder of list) {
    if (!added.has(folder.id)) {
      result.push({
        id: folder.id,
        title: folder.title || '(untitled folder)',
        depth: 0,
        parentFolder: folder.parent_folder ?? -1
      });
    }
  }

  return result;
}

export function normalizeUrlForCompare(value) {
  const raw = String(value ?? '').trim();
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href.replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

export function isSupportedUrl(value) {
  return /^(https?|ftp|file):/i.test(String(value ?? ''));
}

export function parseTags(value) {
  return String(value ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function joinTags(tags) {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

export function formatDate(unixSeconds) {
  const value = Number(unixSeconds);
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export function formatError(error, translate = (key, substitutions) => {
  const fallback = {
    unknownError: 'Unknown error',
    errorAuth: 'Authentication failed. Check your username and app password.',
    errorForbidden: 'The server denied access.',
    errorNotFound: 'Bookmarks API not found. Is the Nextcloud Bookmarks app installed?',
    errorServerWithDetail: 'Server error: $1',
    errorServerStatus: 'Server error (HTTP $1).',
    errorNetwork: 'Could not reach the Nextcloud server. Check the URL and your connection.'
  };
  const message = fallback[key] ?? key;
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return values.reduce((result, value, index) => result.split(`$${index + 1}`).join(String(value)), message);
}) {
  if (!error) {
    return translate('unknownError');
  }

  if (error.status === 401) {
    return translate('errorAuth');
  }
  if (error.status === 403) {
    return translate('errorForbidden');
  }
  if (error.status === 404) {
    return translate('errorNotFound');
  }
  if (error.status) {
    const detail = error.data?.message ?? error.data?.data;
    if (detail) {
      const text = Array.isArray(detail) ? detail.join(' ') : String(detail);
      return translate('errorServerWithDetail', [text]);
    }
    return translate('errorServerStatus', [error.status]);
  }

  if (error.message) {
    return error.message;
  }

  return translate('errorNetwork');
}

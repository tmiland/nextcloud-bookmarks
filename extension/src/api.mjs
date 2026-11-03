import {
  API_BASE,
  basicAuthHeader,
  normalizeUrlForCompare,
  originPattern,
  toParams
} from './utils.mjs';

export class NextcloudError extends Error {
  constructor(status, data, message = `HTTP ${status}`) {
    super(message);
    this.name = 'NextcloudError';
    this.status = status;
    this.data = data;
  }
}

export class NextcloudClient {
  constructor({ serverUrl, username, password }) {
    this.serverUrl = String(serverUrl ?? '').replace(/\/+$/, '');
    this.username = String(username ?? '');
    this.password = String(password ?? '');
    this.origin = originPattern(this.serverUrl);
  }

  apiUrl(path, params) {
    const url = new URL(`${this.serverUrl}${API_BASE}${path}`);
    if (params) {
      const query = params instanceof URLSearchParams ? params : toParams(params);
      url.search = query.toString();
    }
    return url.toString();
  }

  async request(path, { method = 'GET', params, body, timeout = 15000 } = {}) {
    const headers = {
      Authorization: basicAuthHeader(this.username, this.password),
      Accept: 'application/json'
    };

    const options = {
      method,
      headers,
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout)
    };

    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      options.body = body instanceof URLSearchParams ? body.toString() : toParams(body).toString();
    }

    let response;
    try {
      response = await fetch(this.apiUrl(path, params), options);
    } catch (error) {
      const networkError = new Error('Could not reach the Nextcloud server');
      networkError.cause = error;
      throw networkError;
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      throw new NextcloudError(response.status, data);
    }

    return data;
  }

  async getBookmarks({ terms = [], tags = [], conjunction = 'and', page = 0, limit = 30 } = {}) {
    return this.request('/bookmark', {
      params: toParams({
        search: terms,
        tags,
        conjunction,
        page,
        limit
      })
    });
  }

  async getAllBookmarks() {
    return this.request('/bookmark', {
      params: toParams({ page: -1, limit: 30 }),
      timeout: 30000
    });
  }

  async findByUrl(url) {
    const result = await this.request('/bookmark', {
      params: toParams({ url, limit: 1 })
    });
    if (result?.status === 'success' && Array.isArray(result.data) && result.data.length > 0) {
      return result.data[0];
    }
    return null;
  }

  async findCurrentBookmark(url) {
    if (!url) {
      return null;
    }

    let bookmark = await this.findByUrl(url);
    if (bookmark) {
      return bookmark;
    }

    const alternate = url.endsWith('/') ? url.replace(/\/+$/, '') : `${url}/`;
    if (alternate !== url) {
      bookmark = await this.findByUrl(alternate);
    }

    return bookmark;
  }

  async createBookmark({ url, title, description, tags, folders }) {
    return this.request('/bookmark', {
      method: 'POST',
      body: toParams({
        url,
        title,
        description,
        tags,
        folders
      })
    });
  }

  async updateBookmark(id, { url, title, description, tags, folders }) {
    return this.request(`/bookmark/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: toParams({
        url,
        title,
        description,
        tags,
        folders
      })
    });
  }

  async deleteBookmark(id) {
    return this.request(`/bookmark/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }

  async getFolders() {
    return this.request('/folder', {
      params: toParams({ root: -1, layers: -1 })
    });
  }

  async getTags() {
    return this.request('/tag');
  }

  async getExistingUrlSet() {
    const result = await this.getAllBookmarks();
    const urls = new Set();
    if (result?.status === 'success' && Array.isArray(result.data)) {
      for (const bookmark of result.data) {
        urls.add(normalizeUrlForCompare(bookmark.url));
      }
    }
    return urls;
  }
}

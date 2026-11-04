import { cacheKey, readCache, writeCache } from './cache.mjs';
import { fetchFolders } from './folders.mjs';
import { localizeDocument, setDocumentLanguage, t } from './i18n.mjs';
import { accountKey, buildClient, hasHostPermission, loadSettings } from './settings.mjs';
import { searchLocal } from './search.mjs';
import { BookmarkStore } from './store.mjs';
import { syncBookmarks, updateIndexAfterWrite } from './sync.mjs';
import {
  buildFolderTree,
  formatDate,
  formatError,
  isSupportedUrl,
  joinTags,
  parseTags
} from './utils.mjs';

const api = globalThis.browser ?? globalThis.chrome;

const SEARCH_LIMIT = 30;
const INDEX_MAX_AGE = 5 * 60 * 1000;

const state = {
  settings: {},
  client: null,
  serverUrl: '',
  folders: [],
  folderById: new Map(),
  lastFolderId: -1,
  loadedFolderValue: null,
  knownTags: [],
  tagIndex: -1,
  pendingDeleteId: null,
  currentTab: { url: '', title: '' },
  currentBookmark: null,
  account: '',
  store: null,
  indexedBookmarks: [],
  indexSyncedAt: 0,
  indexReady: false,
  lastSearch: null,
  searchPage: 0,
  searchHasMore: false,
  searchSource: 'server',
  editingFromSearch: false
};

const $ = (id) => document.getElementById(id);

function setVisible(element, visible) {
  if (element) {
    element.hidden = !visible;
  }
}

function setText(element, text) {
  if (element) {
    element.textContent = text ?? '';
  }
}

function setPageContext(url) {
  const context = $('page-context');
  const pageUrl = $('page-url');
  if (!context || !pageUrl) {
    return;
  }

  if (!url) {
    context.textContent = t('newBookmark');
    pageUrl.textContent = t('openPageToSave');
    return;
  }

  try {
    const parsed = new URL(url);
    context.textContent = parsed.hostname.replace(/^www\./, '');
    pageUrl.textContent = parsed.pathname === '/' ? parsed.origin : parsed.href;
  } catch {
    context.textContent = t('currentPageFallback');
    pageUrl.textContent = url;
  }
}

function setPageState(text) {
  const badge = $('page-state');
  if (badge) {
    badge.textContent = text ?? '';
    badge.hidden = !text;
  }
}

async function init() {
  setDocumentLanguage();
  localizeDocument();
  bindEvents();

  state.settings = await loadSettings();
  state.serverUrl = '';

  if (!state.settings.serverUrl) {
    notify(t('setServerUrl'), 'error', t('openSettings'), openOptions);
    await loadCurrentTab();
    return;
  }

  try {
    state.client = buildClient(state.settings);
    state.serverUrl = state.client.serverUrl;
  } catch (error) {
    notify(error.message, 'error', t('openSettings'), openOptions);
    await loadCurrentTab();
    return;
  }

  const home = $('open-bookmarks');
  if (home) {
    home.href = `${state.serverUrl}/apps/bookmarks/`;
  }

  if (!(await hasHostPermission(api, state.serverUrl))) {
    notify(t('accessRequired'), 'error', t('openSettings'), openOptions);
    await loadCurrentTab();
    return;
  }

  state.account = accountKey(state.serverUrl, state.settings.username);
  state.store = new BookmarkStore();
  state.lastFolderId = await loadLastFolder();

  const [foldersEntry, tagsEntry] = await Promise.all([
    readCache(api, cacheKey('folders', state.account)),
    readCache(api, cacheKey('tags', state.account))
  ]);

  if (foldersEntry) {
    applyFolders(foldersEntry.value);
    void refreshFolders();
  } else {
    await refreshFolders();
  }

  if (tagsEntry) {
    applyTags(tagsEntry.value);
    void refreshTags();
  } else {
    await refreshTags();
  }

  await loadCurrentTab();
  void loadIndex();
}

function openOptions() {
  api.runtime.openOptionsPage();
}

async function loadLastFolder() {
  try {
    const result = await api.storage.local.get('lastFolder');
    const id = Number(result.lastFolder);
    return Number.isFinite(id) ? id : -1;
  } catch {
    return -1;
  }
}

function applyFolders(list) {
  const own = (list || []).filter((folder) => !folder.shared);
  state.folders = buildFolderTree(own);
  state.folderById = new Map(state.folders.map((folder) => [folder.id, folder]));
  populateFolderSelect();
  populateSearchFolderSelect();
  if (state.currentBookmark) {
    applyBookmarkFolder(state.currentBookmark);
  }
}

async function refreshFolders() {
  if (!state.client) {
    return;
  }

  try {
    const list = await fetchFolders(state.client, state.settings.username);
    applyFolders(list);
    await writeCache(api, cacheKey('folders', state.account), list);
  } catch {
    // Keep cached folders on a failed refresh.
  }
}

function populateSearchFolderSelect() {
  const select = $('search-folder');
  if (!select) {
    return;
  }

  const previous = select.value;
  select.replaceChildren(new Option(t('allFolders'), ''));
  select.append(new Option(t('rootNoFolder'), '-1'));

  for (const folder of state.folders) {
    const indent = '\u00a0\u00a0'.repeat(folder.depth);
    select.append(new Option(`${indent}${folder.title}`, String(folder.id)));
  }

  select.value = Array.from(select.options).some((option) => option.value === previous)
    ? previous
    : '';
}

function populateFolderSelect() {
  const select = $('bookmark-folder');
  if (!select) {
    return;
  }

  select.replaceChildren();
  select.append(new Option(t('rootNoFolder'), '-1'));

  for (const folder of state.folders) {
    const indent = '\u00a0\u00a0'.repeat(folder.depth);
    select.append(new Option(`${indent}${folder.title}`, String(folder.id)));
  }

  const desired = String(state.lastFolderId);
  const exists = Array.from(select.options).some((option) => option.value === desired);
  select.value = exists ? desired : '-1';
  select.disabled = false;
  state.loadedFolderValue = null;
}

function folderLabel(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric) || numeric === -1) {
    return t('root');
  }
  return state.folderById.get(numeric)?.title ?? t('folderFallback', [numeric]);
}

function folderNote(value) {
  const numeric = Number(value);
  return numeric === -1 || !Number.isFinite(numeric)
    ? t('savedInRoot')
    : t('savedInFolder', [folderLabel(numeric)]);
}

function applyBookmarkFolder(bookmark) {
  const select = $('bookmark-folder');
  if (!select) {
    return;
  }

  const ids = Array.isArray(bookmark.folders)
    ? bookmark.folders.map(Number).filter(Number.isFinite)
    : [];
  const nonRoot = ids.filter((id) => id !== -1);
  const inRoot = ids.includes(-1);

  select.disabled = false;
  state.loadedFolderValue = null;

  if (nonRoot.length > 1) {
    select.value = String(nonRoot[0]);
    select.disabled = true;
    setFolderNote(t('savedInFolders', [nonRoot.length]));
    return;
  }

  if (nonRoot.length === 1) {
    const id = nonRoot[0];
    const exists = Array.from(select.options).some((option) => option.value === String(id));
    if (!exists) {
      select.value = '-1';
      select.disabled = true;
      setFolderNote(t('savedInFolderUnavailable', [folderLabel(id)]));
      return;
    }

    select.value = String(id);
    state.loadedFolderValue = select.value;
    setFolderNote(`${t('savedInFolder', [folderLabel(id)])}${inRoot ? t('savedInRootAnd') : ''}`);
    return;
  }

  select.value = '-1';
  state.loadedFolderValue = select.value;
  setFolderNote(t('savedInRoot'));
}

function setFolderNote(text) {
  const note = $('folder-note');
  if (note) {
    note.textContent = text ?? '';
    note.hidden = !text;
  }
}

function applyTags(list) {
  state.knownTags = (list || [])
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function refreshTags() {
  if (!state.client) {
    return;
  }

  try {
    const result = await state.client.getTags();
    const list = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
    applyTags(list);
    await writeCache(api, cacheKey('tags', state.account), list);
  } catch {
    // Keep cached tags on a failed refresh.
  }
}

async function loadIndex() {
  if (!state.store || !state.account) {
    return;
  }

  try {
    const [items, meta] = await Promise.all([
      state.store.getAll(state.account),
      state.store.meta(state.account)
    ]);
    state.indexedBookmarks = items;
    state.indexSyncedAt = meta?.syncedAt ?? 0;
    state.indexReady = Boolean(meta) || items.length > 0;
    document.body.dataset.indexReady = state.indexReady ? '1' : 'loading';
    if (!meta || Date.now() - meta.syncedAt > INDEX_MAX_AGE) {
      void refreshIndex(false);
    }
  } catch {
    state.indexReady = false;
    document.body.dataset.indexReady = 'error';
  }
}

async function refreshIndex(force = false) {
  if (!state.store || !state.client || !state.account) {
    return false;
  }
  try {
    const result = await syncBookmarks({
      client: state.client,
      store: state.store,
      account: state.account,
      force
    });
    state.indexedBookmarks = await state.store.getAll(state.account);
    state.indexSyncedAt = result.syncedAt;
    state.indexReady = true;
    document.body.dataset.indexReady = '1';
    if (state.lastSearch && !$('panel-search')?.hidden) {
      void runSearch({ silent: true });
    }
    return true;
  } catch {
    return false;
  }
}

function localSearchAvailable() {
  return state.indexReady && Date.now() - state.indexSyncedAt <= INDEX_MAX_AGE;
}

function mergeIndexedBookmark(bookmark) {
  const index = state.indexedBookmarks.findIndex((item) => String(item.id) === String(bookmark.id));
  if (index >= 0) {
    state.indexedBookmarks[index] = bookmark;
  } else {
    state.indexedBookmarks.push(bookmark);
  }
}

async function loadCurrentTab() {
  const tab = await getCurrentTab();
  if (!tab) {
    return;
  }

  state.currentTab = tab;
  state.editingFromSearch = false;
  setPageContext(tab.url);

  if (!state.client) {
    resetAddForm(tab.url, tab.title);
    return;
  }

  let bookmark = null;
  try {
    bookmark = await state.client.findCurrentBookmark(tab.url);
  } catch {
    bookmark = null;
  }

  if (bookmark) {
    populateAddForm(bookmark, tab.url, tab.title);
  } else {
    resetAddForm(tab.url, tab.title);
  }
}

async function getCurrentTab() {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    return tab ? { url: tab.url ?? '', title: tab.title ?? '' } : null;
  } catch {
    return null;
  }
}

function populateAddForm(bookmark, fallbackUrl, fallbackTitle) {
  state.currentBookmark = bookmark;
  $('bookmark-url').value = bookmark.url || fallbackUrl || '';
  $('bookmark-title').value = bookmark.title || fallbackTitle || '';
  $('bookmark-tags').value = joinTags(bookmark.tags);
  $('bookmark-description').value = bookmark.description || '';
  $('bookmark-id').value = bookmark.id ?? '';

  const save = $('save-bookmark');
  save.textContent = t('updateButton');
  save.disabled = false;
  setVisible($('delete-bookmark'), true);
  setBookmarkStatus(t('alreadySaved'));
  setPageState(t('saved'));
  applyBookmarkFolder(bookmark);
}

function resetAddForm(url, title) {
  state.currentBookmark = null;
  state.editingFromSearch = false;
  const previousUrl = $('bookmark-url').value;
  const changed = previousUrl !== (url ?? '');

  $('bookmark-url').value = url ?? '';
  $('bookmark-title').value = title ?? '';
  $('bookmark-id').value = '';
  $('save-bookmark').textContent = t('saveButton');
  $('save-bookmark').disabled = false;
  setVisible($('delete-bookmark'), false);
  setBookmarkStatus('');
  setPageState('');
  hideTagSuggestions();

  const select = $('bookmark-folder');
  if (select) {
    select.disabled = false;
    const desired = String(state.lastFolderId);
    const exists = Array.from(select.options).some((option) => option.value === desired);
    select.value = exists ? desired : '-1';
  }
  state.loadedFolderValue = null;
  setFolderNote('');

  if (changed) {
    $('bookmark-tags').value = '';
    $('bookmark-description').value = '';
  }
}

function setBookmarkStatus(text) {
  const status = $('bookmark-status');
  if (status) {
    status.textContent = text ?? '';
    status.hidden = !text;
  }
}

async function saveBookmark() {
  if (!state.client) {
    notify(t('setServerUrl'), 'error', t('openSettings'), openOptions);
    return;
  }

  const rawUrl = $('bookmark-url').value.trim().replace(/\/+$/, '');
  if (!rawUrl) {
    notify(t('urlEmpty'), 'error');
    return;
  }

  const id = $('bookmark-id').value;
  const folderValue = $('bookmark-folder').value;
  let folders;

  if (!id) {
    folders = folderValue !== '-1' ? [Number(folderValue)] : [];
  } else if (!$('bookmark-folder').disabled &&
             state.loadedFolderValue !== null &&
             folderValue !== state.loadedFolderValue) {
    folders = folderValue === '-1' ? [-1] : [Number(folderValue)];
  }

  const payload = {
    url: rawUrl,
    title: $('bookmark-title').value,
    description: $('bookmark-description').value,
    tags: parseTags($('bookmark-tags').value),
    folders
  };

  const button = $('save-bookmark');
  button.disabled = true;

  try {
    const result = id
      ? await state.client.updateBookmark(id, payload)
      : await state.client.createBookmark(payload);
    const bookmark = result?.item;

    if (!bookmark?.id) {
      throw new Error(id ? t('bookmarkNotUpdated') : t('bookmarkNotSaved'));
    }

    $('bookmark-id').value = bookmark.id;
    button.textContent = t('updateButton');
    setVisible($('delete-bookmark'), true);
    setBookmarkStatus(t('alreadySaved'));
    setPageState(t('saved'));

    if (!$('bookmark-folder').disabled) {
      state.loadedFolderValue = $('bookmark-folder').value;
      setFolderNote(folderNote(state.loadedFolderValue));
    }

    if (!id) {
      const savedFolder = Number($('bookmark-folder').value);
      state.lastFolderId = Number.isFinite(savedFolder) ? savedFolder : -1;
      api.storage.local.set({ lastFolder: state.lastFolderId }).catch(() => {});
    }

    state.currentBookmark = bookmark;
    mergeIndexedBookmark(bookmark);
    try {
      await updateIndexAfterWrite({ store: state.store, account: state.account, bookmark });
    } catch {
      // The index is best effort; the server write already succeeded.
    }
    void refreshTags();

    const wasEditingFromSearch = state.editingFromSearch;
    state.editingFromSearch = false;
    notify(id ? t('bookmarkUpdated') : t('bookmarkSaved'), 'success');

    if (wasEditingFromSearch && state.lastSearch) {
      activateTab('search');
      void runSearch();
    }
  } catch (error) {
    notify(formatError(error, t), 'error');
  } finally {
    button.disabled = false;
  }
}

function requestDelete(id) {
  if (!id) {
    notify(t('noBookmarkSelected'), 'error');
    return;
  }

  state.pendingDeleteId = id;
  setVisible($('confirm-delete'), true);
}

function cancelDelete() {
  state.pendingDeleteId = null;
  setVisible($('confirm-delete'), false);
}

async function confirmDelete() {
  const id = state.pendingDeleteId;
  cancelDelete();

  if (!id || !state.client) {
    return;
  }

  try {
    await state.client.deleteBookmark(id);
    state.indexedBookmarks = state.indexedBookmarks.filter((item) => String(item.id) !== String(id));
    try {
      await updateIndexAfterWrite({ store: state.store, account: state.account, deletedId: id });
    } catch {
      // The index is best effort; the server delete already succeeded.
    }
    document.getElementById(`bookmark-${id}`)?.remove();

    if (String($('bookmark-id').value) === String(id)) {
      $('bookmark-id').value = '';
      $('bookmark-tags').value = '';
      $('bookmark-description').value = '';
      $('save-bookmark').textContent = t('saveButton');
      setVisible($('delete-bookmark'), false);
      setBookmarkStatus('');
      setPageState('');
      await loadCurrentTab();
    }

    if (state.lastSearch && !$('panel-search')?.hidden) {
      void runSearch({ silent: true });
    }
    notify(t('bookmarkDeleted'), 'success');
  } catch (error) {
    notify(formatError(error, t), 'error');
  }
}

function activateTab(name) {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }

  setVisible($('panel-add'), name === 'add');
  setVisible($('panel-search'), name === 'search');

  if (name === 'search') {
    $('search-terms').focus();
  }
}

function buildSearchQuery() {
  const folderValue = $('search-folder')?.value ?? '';
  return {
    terms: parseTags($('search-terms').value),
    tags: parseTags($('search-tags').value),
    conjunction: $('search-conjunction').value,
    sortby: $('search-sort')?.value || 'lastmodified',
    folderId: folderValue === '' ? null : Number(folderValue),
    filter: $('search-filter')?.value || 'all',
    page: $('search-no-paging')?.checked ? -1 : 0
  };
}

async function runSearch({ append = false, silent = false } = {}) {
  if (!state.client) {
    notify(t('setServerUrl'), 'error', t('openSettings'), openOptions);
    return;
  }

  const query = buildSearchQuery();
  const page = append ? state.searchPage + 1 : query.page;
  const search = { ...query, page };
  const target = $('search-results');
  state.lastSearch = search;

  if (!append) {
    target.replaceChildren();
    if (!silent) {
      target.append(createMessage(t('searching')));
    }
  }

  if (localSearchAvailable()) {
    const result = searchLocal(state.indexedBookmarks, { ...search, limit: SEARCH_LIMIT });
    state.searchPage = page;
    state.searchHasMore = result.hasMore;
    state.searchSource = 'local';
    renderResults(target, result.data, {
      append,
      total: result.total,
      hasMore: result.hasMore,
      source: 'local'
    });
    return;
  }

  try {
    const result = await state.client.getBookmarks({
      terms: search.terms,
      tags: search.tags,
      conjunction: search.conjunction,
      page,
      limit: SEARCH_LIMIT,
      sortby: search.sortby,
      folder: search.folderId,
      filter: search.filter
    });

    if (result?.status === 'error') {
      if (!append) {
        target.replaceChildren(createMessage(result.message || t('serverError')));
      }
      setLoadMore(false);
      return;
    }

    const data = result?.data ?? [];
    state.searchPage = page;
    state.searchHasMore = page !== -1 && data.length >= SEARCH_LIMIT;
    state.searchSource = 'server';
    renderResults(target, data, {
      append,
      hasMore: state.searchHasMore,
      source: 'server'
    });
  } catch (error) {
    if (state.indexReady) {
      const result = searchLocal(state.indexedBookmarks, { ...search, limit: SEARCH_LIMIT });
      state.searchPage = page;
      state.searchHasMore = result.hasMore;
      state.searchSource = 'cached';
      renderResults(target, result.data, {
        append,
        total: result.total,
        hasMore: result.hasMore,
        source: 'cached'
      });
      notify(t('cachedResults'), 'info');
    } else if (!append) {
      target.replaceChildren(createMessage(formatError(error, t)));
      setLoadMore(false);
    }
  }
}

function setLoadMore(visible) {
  setVisible($('load-more'), visible);
}

async function refreshIndexFromButton() {
  const ok = await refreshIndex(true);
  notify(ok ? t('indexRefreshed') : t('indexRefreshFailed'), ok ? 'success' : 'error');
  if (ok && state.lastSearch) {
    void runSearch({ silent: true });
  }
}

function createMessage(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function renderResults(container, bookmarks, {
  append = false,
  total = null,
  hasMore = false,
  source = 'server',
  emptyMessage
} = {}) {
  if (!append) {
    container.replaceChildren();
  }

  if (!bookmarks.length && !append) {
    container.append(createMessage(emptyMessage || t('noBookmarksFound')));
    setLoadMore(false);
    document.body.dataset.searchSource = source;
    return;
  }

  const count = append
    ? container.querySelectorAll('.result').length + bookmarks.length
    : bookmarks.length;

  let heading = container.querySelector('.results-heading');
  if (!heading) {
    heading = document.createElement('p');
    heading.className = 'results-heading';
    container.prepend(heading);
  }
  heading.textContent = count === 1 ? t('bookmarkCountOne') : t('bookmarkCountMany', [count]);

  if (source === 'cached') {
    const note = document.createElement('span');
    note.className = 'results-cached';
    note.textContent = ` · ${t('cachedResults')}`;
    heading.append(note);
  }

  for (const bookmark of bookmarks) {
    container.append(renderResult(bookmark));
  }

  setLoadMore(hasMore);
  document.body.dataset.searchSource = source;
}

function renderResult(bookmark) {
  const card = document.createElement('article');
  card.className = 'result';
  card.id = `bookmark-${bookmark.id}`;

  const title = document.createElement('a');
  title.className = 'result-title';
  title.textContent = bookmark.title || bookmark.url || t('untitledBookmark');
  if (isSupportedUrl(bookmark.url)) {
    title.href = bookmark.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.title = bookmark.url;
  }
  card.append(title);

  const url = document.createElement('div');
  url.className = 'result-url';
  url.textContent = bookmark.url || '';
  card.append(url);

  if (bookmark.description) {
    const description = document.createElement('div');
    description.className = 'result-description';
    description.textContent = bookmark.description;
    card.append(description);
  }

  const meta = document.createElement('div');
  meta.className = 'result-meta';

  for (const tag of Array.isArray(bookmark.tags) ? bookmark.tags : []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tag-button';
    button.textContent = tag;
    button.addEventListener('click', () => searchForTag(tag));
    meta.append(button);
  }

  const date = document.createElement('span');
  date.className = 'result-date';
  date.textContent = formatDate(bookmark.lastmodified);
  if (date.textContent) {
    meta.append(date);
  }

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'result-edit';
  edit.textContent = t('editButton');
  edit.addEventListener('click', () => editResult(bookmark));
  meta.append(edit);

  const open = document.createElement('a');
  open.className = 'result-open';
  open.textContent = t('openInNextcloud');
  open.href = `${state.serverUrl}/index.php/apps/bookmarks/bookmarks/${encodeURIComponent(bookmark.id)}`;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  meta.append(open);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'result-delete';
  remove.textContent = t('deleteButton');
  remove.addEventListener('click', () => requestDelete(bookmark.id));
  meta.append(remove);

  card.append(meta);
  return card;
}

function editResult(bookmark) {
  state.editingFromSearch = true;
  populateAddForm(bookmark, bookmark.url, bookmark.title);
  activateTab('add');
  $('bookmark-title').focus();
  document.documentElement.scrollTop = 0;
}

function searchForTag(tag) {
  $('search-terms').value = '';
  $('search-tags').value = tag;
  activateTab('search');
  runSearch();
}

function tagToken(value) {
  const text = String(value ?? '');
  const index = text.lastIndexOf(',');
  return {
    prefix: index >= 0 ? text.slice(0, index + 1) : '',
    token: text.slice(index + 1).trim()
  };
}

function showTagSuggestions() {
  const input = $('bookmark-tags');
  const list = $('tag-suggestions');
  if (!input || !list) {
    return;
  }

  const { token } = tagToken(input.value);
  const needle = token.toLowerCase();
  const matches = state.knownTags
    .filter((tag) => tag.toLowerCase().startsWith(needle) && tag.toLowerCase() !== needle)
    .slice(0, 8);

  if (!matches.length) {
    hideTagSuggestions();
    return;
  }

  list.replaceChildren();
  for (const tag of matches) {
    const item = document.createElement('li');
    item.textContent = tag;
    item.dataset.tag = tag;
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      insertTag(tag);
    });
    list.append(item);
  }

  state.tagIndex = -1;
  list.hidden = false;
}

function hideTagSuggestions() {
  const list = $('tag-suggestions');
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
  state.tagIndex = -1;
}

function insertTag(tag) {
  const input = $('bookmark-tags');
  if (!input) {
    return;
  }

  const { prefix } = tagToken(input.value);
  const before = prefix.replace(/[,\s]+$/, '');
  input.value = `${before ? `${before}, ` : ''}${tag}, `;
  input.focus();
  hideTagSuggestions();
}

function highlightTag(index) {
  const items = Array.from(document.querySelectorAll('#tag-suggestions li'));
  if (!items.length) {
    return;
  }

  state.tagIndex = Math.max(0, Math.min(index, items.length - 1));
  items.forEach((item, itemIndex) => {
    item.classList.toggle('is-active', itemIndex === state.tagIndex);
  });
  items[state.tagIndex].scrollIntoView({ block: 'nearest' });
}

function notify(message, type = 'info', actionLabel, action) {
  const box = $('notification');
  if (!box) {
    return;
  }

  box.replaceChildren();
  box.className = 'notification';
  if (type === 'error') {
    box.classList.add('is-error');
  }
  if (type === 'success') {
    box.classList.add('is-success');
  }

  const text = document.createElement('span');
  text.textContent = message;
  box.append(text);

  if (actionLabel && typeof action === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-small';
    button.textContent = actionLabel;
    button.addEventListener('click', action);
    box.append(button);
  }

  box.hidden = false;
  window.clearTimeout(notify.timer);

  if (!action) {
    notify.timer = window.setTimeout(() => {
      box.hidden = true;
    }, 4000);
  }
}

function bindEvents() {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  }

  $('open-options').addEventListener('click', openOptions);
  $('bookmark-form').addEventListener('submit', (event) => event.preventDefault());
  $('save-bookmark').addEventListener('click', saveBookmark);
  $('delete-bookmark').addEventListener('click', () => requestDelete($('bookmark-id').value));
  $('confirm-delete-yes').addEventListener('click', confirmDelete);
  $('confirm-delete-no').addEventListener('click', cancelDelete);

  $('search-button').addEventListener('click', () => runSearch());
  $('load-more').addEventListener('click', () => runSearch({ append: true }));
  $('refresh-index').addEventListener('click', refreshIndexFromButton);
  for (const id of ['search-terms', 'search-tags']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSearch();
      }
    });
  }

  $('bookmark-tags').addEventListener('input', showTagSuggestions);
  $('bookmark-tags').addEventListener('keydown', (event) => {
    const list = $('tag-suggestions');
    if (!list || list.hidden) {
      return;
    }

    const items = list.querySelectorAll('li');
    if (!items.length) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightTag(state.tagIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightTag(state.tagIndex - 1);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      if (state.tagIndex >= 0) {
        event.preventDefault();
        insertTag(items[state.tagIndex].dataset.tag);
      }
    } else if (event.key === 'Escape') {
      hideTagSuggestions();
    }
  });
  $('bookmark-tags').addEventListener('blur', () => {
    window.setTimeout(hideTagSuggestions, 150);
  });
}

function applyMainTab() {
  activateTab(state.settings.searchMainTab ? 'search' : 'add');
}

init()
  .then(applyMainTab)
  .catch((error) => notify(formatError(error, t), 'error'));

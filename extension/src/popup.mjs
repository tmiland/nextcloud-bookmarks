import { cacheKey, readCache, writeCache } from './cache.mjs';
import { createFolder, fetchFolders } from './folders.mjs';
import { localizeDocument, setDocumentLanguage, t } from './i18n.mjs';
import { accountKey, buildClient, hasHostPermission, loadSettings } from './settings.mjs';
import { searchLocal } from './search.mjs';
import { BookmarkStore } from './store.mjs';
import { syncBookmarks, updateIndexAfterWrite } from './sync.mjs';
import {
  buildFolderTree,
  canonicalUrl,
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
  allFolders: [],
  pickerFolders: [],
  selectedFolderIds: new Set(),
  originalFolderIds: new Set(),
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
  editingFromSearch: false,
  formTouched: false,
  folderSelectionInitialized: false
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
    home.href = `${state.serverUrl}/index.php/apps/bookmarks/`;
  }

  if (!(await hasHostPermission(api, state.serverUrl))) {
    state.client = null;
    notify(t('accessRequired'), 'error', t('openSettings'), openOptions);
    await loadCurrentTab();
    return;
  }

  state.account = accountKey(state.serverUrl, state.settings.username);
  state.store = new BookmarkStore();
  state.lastFolderId = await loadLastFolder();
  void loadIndex();

  const [foldersEntry, tagsEntry] = await Promise.all([
    readCache(api, cacheKey('folders', state.account)),
    readCache(api, cacheKey('tags', state.account))
  ]);

  if (foldersEntry) {
    applyFolders(foldersEntry.value);
  } else {
    applyFolders([]);
  }
  void refreshFolders();

  if (tagsEntry) {
    applyTags(tagsEntry.value);
  } else {
    applyTags([]);
  }
  void refreshTags();

  void loadCurrentTab();
}

function openOptions() {
  api.runtime.openOptionsPage();
}

function lastFolderKey() {
  return `lastFolder:${state.account}`;
}

async function loadLastFolder() {
  try {
    const key = lastFolderKey();
    const result = await api.storage.local.get(key);
    const scoped = Number(result[key]);
    if (Number.isFinite(scoped)) {
      return scoped;
    }
    const legacy = await api.storage.local.get('lastFolder');
    const id = Number(legacy.lastFolder);
    return Number.isFinite(id) ? id : -1;
  } catch {
    return -1;
  }
}

function applyFolders(list) {
  state.allFolders = Array.isArray(list) ? list.slice() : [];
  state.pickerFolders = buildFolderTree(state.allFolders);
  state.folders = buildFolderTree(state.allFolders.filter((folder) => !folder.shared));
  state.folderById = new Map(state.pickerFolders.map((folder) => [folder.id, folder]));
  populateSearchFolderSelect();
  if (!state.selectedFolderIds.size) {
    if (state.currentBookmark) {
      setSelectedFolders(state.currentBookmark.folders);
    } else {
      applyDefaultFolders();
    }
  } else if (!state.folderSelectionInitialized && state.pickerFolders.length) {
    applyDefaultFolders();
  } else {
    renderFolderPicker();
    updateFolderSummary();
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

function folderLabel(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric) || numeric === -1) {
    return t('root');
  }
  return state.folderById.get(numeric)?.title ?? t('folderFallback', [numeric]);
}

function folderNoteFromSelection() {
  const ids = [...state.selectedFolderIds].filter(Number.isFinite);
  const nonRoot = ids.filter((id) => id !== -1);

  if (!nonRoot.length) {
    return t('savedInRoot');
  }
  if (nonRoot.length === 1) {
    const base = t('savedInFolder', [folderLabel(nonRoot[0])]);
    return `${base}${ids.includes(-1) ? t('savedInRootAnd') : ''}`;
  }
  return t('savedInFolders', [nonRoot.length]);
}

function setSelectedFolders(ids) {
  const numeric = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
  state.selectedFolderIds = new Set(numeric.length ? numeric : [-1]);
  state.originalFolderIds = new Set(state.selectedFolderIds);
  state.folderSelectionInitialized = true;
  renderFolderPicker();
  updateFolderSummary();
  setFolderNote(folderNoteFromSelection());
}

function applyDefaultFolders() {
  const last = Number(state.lastFolderId);
  const exists = state.pickerFolders.some((folder) => Number(folder.id) === last);
  state.selectedFolderIds = new Set([exists && last !== -1 ? last : -1]);
  state.originalFolderIds = new Set(state.selectedFolderIds);
  state.folderSelectionInitialized = state.pickerFolders.length > 0;
  renderFolderPicker();
  updateFolderSummary();
  setFolderNote('');
}

function renderFolderPicker() {
  const container = $('folder-options');
  if (!container) {
    return;
  }

  container.replaceChildren();

  const addRow = (id, title, depth, shared = false, unavailable = false) => {
    const label = document.createElement('label');
    label.className = 'folder-option';
    label.style.paddingLeft = `${5 + depth * 12}px`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(id);
    input.checked = state.selectedFolderIds.has(Number(id));
    input.addEventListener('change', () => {
      state.formTouched = true;
      state.folderSelectionInitialized = true;
      if (input.checked) {
        state.selectedFolderIds.add(Number(id));
      } else {
        state.selectedFolderIds.delete(Number(id));
      }
      updateFolderSummary();
      if (state.currentBookmark) {
        setFolderNote(folderNoteFromSelection());
      }
    });

    const text = document.createElement('span');
    text.textContent = title;
    label.append(input, text);

    if (shared) {
      const badge = document.createElement('span');
      badge.className = 'folder-shared';
      badge.textContent = t('sharedFolder');
      label.append(badge);
    }
    if (unavailable) {
      label.classList.add('is-unavailable');
    }

    container.append(label);
  };

  addRow(-1, t('rootNoFolder'), 0);
  for (const folder of state.pickerFolders) {
    addRow(folder.id, folder.title, folder.depth, folder.shared);
  }
  for (const id of state.selectedFolderIds) {
    if (id === -1 || state.folderById.has(id)) {
      continue;
    }
    addRow(id, t('folderUnavailableLabel', [id]), 0, false, true);
  }
}

function updateFolderSummary() {
  const summary = $('folder-summary');
  if (!summary) {
    return;
  }

  const ids = [...state.selectedFolderIds];
  const nonRoot = ids.filter((id) => id !== -1);

  if (!nonRoot.length) {
    summary.textContent = t('rootNoFolder');
  } else if (nonRoot.length === 1) {
    const label = folderLabel(nonRoot[0]);
    summary.textContent = ids.includes(-1) ? t('withRoot', [label]) : label;
  } else {
    summary.textContent = t('folderCount', [nonRoot.length]);
  }
}

function folderSelectionChanged() {
  if (state.selectedFolderIds.size !== state.originalFolderIds.size) {
    return true;
  }
  for (const id of state.selectedFolderIds) {
    if (!state.originalFolderIds.has(id)) {
      return true;
    }
  }
  return false;
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
    state.indexSyncedAt = result.skipped ? 0 : result.syncedAt;
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
  state.formTouched = false;
  setPageContext(tab.url);
  resetAddForm(tab.url, tab.title);

  if (!state.client) {
    return;
  }

  let bookmark = null;
  try {
    bookmark = await state.client.findCurrentBookmark(tab.url);
  } catch {
    bookmark = null;
  }

  if (state.formTouched) {
    return;
  }

  if (bookmark) {
    populateAddForm(bookmark, tab.url, tab.title);
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
  setSelectedFolders(bookmark.folders);
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

  applyDefaultFolders();
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

  const rawUrl = canonicalUrl($('bookmark-url').value);
  if (!rawUrl) {
    notify(t('urlEmpty'), 'error');
    return;
  }

  const id = $('bookmark-id').value;
  const selectedIds = [...state.selectedFolderIds].filter(Number.isFinite);
  const normalizedIds = selectedIds.length ? selectedIds : [-1];
  let folders;

  if (!id) {
    folders = normalizedIds.length === 1 && normalizedIds[0] === -1 ? [] : normalizedIds;
  } else if (folderSelectionChanged()) {
    folders = normalizedIds;
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

    if (Array.isArray(bookmark.folders) && bookmark.folders.length) {
      state.selectedFolderIds = new Set(bookmark.folders.map(Number).filter(Number.isFinite));
      state.originalFolderIds = new Set(state.selectedFolderIds);
      renderFolderPicker();
      updateFolderSummary();
    }
    setFolderNote(folderNoteFromSelection());

    const nonRoot = [...state.selectedFolderIds].filter((folderId) => folderId !== -1);
    state.lastFolderId = nonRoot.length === 1 ? nonRoot[0] : (nonRoot.length === 0 ? -1 : state.lastFolderId);
    api.storage.local.set({ [lastFolderKey()]: state.lastFolderId }).catch(() => {});

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
    if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
      if (!append) {
        target.replaceChildren(createMessage(formatError(error, t)));
      }
      setLoadMore(false);
      return;
    }
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

  const actions = document.createElement('div');
  actions.className = 'result-actions';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'result-edit';
  edit.textContent = t('editButton');
  edit.addEventListener('click', () => editResult(bookmark));
  actions.append(edit);

  const open = document.createElement('a');
  open.className = 'result-open';
  open.textContent = t('openInNextcloud');
  open.href = `${state.serverUrl}/index.php/apps/bookmarks/bookmarks/${encodeURIComponent(bookmark.id)}`;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  actions.append(open);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'result-delete';
  remove.textContent = t('deleteButton');
  remove.addEventListener('click', () => requestDelete(bookmark.id));
  actions.append(remove);

  card.append(meta, actions);
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

function toggleFolderCreate(show) {
  const row = $('folder-create');
  if (!row) {
    return;
  }
  setVisible(row, show);
  if (show) {
    populateNewFolderParentSelect();
    $('new-folder-title').focus();
  } else {
    $('new-folder-title').value = '';
  }
}

function populateNewFolderParentSelect() {
  const select = $('new-folder-parent');
  if (!select) {
    return;
  }

  const previous = select.value;
  select.replaceChildren(new Option(t('rootNoFolder'), '-1'));
  for (const folder of state.folders) {
    const indent = '\u00a0\u00a0'.repeat(folder.depth);
    select.append(new Option(`${indent}${folder.title}`, String(folder.id)));
  }

  const selectedNonRoot = [...state.selectedFolderIds].filter((id) => id !== -1);
  const fallback = selectedNonRoot.length === 1 ? String(selectedNonRoot[0]) : '-1';
  select.value = Array.from(select.options).some((option) => option.value === previous)
    ? previous
    : fallback;
}

async function createFolderFromPopup() {
  if (!state.client) {
    notify(t('setServerUrl'), 'error', t('openSettings'), openOptions);
    return;
  }

  const title = $('new-folder-title').value.trim();
  if (!title) {
    notify(t('folderNameRequired'), 'error');
    return;
  }

  const parentValue = Number($('new-folder-parent').value);
  const parent = Number.isFinite(parentValue) ? parentValue : -1;

  try {
    const created = await createFolder(state.client, title, parent);
    state.allFolders = [...state.allFolders, created];
    state.pickerFolders = buildFolderTree(state.allFolders);
    state.folders = buildFolderTree(state.allFolders.filter((folder) => !folder.shared));
    state.folderById = new Map(state.pickerFolders.map((folder) => [folder.id, folder]));
    state.selectedFolderIds.add(Number(created.id));
    renderFolderPicker();
    populateSearchFolderSelect();
    updateFolderSummary();
    if (state.currentBookmark) {
      setFolderNote(folderNoteFromSelection());
    }
    if (state.account) {
      try {
        await writeCache(api, cacheKey('folders', state.account), state.allFolders);
      } catch {
        // The folder exists on the server; the cache will refresh later.
      }
    }
    toggleFolderCreate(false);
    notify(t('folderCreated'), 'success');
  } catch (error) {
    notify(formatError(error, t), 'error');
  }
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
  $('new-folder').addEventListener('click', () => toggleFolderCreate($('folder-create').hidden));
  $('cancel-folder').addEventListener('click', () => toggleFolderCreate(false));
  $('create-folder').addEventListener('click', createFolderFromPopup);
  $('new-folder-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createFolderFromPopup();
    }
  });
  $('refresh-index').addEventListener('click', refreshIndexFromButton);
  for (const id of ['search-terms', 'search-tags']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSearch();
      }
    });
  }

  for (const id of ['bookmark-title', 'bookmark-tags', 'bookmark-description']) {
    $(id).addEventListener('input', () => {
      state.formTouched = true;
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

export { state };

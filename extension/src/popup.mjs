import { NextcloudClient } from './api.mjs';
import { localizeDocument, setDocumentLanguage, t } from './i18n.mjs';
import {
  buildFolderTree,
  formatDate,
  formatError,
  isSupportedUrl,
  joinTags,
  normalizeServerUrl,
  originPattern,
  parseTags
} from './utils.mjs';

const api = globalThis.browser ?? globalThis.chrome;

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
  currentTab: { url: '', title: '' }
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
    state.serverUrl = normalizeServerUrl(state.settings.serverUrl);
  } catch (error) {
    notify(error.message, 'error', t('openSettings'), openOptions);
    await loadCurrentTab();
    return;
  }

  state.client = new NextcloudClient({
    serverUrl: state.serverUrl,
    username: state.settings.username,
    password: state.settings.password
  });

  const home = $('open-bookmarks');
  if (home) {
    home.href = `${state.serverUrl}/apps/bookmarks/`;
  }

  if (!(await hasHostPermission())) {
    notify(t('accessRequired'), 'error', t('openSettings'), openOptions);
    await loadCurrentTab();
    return;
  }

  await Promise.allSettled([loadFolders(), loadTags()]);
  await loadCurrentTab();
}

async function loadSettings() {
  try {
    const result = await api.storage.local.get('settings');
    return normalizeSettings(result.settings || {});
  } catch {
    return normalizeSettings({});
  }
}

function normalizeSettings(raw) {
  return {
    serverUrl: String(raw.serverUrl ?? ''),
    username: String(raw.username ?? ''),
    password: String(raw.password ?? ''),
    searchMainTab: Boolean(raw.searchMainTab)
  };
}

function openOptions() {
  api.runtime.openOptionsPage();
}

async function hasHostPermission() {
  if (!state.serverUrl) {
    return false;
  }

  try {
    return await api.permissions.contains({ origins: [originPattern(state.serverUrl)] });
  } catch {
    return false;
  }
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

async function loadFolders() {
  if (!state.client) {
    return;
  }

  let list = [];
  try {
    const result = await state.client.getFolders();
    list = Array.isArray(result?.data) ? result.data : [];
  } catch {
    list = [];
  }

  const username = String(state.settings.username ?? '').toLowerCase();
  const own = list.filter((folder) => {
    if (!folder.userId || !username) {
      return true;
    }
    return String(folder.userId).toLowerCase() === username;
  });

  state.folders = buildFolderTree(own);
  state.folderById = new Map(state.folders.map((folder) => [folder.id, folder]));
  state.lastFolderId = await loadLastFolder();
  populateFolderSelect();
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

async function loadTags() {
  if (!state.client) {
    return;
  }

  try {
    const result = await state.client.getTags();
    const list = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
    state.knownTags = list
      .map((item) => (typeof item === 'string' ? item : item?.name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch {
    state.knownTags = [];
  }
}

async function loadCurrentTab() {
  const tab = await getCurrentTab();
  if (!tab) {
    return;
  }

  state.currentTab = tab;
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

    notify(id ? t('bookmarkUpdated') : t('bookmarkSaved'), 'success');
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

async function runSearch() {
  if (!state.client) {
    notify(t('setServerUrl'), 'error', t('openSettings'), openOptions);
    return;
  }

  const terms = parseTags($('search-terms').value);
  const tags = parseTags($('search-tags').value);
  const conjunction = $('search-conjunction').value;
  const page = $('search-no-paging').checked ? -1 : 0;

  await searchInto({
    terms,
    tags,
    conjunction,
    page,
    target: $('search-results')
  });
}


async function searchInto({ terms, tags, conjunction, page, target, emptyMessage }) {
  target.replaceChildren();
  target.append(createMessage(t('searching')));

  try {
    const result = await state.client.getBookmarks({ terms, tags, conjunction, page, limit: 30 });
    if (result?.status === 'error') {
      target.replaceChildren(createMessage(result.message || t('serverError')));
      return;
    }

    renderResults(target, result?.data ?? [], emptyMessage);
  } catch (error) {
    target.replaceChildren(createMessage(formatError(error, t)));
  }
}

function createMessage(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function renderResults(container, bookmarks, emptyMessage) {
  container.replaceChildren();

  if (!bookmarks.length) {
    container.append(createMessage(emptyMessage || t('noBookmarksFound')));
    return;
  }

  const heading = document.createElement('p');
  heading.className = 'results-heading';
  heading.textContent = bookmarks.length === 1 ? t('bookmarkCountOne') : t('bookmarkCountMany', [bookmarks.length]);
  container.append(heading);

  for (const bookmark of bookmarks) {
    container.append(renderResult(bookmark));
  }
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

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'result-delete';
  remove.textContent = t('deleteButton');
  remove.addEventListener('click', () => requestDelete(bookmark.id));
  meta.append(remove);

  card.append(meta);
  return card;
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

  $('search-button').addEventListener('click', runSearch);
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

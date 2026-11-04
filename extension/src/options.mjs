import { fetchFolders } from './folders.mjs';
import { localizeDocument, setDocumentLanguage, t } from './i18n.mjs';
import {
  buildClient,
  hasHostPermission,
  loadSettings as loadStoredSettings,
  normalizeSettings,
  requestHostPermission,
  saveSettings as persistSettings
} from './settings.mjs';
import {
  buildFolderTree,
  formatError,
  isSupportedUrl,
  normalizeUrlForCompare
} from './utils.mjs';

const api = globalThis.browser ?? globalThis.chrome;

const state = {
  settings: {},
  client: null,
  importPreview: null,
  cancelled: false
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

async function init() {
  setDocumentLanguage();
  localizeDocument();
  bindEvents();
  updateVersion();
  state.settings = await loadStoredSettings();
  renderSettings();
  await refreshPermission();
  await initImport();
}

function bindEvents() {
  $('settings-form').addEventListener('submit', (event) => event.preventDefault());
  $('save-settings').addEventListener('click', saveSettings);
  $('grant-host').addEventListener('click', grantHostPermission);
  $('grant-bookmarks').addEventListener('click', grantBookmarksPermission);
  $('preview-import').addEventListener('click', previewImport);
  $('start-import').addEventListener('click', startImport);
  $('cancel-import').addEventListener('click', () => {
    state.cancelled = true;
    setImportStatus(t('cancelling'));
  });
  $('firefox-folder').addEventListener('change', () => {
    state.importPreview = null;
    $('start-import').disabled = true;
    setImportStatus(t('chooseFirefoxFolder'));
  });
}

function renderSettings() {
  $('server-url').value = state.settings.serverUrl;
  $('username').value = state.settings.username;
  $('password').value = state.settings.password;
  $('main-tab').value = state.settings.searchMainTab ? 'search' : 'add';

  if (state.settings.serverUrl) {
    try {
      state.client = buildClient(state.settings);
    } catch {
      state.client = null;
    }
  }

  updateSidebar();
}

function updateSidebar() {
  const target = $('side-server');
  if (!target) {
    return;
  }

  if (!state.settings.serverUrl) {
    target.textContent = t('notConfigured');
    return;
  }

  try {
    target.textContent = new URL(buildClient(state.settings).serverUrl).host;
  } catch {
    target.textContent = t('invalidServerUrl');
  }
}

function updateVersion() {
  const target = $('extension-version');
  if (target) {
    target.textContent = `v${api.runtime.getManifest().version}`;
  }
}

async function saveSettings() {
  let client;
  try {
    client = buildClient({
      serverUrl: $('server-url').value,
      username: $('username').value.trim(),
      password: $('password').value
    });
  } catch (error) {
    notify(error.message, 'error');
    return;
  }

  const serverUrl = client.serverUrl;
  if (!serverUrl) {
    notify(t('enterServerUrl'), 'error');
    return;
  }

  const granted = await requestHostPermission(api, serverUrl);

  const settings = normalizeSettings({
    serverUrl,
    username: $('username').value.trim(),
    password: $('password').value,
    searchMainTab: $('main-tab').value === 'search'
  });

  try {
    await persistSettings(api, settings);
  } catch {
    notify(t('couldNotSaveSettings'), 'error');
    return;
  }

  state.settings = settings;
  state.client = buildClient(settings);
  updateSidebar();

  await refreshPermission();
  await initImport();

  if (granted) {
    notify(t('settingsSaved'), 'success');
  } else {
    notify(t('settingsSavedNoAccess'), 'error');
  }
}

async function refreshPermission() {
  const box = $('permission-box');
  const text = $('permission-text');
  const button = $('grant-host');

  if (!state.settings.serverUrl) {
    setVisible(box, false);
    return;
  }

  let serverUrl;
  try {
    serverUrl = buildClient(state.settings).serverUrl;
  } catch {
    setVisible(box, false);
    return;
  }

  const granted = await hasHostPermission(api, serverUrl);

  setVisible(box, true);
  if (granted) {
    setText(text, t('accessGranted', [new URL(serverUrl).host]));
    setVisible(button, false);
  } else {
    setText(text, t('accessNeeded', [new URL(serverUrl).host]));
    setVisible(button, true);
  }
}

async function grantHostPermission() {
  if (!state.settings.serverUrl) {
    notify(t('saveServerFirst'), 'error');
    return;
  }

  let serverUrl;
  try {
    serverUrl = buildClient(state.settings).serverUrl;
  } catch {
    notify(t('invalidServerUrl'), 'error');
    return;
  }

  const granted = await requestHostPermission(api, serverUrl);
  await refreshPermission();
  await initImport();

  notify(granted ? t('serverAccessGranted') : t('serverAccessNotGranted'), granted ? 'success' : 'error');
}

async function initImport() {
  const card = $('import-card');
  if (!state.settings.serverUrl || !state.client) {
    setVisible(card, false);
    return;
  }

  setVisible(card, true);

  const hostGranted = await hasHostPermission(api, state.settings.serverUrl);

  if (!hostGranted) {
    setVisible($('import-permission'), false);
    setVisible($('import-controls'), false);
    setImportStatus(t('saveSettingsAndGrant'), 'error');
    return;
  }

  let bookmarksGranted = false;
  try {
    bookmarksGranted = await api.permissions.contains({ permissions: ['bookmarks'] });
  } catch {
    bookmarksGranted = false;
  }

  if (!bookmarksGranted) {
    setVisible($('import-permission'), true);
    setVisible($('import-controls'), false);
    setImportStatus('');
    return;
  }

  setVisible($('import-permission'), false);
  setVisible($('import-controls'), true);
  await loadImportFolders();
  setImportStatus(t('chooseFirefoxFolder'));
}

async function grantBookmarksPermission() {
  const granted = await api.permissions
    .request({ permissions: ['bookmarks'] })
    .catch(() => false);

  if (!granted) {
    setImportStatus(t('bookmarksAccessNotGranted'), 'error');
    return;
  }

  await initImport();
}

async function loadImportFolders() {
  const importFolder = $('import-folder');
  importFolder.replaceChildren(new Option(t('rootNoFolder'), '-1'));

  let hadError = false;

  try {
    const list = await fetchFolders(state.client, state.settings.username);
    const own = list.filter((folder) => !folder.shared);

    for (const folder of buildFolderTree(own)) {
      const indent = '\u00a0\u00a0'.repeat(folder.depth);
      importFolder.append(new Option(`${indent}${folder.title}`, String(folder.id)));
    }
  } catch (error) {
    hadError = true;
    setImportStatus(t('couldNotLoadFolders', [formatError(error, t)]), 'error');
  }

  try {
    const tree = await api.bookmarks.getTree();
    populateFirefoxFolders(tree);
  } catch (error) {
    hadError = true;
    setImportStatus(t('couldNotReadBookmarks', [error.message]), 'error');
  }

  if (!hadError) {
    setImportStatus(t('chooseFirefoxFolder'));
  }
}

function populateFirefoxFolders(tree) {
  const select = $('firefox-folder');
  select.replaceChildren(new Option(t('allBookmarks'), 'all'));

  function walk(nodes, depth) {
    for (const node of nodes) {
      if (node.type !== 'folder') {
        continue;
      }

      if (node.id !== 'root________') {
        const indent = '\u00a0\u00a0'.repeat(depth);
        select.append(new Option(`${indent}${node.title || t('untitledFolder')}`, node.id));
      }

      if (node.children) {
        walk(node.children, node.id === 'root________' ? 0 : depth + 1);
      }
    }
  }

  walk(tree, 0);

  const toolbar = Array.from(select.options).find((option) => option.value === 'toolbar_____');
  select.value = toolbar ? 'toolbar_____' : 'all';
}

async function collectFirefoxBookmarks(folderId) {
  const tree = folderId === 'all'
    ? await api.bookmarks.getTree()
    : await api.bookmarks.getSubTree(folderId);

  const nodes = Array.isArray(tree) ? tree : [tree];
  const items = [];
  let skipped = 0;

  function walk(children) {
    for (const node of children) {
      if (node.type === 'bookmark' && node.url) {
        if (isSupportedUrl(node.url)) {
          items.push({ url: node.url, title: node.title || node.url });
        } else {
          skipped++;
        }
      }
      if (node.children) {
        walk(node.children);
      }
    }
  }

  walk(nodes);
  return { items, skipped };
}

async function previewImport() {
  if (!state.client) {
    setImportStatus(t('saveSettingsFirst'), 'error');
    return;
  }

  try {
    const folderId = $('firefox-folder').value;
    const collected = await collectFirefoxBookmarks(folderId);
    const existing = await state.client.getExistingUrlSet();

    const newItems = [];
    let duplicates = 0;
    for (const item of collected.items) {
      if (existing.has(normalizeUrlForCompare(item.url))) {
        duplicates++;
      } else {
        newItems.push(item);
      }
    }

    state.importPreview = { items: newItems };
    $('start-import').disabled = newItems.length === 0;

    const total = newItems.length + duplicates + collected.skipped;
    setImportStatus(
      t('previewFound', [total, newItems.length, duplicates, collected.skipped]),
      newItems.length ? '' : 'error'
    );
  } catch (error) {
    state.importPreview = null;
    $('start-import').disabled = true;
    setImportStatus(t('previewFailed', [formatError(error, t)]), 'error');
  }
}

async function startImport() {
  if (!state.client || !state.importPreview?.items.length) {
    return;
  }

  const items = state.importPreview.items;
  const folderValue = $('import-folder').value;
  const folders = folderValue === '-1' ? [] : [Number(folderValue)];
  const progress = $('import-progress');
  const startButton = $('start-import');
  const previewButton = $('preview-import');
  const cancelButton = $('cancel-import');
  const firefoxSelect = $('firefox-folder');
  const importSelect = $('import-folder');

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  state.cancelled = false;
  startButton.disabled = true;
  previewButton.disabled = true;
  cancelButton.hidden = false;
  firefoxSelect.disabled = true;
  importSelect.disabled = true;
  progress.hidden = false;
  progress.max = items.length;
  progress.value = 0;

  for (let index = 0; index < items.length; index++) {
    if (state.cancelled) {
      break;
    }

    try {
      await state.client.createBookmark({
        url: items[index].url,
        title: items[index].title,
        description: '',
        tags: [],
        folders
      });
      created++;
    } catch (error) {
      const detail = error.data?.data ?? error.data?.message;
      const text = Array.isArray(detail) ? detail.join(' ') : String(detail ?? '');
      if (/already exists|exists/i.test(text)) {
        skipped++;
      } else {
        failed++;
        if (errors.length < 3) {
          errors.push(formatError(error, t));
        }
      }
    }

    progress.value = index + 1;
    setImportStatus(t('importingProgress', [index + 1, items.length]));
    await new Promise((resolve) => window.setTimeout(resolve, 75));
  }

  cancelButton.hidden = true;
  previewButton.disabled = false;
  startButton.disabled = true;
  firefoxSelect.disabled = false;
  importSelect.disabled = false;
  state.importPreview = null;

  let summary = `${state.cancelled ? t('importCancelled') : ''}${t('importSummary', [created, skipped, failed])}`;
  if (errors.length) {
    summary += ` ${errors.join(' ')}`;
  }

  setImportStatus(summary, failed ? 'error' : 'success');
}

function setImportStatus(message, type = '') {
  const status = $('import-status');
  status.textContent = message ?? '';
  status.className = 'import-status';
  if (type) {
    status.classList.add(`is-${type}`);
  }
}

function notify(message, type = 'info') {
  const box = $('settings-notification');
  box.textContent = message ?? '';
  box.className = 'notification';
  if (type === 'error') {
    box.classList.add('is-error');
  }
  if (type === 'success') {
    box.classList.add('is-success');
  }
  box.hidden = false;

  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => {
    box.hidden = true;
  }, 5000);
}

init().catch((error) => {
  notify(formatError(error, t), 'error');
});

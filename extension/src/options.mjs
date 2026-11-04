import { cacheKey, writeCache } from './cache.mjs';
import { createFolder, fetchFolders, renameFolder } from './folders.mjs';
import {
  clearImportJob,
  countMissingFolders,
  dedupeImportItems,
  ensureImportFolders,
  loadImportJob,
  planImport,
  runImport,
  saveImportJob
} from './import.mjs';
import { localizeDocument, setDocumentLanguage, t } from './i18n.mjs';
import {
  accountKey,
  buildClient,
  hasHostPermission,
  loadSettings as loadStoredSettings,
  normalizeSettings,
  requestHostPermission,
  saveSettings as persistSettings
} from './settings.mjs';
import {
  buildFolderTree,
  formatError
} from './utils.mjs';

const api = globalThis.browser ?? globalThis.chrome;

const state = {
  settings: {},
  client: null,
  importPreview: null,
  cancelled: false,
  account: '',
  folders: [],
  allFolders: [],
  renamingFolderId: null,
  importJob: null,
  importRunning: false,
  foldersLoaded: false
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
  await initFolders();
  await initImport();
}

function bindEvents() {
  $('settings-form').addEventListener('submit', (event) => event.preventDefault());
  $('save-settings').addEventListener('click', saveSettings);
  $('grant-host').addEventListener('click', grantHostPermission);
  $('grant-bookmarks').addEventListener('click', grantBookmarksPermission);
  $('create-folder-options').addEventListener('click', createFolderFromOptions);
  $('new-folder-options-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createFolderFromOptions();
    }
  });
  $('preview-import').addEventListener('click', previewImport);
  $('start-import').addEventListener('click', startImport);
  $('cancel-import').addEventListener('click', () => {
    state.cancelled = true;
    setImportStatus(t('cancelling'));
  });
  $('resume-import').addEventListener('click', resumeImportJob);
  $('discard-import').addEventListener('click', discardImportJob);
  $('firefox-folder').addEventListener('change', () => {
    invalidateImportPreview();
    setImportStatus(t('chooseFirefoxFolder'));
  });
  $('import-recreate-folders').addEventListener('change', () => {
    invalidateImportPreview();
    setImportStatus(t('chooseFirefoxFolder'));
  });
  $('import-folder').addEventListener('change', () => {
    invalidateImportPreview();
    setImportStatus(t('chooseFirefoxFolder'));
  });
}

function renderSettings() {
  state.account = accountKey(state.settings.serverUrl, state.settings.username);
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
  await initFolders();
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
  await initFolders();
  await initImport();

  notify(granted ? t('serverAccessGranted') : t('serverAccessNotGranted'), granted ? 'success' : 'error');
}

async function initFolders() {
  const card = $('folders-card');
  if (!card) {
    return;
  }

  if (!state.settings.serverUrl || !state.client) {
    setVisible(card, false);
    return;
  }

  const granted = await hasHostPermission(api, state.settings.serverUrl);
  if (!granted) {
    setVisible(card, false);
    return;
  }

  setVisible(card, true);
  await loadFoldersForOptions();
}

async function loadFoldersForOptions() {
  try {
    const list = await fetchFolders(state.client, state.settings.username);
    state.allFolders = list;
    state.folders = list.filter((folder) => !folder.shared);
    renderFolderList();
    populateOptionsParentSelect();
    if (state.account) {
      try {
        await writeCache(api, cacheKey('folders', state.account), list);
      } catch {
        // The list is still usable; the popup will refresh its cache later.
      }
    }
  } catch (error) {
    notify(formatError(error, t), 'error');
  }
}

function renderFolderList() {
  const container = $('folder-list');
  if (!container) {
    return;
  }

  container.replaceChildren();
  const tree = buildFolderTree(state.folders);
  if (!tree.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('noFolders');
    container.append(empty);
    return;
  }

  for (const folder of tree) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.style.paddingLeft = `${8 + folder.depth * 16}px`;

    if (state.renamingFolderId === folder.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = folder.title;
      input.id = `rename-folder-${folder.id}`;

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'button button-primary button-small';
      save.textContent = t('save');
      save.addEventListener('click', () => commitRename(folder, input.value));

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button button-quiet button-small';
      cancel.textContent = t('cancel');
      cancel.addEventListener('click', () => {
        state.renamingFolderId = null;
        renderFolderList();
      });

      row.append(input, save, cancel);
    } else {
      const name = document.createElement('span');
      name.textContent = folder.title;

      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'button button-quiet button-small';
      rename.textContent = t('renameFolder');
      rename.addEventListener('click', () => {
        state.renamingFolderId = folder.id;
        renderFolderList();
      });

      row.append(name, rename);
    }

    container.append(row);
  }
}

function populateOptionsParentSelect() {
  const select = $('new-folder-options-parent');
  if (!select) {
    return;
  }

  const previous = select.value;
  select.replaceChildren(new Option(t('rootNoFolder'), '-1'));
  for (const folder of buildFolderTree(state.folders)) {
    const indent = '\u00a0\u00a0'.repeat(folder.depth);
    select.append(new Option(`${indent}${folder.title}`, String(folder.id)));
  }
  select.value = Array.from(select.options).some((option) => option.value === previous)
    ? previous
    : '-1';
}

async function commitRename(folder, title) {
  const value = String(title ?? '').trim();
  if (!value) {
    notify(t('folderNameRequired'), 'error');
    return;
  }

  try {
    await renameFolder(state.client, folder.id, value, folder.parentFolder ?? -1);
    state.renamingFolderId = null;
    await loadFoldersForOptions();
    await loadImportFolders();
    notify(t('folderRenamed'), 'success');
  } catch (error) {
    notify(formatError(error, t), 'error');
  }
}

async function createFolderFromOptions() {
  if (!state.client) {
    notify(t('saveSettingsFirst'), 'error');
    return;
  }

  const input = $('new-folder-options-title');
  const title = input.value.trim();
  if (!title) {
    notify(t('folderNameRequired'), 'error');
    return;
  }

  const parentValue = Number($('new-folder-options-parent').value);
  const parent = Number.isFinite(parentValue) ? parentValue : -1;

  try {
    await createFolder(state.client, title, parent);
    input.value = '';
    await loadFoldersForOptions();
    await loadImportFolders();
    notify(t('folderCreated'), 'success');
  } catch (error) {
    notify(formatError(error, t), 'error');
  }
}

function invalidateImportPreview() {
  state.importPreview = null;
  const start = $('start-import');
  if (start) {
    start.disabled = true;
  }
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
  await refreshImportJob();
  if (state.foldersLoaded) {
    setImportStatus(t('chooseFirefoxFolder'));
  }
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
  state.foldersLoaded = false;
  invalidateImportPreview();

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
    state.foldersLoaded = true;
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

async function getFirefoxTree(folderId) {
  const tree = folderId === 'all'
    ? await api.bookmarks.getTree()
    : await api.bookmarks.getSubTree(folderId);
  return Array.isArray(tree) ? tree : [tree];
}

function importAccount() {
  return accountKey(state.settings.serverUrl, state.settings.username);
}

async function refreshImportJob() {
  if (!state.settings.serverUrl) {
    state.importJob = null;
    renderImportJob(null);
    return;
  }

  const job = await loadImportJob(api, importAccount());
  state.importJob = job;
  renderImportJob(job);
}

function renderImportJob(job) {
  const box = $('import-job');
  if (!box) {
    return;
  }

  if (state.importRunning || !job || !Array.isArray(job.items)) {
    setVisible(box, false);
    return;
  }

  const done = new Set(job.completed || []);
  const remaining = job.items.length - done.size;
  if (remaining <= 0) {
    setVisible(box, false);
    return;
  }

  setVisible(box, true);
  setText($('import-job-text'), t('importJobPending', [remaining, job.items.length]));
}

async function previewImport() {
  if (!state.client) {
    setImportStatus(t('saveSettingsFirst'), 'error');
    return;
  }

  if (!state.foldersLoaded) {
    setImportStatus(t('foldersUnavailable'), 'error');
    return;
  }

  try {
    const folderId = $('firefox-folder').value;
    const destinationId = Number($('import-folder').value);
    const recreateFolders = $('import-recreate-folders').checked;
    const firefoxTree = await getFirefoxTree(folderId);
    const plan = planImport({
      firefoxTree,
      selectedFolderId: folderId,
      destinationId,
      recreateFolders,
      existingFolders: state.folders
    });
    const existing = await state.client.getExistingUrlSet();

    const deduped = dedupeImportItems(plan.items, existing);
    const newItems = deduped.items;
    const duplicates = deduped.duplicates;

    const missingFolders = recreateFolders
      ? countMissingFolders(state.folders, plan.folderPlans, destinationId)
      : 0;

    state.importPreview = {
      items: newItems,
      folderPlans: plan.folderPlans,
      destinationId,
      recreateFolders,
      missingFolders
    };
    $('start-import').disabled = newItems.length === 0;

    const total = plan.items.length + plan.skipped;
    let status = t('previewFound', [total, newItems.length, duplicates, plan.skipped]);
    if (recreateFolders) {
      status += ` ${t('previewFolders', [missingFolders])}`;
    }
    setImportStatus(status, newItems.length ? '' : 'error');
  } catch (error) {
    state.importPreview = null;
    $('start-import').disabled = true;
    setImportStatus(t('previewFailed', [formatError(error, t)]), 'error');
  }
}

function setImportBusy(busy) {
  state.importRunning = busy;
  $('start-import').disabled = busy || !state.importPreview?.items.length;
  $('preview-import').disabled = busy;
  $('cancel-import').hidden = !busy;
  $('resume-import').disabled = busy;
  $('discard-import').disabled = busy;
  $('firefox-folder').disabled = busy;
  $('import-folder').disabled = busy;
  $('import-recreate-folders').disabled = busy;
  if (busy) {
    setVisible($('import-job'), false);
  }
}

async function startImport() {
  if (state.importRunning) {
    return;
  }
  if (state.importJob) {
    setImportStatus(t('importJobExists'), 'error');
    return;
  }
  if (!state.client || !state.importPreview?.items.length) {
    return;
  }
  if (!state.foldersLoaded) {
    setImportStatus(t('foldersUnavailable'), 'error');
    return;
  }

  const destinationId = Number($('import-folder').value);
  if (destinationId !== state.importPreview.destinationId) {
    invalidateImportPreview();
    setImportStatus(t('previewStale'), 'error');
    return;
  }

  const preview = state.importPreview;
  state.importPreview = null;
  const job = {
    account: importAccount(),
    items: preview.items,
    folderPlans: preview.folderPlans,
    destinationId: preview.destinationId,
    recreateFolders: preview.recreateFolders,
    folderIds: {},
    completed: [],
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    createdFolders: preview.missingFolders || 0,
    createdAt: Date.now()
  };
  await runImportJob(job);
}

async function runImportJob(job) {
  const progress = $('import-progress');

  state.cancelled = false;
  setImportBusy(true);
  progress.hidden = false;
  progress.max = job.items.length;
  progress.value = (job.completed || []).length;

  try {
    await saveImportJob(api, job);
  } catch {
    // The import can still run; resume is best effort.
  }
  state.importJob = job;
  renderImportJob(job);

  let ensured;
  try {
    ensured = await ensureImportFolders({
      client: state.client,
      folders: state.folders,
      plans: job.folderPlans || [],
      destinationId: job.destinationId ?? -1
    });
  } catch (error) {
    setImportStatus(formatError(error, t), 'error');
    setImportBusy(false);
    if (state.importJob) {
      renderImportJob(state.importJob);
    }
    return;
  }

  state.folders = ensured.folders;
  job.folderIds = Object.fromEntries(ensured.folderIds);
  try {
    await saveImportJob(api, job);
  } catch {
    // Resume will re-create only missing folders.
  }

  let lastSave = 0;
  const result = await runImport({
    client: state.client,
    job,
    concurrency: 5,
    shouldCancel: () => state.cancelled,
    onProgress: (current) => {
      progress.value = current.completed.length;
      setImportStatus(t('importingProgress', [current.completed.length, current.items.length]));
      const now = Date.now();
      if (now - lastSave > 250) {
        lastSave = now;
        void saveImportJob(api, current);
      }
    }
  });

  progress.value = job.items.length;

  if (result.remaining === 0) {
    try {
      await clearImportJob(api, importAccount());
    } catch {
      // A stale completed job is harmless.
    }
    state.importJob = null;
    renderImportJob(null);
  } else {
    try {
      await saveImportJob(api, job);
    } catch {
      // The in-memory job still lets the user resume this session.
    }
    state.importJob = job;
    renderImportJob(job);
  }

  setImportBusy(false);
  if (state.importJob) {
    renderImportJob(state.importJob);
  }

  let summary = `${result.cancelled ? t('importCancelled') : ''}${t('importSummary', [result.created, result.skipped, result.failed])}`;
  if (job.createdFolders) {
    summary = `${t('importFoldersCreated', [job.createdFolders])} ${summary}`;
  }
  if (result.errors?.length) {
    summary += ` ${result.errors.join(' ')}`;
  }
  if (result.remaining > 0) {
    summary += ` ${t('importCancelledResume')}`;
  }

  setImportStatus(summary, result.failed || result.remaining > 0 ? 'error' : 'success');
}

async function resumeImportJob() {
  if (state.importRunning || !state.importJob) {
    return;
  }
  setImportStatus(t('importResumed'));
  await runImportJob(state.importJob);
}

async function discardImportJob() {
  if (state.importRunning) {
    return;
  }
  await clearImportJob(api, importAccount());
  state.importJob = null;
  renderImportJob(null);
  setImportStatus(t('importJobDiscarded'));
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

import { buildClient, hasHostPermission, loadSettings } from './settings.mjs';
import { quickSavePlan } from './quick-save.mjs';
import { t } from './i18n.mjs';
import { formatError } from './utils.mjs';

const api = globalThis.browser ?? globalThis.chrome;
const menus = api.menus ?? api.contextMenus;
const MENU_QUICK_SAVE = 'quick-save';
const MENU_OPEN_POPUP = 'open-popup';
let badgeTimer = null;

async function setupMenus() {
  try {
    await menus.removeAll();
    menus.create({
      id: MENU_QUICK_SAVE,
      title: t('menuQuickSave'),
      contexts: ['page']
    });
    menus.create({
      id: MENU_OPEN_POPUP,
      title: t('menuOpenPopup'),
      contexts: ['page']
    });
  } catch {
    // Menus are best effort; the command still works.
  }
}

function setBadge(text, color) {
  try {
    api.action.setBadgeBackgroundColor({ color });
    api.action.setBadgeText({ text });
    api.action.setBadgeTextColor?.({ color: '#ffffff' });
  } catch {
    // Badge support is optional.
  }
  window.clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => {
    try {
      api.action.setBadgeText({ text: '' });
    } catch {
      // Ignore.
    }
  }, 4000);
}

async function readLastFolder() {
  try {
    const result = await api.storage.local.get('lastFolder');
    const folder = Number(result?.lastFolder);
    return Number.isFinite(folder) ? folder : -1;
  } catch {
    return -1;
  }
}

async function notify(message) {
  try {
    await api.notifications.create({
      type: 'basic',
      title: t('appName'),
      message,
      iconUrl: api.runtime.getURL('icons/icon-96.png')
    });
  } catch {
    // Notification support is optional.
  }
}

async function updateIndex(bookmark) {
  try {
    const { BookmarkStore } = await import('./store.mjs');
    const settings = await loadSettings(api);
    const { accountKey } = await import('./settings.mjs');
    const store = new BookmarkStore();
    await store.upsert(accountKey(settings.serverUrl, settings.username), bookmark);
  } catch {
    // The index arrives in a later task and is optional for quick save.
  }
}

async function removeFromIndex(id) {
  try {
    const { BookmarkStore } = await import('./store.mjs');
    const settings = await loadSettings(api);
    const { accountKey } = await import('./settings.mjs');
    const store = new BookmarkStore();
    await store.remove(accountKey(settings.serverUrl, settings.username), id);
  } catch {
    // Ignore index failures.
  }
}

function injectToast({ message, undoLabel, closeLabel, undoneMessage, failedMessage, bookmarkId }) {
  const previous = document.getElementById('nextcloud-bookmarks-toast');
  if (previous) {
    previous.remove();
  }

  const host = document.createElement('div');
  host.id = 'nextcloud-bookmarks-toast';
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .toast {
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 420px;
      padding: 12px 14px;
      border-radius: 10px;
      background: #1c1b22;
      color: #fbfbfe;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .toast span { flex: 1; }
    button {
      border: 0;
      border-radius: 6px;
      padding: 4px 8px;
      font: inherit;
      cursor: pointer;
    }
    .undo { background: #0060df; color: #fff; }
    .close { background: transparent; color: #cfcfd8; font-size: 16px; }
    button:disabled { opacity: .6; cursor: default; }
  `;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const text = document.createElement('span');
  text.textContent = message;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'undo';
  undo.textContent = undoLabel;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '×';
  close.title = closeLabel;
  close.setAttribute('aria-label', closeLabel);

  const remove = () => host.remove();
  close.addEventListener('click', remove);
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    try {
      const response = await browser.runtime.sendMessage({ type: 'undo-quick-save', id: bookmarkId });
      text.textContent = response?.ok ? undoneMessage : failedMessage;
      undo.remove();
      window.setTimeout(remove, 2500);
    } catch {
      text.textContent = failedMessage;
      undo.remove();
      window.setTimeout(remove, 2500);
    }
  });

  toast.append(text, undo, close);
  shadow.append(style, toast);
  document.documentElement.append(host);
  window.setTimeout(remove, 8000);
}

async function showToast(tabId, payload) {
  if (!tabId) {
    return false;
  }
  try {
    await api.scripting.executeScript({
      target: { tabId },
      func: injectToast,
      args: [payload]
    });
    return true;
  } catch {
    return false;
  }
}

async function quickSaveForTab(tab) {
  const settings = await loadSettings(api);
  const lastFolder = await readLastFolder();
  const plan = quickSavePlan({ tab, settings, lastFolder });

  if (plan.error === 'unsupported') {
    setBadge('!', '#d70022');
    await notify(t('quickSaveUnsupported'));
    return { status: 'unsupported' };
  }

  if (plan.error === 'unconfigured') {
    await notify(t('quickSaveUnconfigured'));
    api.runtime.openOptionsPage();
    return { status: 'unconfigured' };
  }

  if (!(await hasHostPermission(api, settings.serverUrl))) {
    await notify(t('quickSaveNoAccess'));
    api.runtime.openOptionsPage();
    return { status: 'no-access' };
  }

  const client = buildClient(settings);

  try {
    const existing = await client.findCurrentBookmark(plan.url);
    if (existing) {
      setBadge('i', '#0060df');
      await notify(t('quickSaveAlreadySaved'));
      return { status: 'exists', id: existing.id };
    }

    const result = await client.createBookmark({
      url: plan.url,
      title: plan.title,
      description: '',
      tags: [],
      folders: plan.folders
    });
    const bookmark = result?.item;
    if (!bookmark?.id) {
      throw new Error(t('quickSaveFailed'));
    }

    await updateIndex(bookmark);
    setBadge('✓', '#0060df');

    const payload = {
      message: t('quickSaveSaved'),
      undoLabel: t('undo'),
      closeLabel: t('close'),
      undoneMessage: t('quickSaveUndone'),
      failedMessage: t('quickSaveUndoFailed'),
      bookmarkId: bookmark.id
    };
    const toasted = await showToast(tab?.id, payload);
    if (!toasted) {
      await notify(t('quickSaveSaved'));
    }

    return { status: 'saved', id: bookmark.id };
  } catch (error) {
    setBadge('!', '#d70022');
    await notify(formatError(error, t));
    return { status: 'error', error: formatError(error, t) };
  }
}

async function quickSaveActiveTab() {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return await quickSaveForTab(tabs?.[0]);
  } catch (error) {
    await notify(formatError(error, t));
    return { status: 'error' };
  }
}

async function undoQuickSave(id) {
  if (!id) {
    return { ok: false };
  }
  const settings = await loadSettings(api);
  if (!settings.serverUrl) {
    return { ok: false };
  }
  try {
    const client = buildClient(settings);
    await client.deleteBookmark(id);
    await removeFromIndex(id);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function openPopup() {
  try {
    await api.action.openPopup();
  } catch {
    try {
      await api.windows.create({
        url: api.runtime.getURL('popup.html'),
        type: 'popup',
        width: 420,
        height: 680
      });
    } catch {
      // Nothing else to do.
    }
  }
}

api.runtime.onInstalled.addListener(() => { void setupMenus(); });
api.runtime.onStartup.addListener(() => { void setupMenus(); });
void setupMenus();

api.commands.onCommand.addListener((command) => {
  if (command === 'save-page') {
    void quickSaveActiveTab();
  }
});

menus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_QUICK_SAVE) {
    void quickSaveForTab(tab);
  } else if (info.menuItemId === MENU_OPEN_POPUP) {
    void openPopup();
  }
});

api.runtime.onMessage.addListener((message) => {
  if (message?.type === 'undo-quick-save') {
    return undoQuickSave(message.id);
  }
  return false;
});

import { NextcloudClient } from './api.mjs';
import { normalizeServerUrl, originPattern } from './utils.mjs';

export function normalizeSettings(raw) {
  return {
    serverUrl: String(raw?.serverUrl ?? ''),
    username: String(raw?.username ?? ''),
    password: String(raw?.password ?? ''),
    searchMainTab: Boolean(raw?.searchMainTab)
  };
}

function extensionApi() {
  return globalThis.browser ?? globalThis.chrome;
}

export async function loadSettings(api = extensionApi()) {
  try {
    const result = await api.storage.local.get('settings');
    return normalizeSettings(result?.settings || {});
  } catch {
    return normalizeSettings({});
  }
}

export async function saveSettings(api, settings) {
  await api.storage.local.set({ settings: normalizeSettings(settings) });
}

export function buildClient(settings) {
  return new NextcloudClient({
    serverUrl: normalizeServerUrl(settings.serverUrl),
    username: settings.username,
    password: settings.password
  });
}

export function accountKey(serverUrl, username) {
  let normalized = String(serverUrl ?? '').trim();
  try {
    normalized = normalizeServerUrl(normalized);
  } catch {
    // Keep the raw value so a bad configuration cannot collide with a good one.
  }
  return `${normalized}|${String(username ?? '').toLowerCase()}`;
}

export function serverPattern(serverUrl) {
  return originPattern(normalizeServerUrl(serverUrl));
}

export async function hasHostPermission(api, serverUrl) {
  try {
    return await api.permissions.contains({ origins: [serverPattern(serverUrl)] });
  } catch {
    return false;
  }
}

export async function requestHostPermission(api, serverUrl) {
  try {
    return await api.permissions.request({ origins: [serverPattern(serverUrl)] });
  } catch {
    return false;
  }
}

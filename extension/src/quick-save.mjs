import { isSupportedUrl } from './utils.mjs';

export function quickSavePlan({ tab, settings, lastFolder } = {}) {
  const rawUrl = String(tab?.url ?? '').trim();
  if (!rawUrl || !isSupportedUrl(rawUrl)) {
    return { error: 'unsupported' };
  }

  if (!settings?.serverUrl || !settings?.username || !settings?.password) {
    return { error: 'unconfigured' };
  }

  const folder = Number(lastFolder);
  return {
    url: rawUrl.replace(/\/+$/, ''),
    title: String(tab?.title ?? '').trim() || rawUrl,
    folders: Number.isFinite(folder) && folder !== -1 ? [folder] : [-1]
  };
}

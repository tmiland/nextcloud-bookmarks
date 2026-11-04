const api = globalThis.browser ?? globalThis.chrome;

function replacePlaceholders(message, substitutions) {
  if (!substitutions) {
    return message;
  }
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let result = message;
  values.forEach((value, index) => {
    result = result.split(`$${index + 1}`).join(String(value));
  });
  return result;
}

export function t(key, substitutions) {
  if (!key) {
    return '';
  }

  let message = '';
  try {
    message = api?.i18n?.getMessage(key) ?? '';
  } catch {
    message = '';
  }

  return replacePlaceholders(message || key, substitutions);
}

export function localizeDocument(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
  for (const element of root.querySelectorAll('[data-i18n-title]')) {
    element.title = t(element.dataset.i18nTitle);
  }
  for (const element of root.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
}

export function setDocumentLanguage() {
  try {
    const language = api?.i18n?.getUILanguage?.();
    if (language) {
      document.documentElement.lang = language;
    }
  } catch {
    // Keep the document language as-is.
  }
}

'use strict';
(function () {
  const status = document.getElementById('status');
  const params = new URLSearchParams(location.search);
  const settings = JSON.parse(params.get('settings') || '{}');
  const target = params.get('target') || 'popup.html';
  const extra = JSON.parse(params.get('extra') || '{}');

  (globalThis.browser || globalThis.chrome).storage.local
    .set({ settings, ...extra })
    .then(() => {
      status.textContent = 'seeded';
      location.href = target;
    })
    .catch((error) => {
      status.textContent = 'error: ' + error.message;
    });
}());

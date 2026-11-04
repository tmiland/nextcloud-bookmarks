import test from 'node:test';
import assert from 'node:assert/strict';

import { quickSavePlan } from '../extension/src/quick-save.mjs';

const settings = {
  serverUrl: 'https://cloud.example.com',
  username: 'alice',
  password: 'secret'
};

test('quickSavePlan rejects restricted and non-web URLs', () => {
  for (const url of ['about:config', 'moz-extension://abc/popup.html', 'javascript:alert(1)', 'data:text/html,x', '']) {
    assert.deepEqual(quickSavePlan({ tab: { url, title: 'x' }, settings }), { error: 'unsupported' });
  }
});

test('quickSavePlan rejects missing credentials', () => {
  for (const missing of [
    { serverUrl: '', username: 'a', password: 'b' },
    { serverUrl: 'https://x.example', username: '', password: 'b' },
    { serverUrl: 'https://x.example', username: 'a', password: '' }
  ]) {
    assert.deepEqual(
      quickSavePlan({ tab: { url: 'https://example.com/', title: 'x' }, settings: missing }),
      { error: 'unconfigured' }
    );
  }
});

test('quickSavePlan strips the trailing slash and keeps the tab title', () => {
  assert.deepEqual(
    quickSavePlan({
      tab: { url: 'https://example.com/path/', title: ' Example ' },
      settings,
      lastFolder: 12
    }),
    {
      url: 'https://example.com/path',
      title: 'Example',
      folders: [12]
    }
  );
});

test('quickSavePlan uses root when there is no usable last folder', () => {
  assert.deepEqual(
    quickSavePlan({ tab: { url: 'https://example.com', title: '' }, settings, lastFolder: -1 }).folders,
    [-1]
  );
  assert.deepEqual(
    quickSavePlan({ tab: { url: 'https://example.com', title: '' }, settings, lastFolder: 'nope' }).folders,
    [-1]
  );
});

test('quickSavePlan falls back to the URL when the title is empty', () => {
  assert.equal(
    quickSavePlan({ tab: { url: 'https://example.com/', title: '   ' }, settings }).title,
    'https://example.com/'
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accountKey,
  buildClient,
  hasHostPermission,
  loadSettings,
  normalizeSettings,
  saveSettings
} from '../extension/src/settings.mjs';

function fakeApi(initial = {}) {
  const data = { ...initial };
  const requests = [];
  return {
    data,
    requests,
    storage: {
      local: {
        async get(key) {
          if (key === undefined || key === null) return { ...data };
          return { [key]: data[key] };
        },
        async set(values) {
          Object.assign(data, values);
        },
        async remove(key) {
          delete data[key];
        }
      }
    },
    permissions: {
      async contains(request) {
        requests.push({ type: 'contains', request });
        return true;
      },
      async request(request) {
        requests.push({ type: 'request', request });
        return true;
      }
    }
  };
}

test('normalizeSettings keeps only the known fields', () => {
  assert.deepEqual(normalizeSettings({
    serverUrl: 'https://cloud.example.com',
    username: 'alice',
    password: 'secret',
    searchMainTab: 1,
    ignored: 'no'
  }), {
    serverUrl: 'https://cloud.example.com',
    username: 'alice',
    password: 'secret',
    searchMainTab: true
  });
});

test('settings round-trip through storage.local', async () => {
  const api = fakeApi();
  await saveSettings(api, {
    serverUrl: 'https://cloud.example.com',
    username: 'alice',
    password: 'secret',
    searchMainTab: true
  });

  assert.deepEqual(await loadSettings(api), {
    serverUrl: 'https://cloud.example.com',
    username: 'alice',
    password: 'secret',
    searchMainTab: true
  });
});

test('accountKey normalizes the server and lowercases the username', () => {
  assert.equal(
    accountKey('https://cloud.example.com/nextcloud/', 'Alice'),
    'https://cloud.example.com/nextcloud|alice'
  );
  assert.notEqual(
    accountKey('https://cloud.example.com', 'alice'),
    accountKey('https://other.example.com', 'alice')
  );
  assert.notEqual(
    accountKey('https://cloud.example.com', 'alice'),
    accountKey('https://cloud.example.com', 'bob')
  );
});

test('buildClient constructs a client from settings', () => {
  const client = buildClient({
    serverUrl: 'https://cloud.example.com/nextcloud/',
    username: 'alice',
    password: 'secret'
  });
  assert.equal(client.serverUrl, 'https://cloud.example.com/nextcloud');
  assert.equal(client.username, 'alice');
});

test('hasHostPermission asks for the configured origin pattern', async () => {
  const api = fakeApi();
  assert.equal(await hasHostPermission(api, 'https://cloud.example.com/nextcloud'), true);
  assert.deepEqual(api.requests[0], {
    type: 'contains',
    request: { origins: ['https://cloud.example.com/*'] }
  });
});

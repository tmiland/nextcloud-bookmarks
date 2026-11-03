import test from 'node:test';
import assert from 'node:assert/strict';

import {
  basicAuthHeader,
  buildFolderTree,
  formatError,
  isSupportedUrl,
  joinTags,
  normalizeServerUrl,
  normalizeUrlForCompare,
  originPattern,
  parseTags,
  toParams
} from '../extension/src/utils.mjs';

function paramsObject(params) {
  const result = {};
  for (const [key, value] of params.entries()) {
    (result[key] ??= []).push(value);
  }
  return result;
}

test('normalizeServerUrl adds https and strips trailing slashes', () => {
  assert.equal(normalizeServerUrl('cloud.example.com'), 'https://cloud.example.com');
  assert.equal(normalizeServerUrl('https://cloud.example.com/'), 'https://cloud.example.com');
  assert.equal(
    normalizeServerUrl('https://cloud.example.com/nextcloud/'),
    'https://cloud.example.com/nextcloud'
  );
  assert.equal(normalizeServerUrl('  '), '');
});

test('normalizeServerUrl allows local HTTP but rejects remote HTTP', () => {
  assert.equal(normalizeServerUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(normalizeServerUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.throws(() => normalizeServerUrl('http://cloud.example.com'), /HTTPS/);
  assert.throws(() => normalizeServerUrl('ftp://cloud.example.com'), /http/);
});

test('originPattern drops ports', () => {
  assert.equal(originPattern('https://cloud.example.com:8443/nextcloud'), 'https://cloud.example.com/*');
  assert.equal(originPattern('http://127.0.0.1:8080'), 'http://127.0.0.1/*');
});

test('basicAuthHeader encodes ASCII and UTF-8 credentials', () => {
  assert.equal(basicAuthHeader('user', 'pass'), 'Basic dXNlcjpwYXNz');
  assert.equal(
    basicAuthHeader('üser', 'päss'),
    'Basic ' + Buffer.from('üser:päss', 'utf8').toString('base64')
  );
});

test('toParams appends arrays with [] and ignores null/undefined', () => {
  const params = paramsObject(toParams({
    a: 1,
    tags: ['one', 'two'],
    folders: [10],
    empty: [],
    missing: undefined,
    nothing: null
  }));

  assert.deepEqual(params.a, ['1']);
  assert.deepEqual(params['tags[]'], ['one', 'two']);
  assert.deepEqual(params['folders[]'], ['10']);
  assert.equal(params['empty[]'], undefined);
  assert.equal(params.missing, undefined);
  assert.equal(params.nothing, undefined);
});

test('buildFolderTree creates an indented tree and includes orphans', () => {
  const tree = buildFolderTree([
    { id: 1, title: 'Work', parent_folder: -1 },
    { id: 2, title: 'Projects', parent_folder: 1 },
    { id: 3, title: 'Home', parent_folder: -1 },
    { id: 4, title: 'Orphan', parent_folder: 99 }
  ]);

  assert.deepEqual(tree.map((item) => [item.id, item.depth]), [
    [3, 0],
    [1, 0],
    [2, 1],
    [4, 0]
  ]);
});

test('normalizeUrlForCompare ignores hashes and trailing slashes', () => {
  assert.equal(
    normalizeUrlForCompare('https://example.com/#section'),
    normalizeUrlForCompare('https://example.com')
  );
  assert.equal(
    normalizeUrlForCompare('https://example.com/path/'),
    normalizeUrlForCompare('https://example.com/path')
  );
});

test('parseTags and joinTags round-trip comma-separated tags', () => {
  assert.deepEqual(parseTags(' one, two ,, three '), ['one', 'two', 'three']);
  assert.equal(joinTags(['one', 'two']), 'one, two');
});

test('isSupportedUrl accepts web, ftp and file URLs only', () => {
  assert.equal(isSupportedUrl('https://example.com'), true);
  assert.equal(isSupportedUrl('http://example.com'), true);
  assert.equal(isSupportedUrl('ftp://example.com'), true);
  assert.equal(isSupportedUrl('file:///tmp/a'), true);
  assert.equal(isSupportedUrl('javascript:alert(1)'), false);
  assert.equal(isSupportedUrl('data:text/html,x'), false);
});

test('formatError explains common failures and preserves custom messages', () => {
  assert.match(formatError({ status: 401 }), /app password/);
  assert.match(formatError({ status: 403 }), /denied/);
  assert.match(formatError({ status: 404 }), /Bookmarks app/);
  assert.match(formatError({ status: 500, data: { message: 'boom' } }), /boom/);
  assert.equal(formatError(new Error('The bookmark was not saved.')), 'The bookmark was not saved.');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const folder = require('../../src/lib/folder.js');

const { folderFailure } = folder;
const dom = (name) => new DOMException(`${name} happened`, name);

test('a lapsed or refused grant reads as folder_not_connected', () => {
  assert.equal(folderFailure(dom('NotAllowedError')), 'folder_not_connected');
  assert.equal(folderFailure(dom('SecurityError')), 'folder_not_connected');
});

test('a renamed or deleted folder reads as folder_missing', () => {
  assert.equal(folderFailure(dom('NotFoundError')), 'folder_missing');
});

test('every other file system error reads as folder_write_failed', () => {
  for (const name of ['QuotaExceededError', 'InvalidStateError', 'InvalidModificationError', 'NoModificationAllowedError',
    'TypeMismatchError', 'AbortError', 'DataError', 'UnknownError']) {
    assert.equal(folderFailure(dom(name)), 'folder_write_failed', name);
  }
});

test('the error is told apart by its name, not by its class or its message', () => {
  assert.equal(folderFailure({ name: 'NotAllowedError' }), 'folder_not_connected');
  assert.equal(folderFailure({ name: 'SecurityError' }), 'folder_not_connected');
  assert.equal(folderFailure({ name: 'NotFoundError' }), 'folder_missing');
  assert.equal(folderFailure(Object.assign(new Error('x'), { name: 'NotFoundError' })), 'folder_missing');
  assert.equal(folderFailure(new Error('NotAllowedError')), 'folder_write_failed');
  assert.equal(folderFailure(new DOMException('NotFoundError', 'AbortError')), 'folder_write_failed');
  assert.equal(folderFailure({ name: 'notfounderror' }), 'folder_write_failed');
});

test('plain errors, odd values, null and undefined read as folder_write_failed', () => {
  assert.equal(folderFailure(new Error('disk full')), 'folder_write_failed');
  assert.equal(folderFailure(new TypeError('network error')), 'folder_write_failed');
  assert.equal(folderFailure(undefined), 'folder_write_failed');
  assert.equal(folderFailure(null), 'folder_write_failed');
  assert.equal(folderFailure(), 'folder_write_failed');
  assert.equal(folderFailure({}), 'folder_write_failed');
  assert.equal(folderFailure('NotFoundError'), 'folder_write_failed');
  assert.equal(folderFailure(404), 'folder_write_failed');
});

test('only the three reason codes come out', () => {
  const codes = new Set(['folder_not_connected', 'folder_missing', 'folder_write_failed']);
  for (const error of [dom('NotAllowedError'), dom('NotFoundError'), dom('AbortError'), new Error('x'), null, undefined, 'x', 0]) {
    assert.ok(codes.has(folderFailure(error)), String(error));
  }
});

test('the module exports the folder handle store and is shared through the worker global', () => {
  for (const name of ['getRoot', 'setRoot', 'clearRoot', 'folderFailure']) {
    assert.equal(typeof folder[name], 'function', name);
    assert.equal(globalThis.MoodboardClip[name], folder[name], name);
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', '..');
// Objects built inside the vm context have another Object.prototype; a JSON round trip makes them comparable.
const plain = (v) => JSON.parse(JSON.stringify(v));
const source = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

// Runs src/content/behance.js in a fresh context with a fake window, a fake chrome.runtime.onMessage and a recording
// stand-in for MoodboardClip.findImageAtPoint (which overlay.test.js covers on its own).
function load(answer = () => ({ miss: 'none' })) {
  const calls = [];
  const handlers = { contextmenu: [], message: [] };
  const win = { addEventListener: (type, fn, capture) => handlers[type].push({ fn, capture }) };
  const chrome = { runtime: { onMessage: { addListener: (fn) => handlers.message.push({ fn }) } } };
  const MoodboardClip = { findImageAtPoint: (...args) => { calls.push(args); return answer(...args); } };
  const ctx = vm.createContext({ window: win, chrome, MoodboardClip });
  vm.runInContext(source('src/content/behance.js'), ctx, { filename: 'behance.js' });
  const click = (target, x, y) => handlers.contextmenu.forEach((h) => h.fn({ target, clientX: x, clientY: y }));
  const ask = (msg) => {
    const replies = [];
    const results = handlers.message.map((h) => h.fn(msg, {}, (r) => replies.push(r)));
    return { replies: plain(replies), results };
  };
  return { handlers, calls, click, ask };
}

test('it listens for contextmenu in the capture phase and for one runtime message listener', () => {
  const { handlers } = load();
  assert.equal(handlers.contextmenu.length, 1);
  assert.equal(handlers.contextmenu[0].capture, true);
  assert.equal(handlers.message.length, 1);
});

test('the picture is looked up at right-click time and the last click answers, synchronously', () => {
  const target = { id: 'span' };
  const { calls, click, ask } = load((t, x, y) => ({ url: `https://cdn.test/${x}-${y}.jpg`, same: t === target }));
  click({ id: 'older' }, 1, 2);
  click(target, 300, 250);
  assert.deepEqual(calls, [[{ id: 'older' }, 1, 2], [target, 300, 250]]); // at the click, not at the question
  const { replies, results } = ask({ type: 'image-at-point' });
  assert.equal(calls.length, 2);
  assert.deepEqual(replies, [{ url: 'https://cdn.test/300-250.jpg', same: true }]);
  assert.deepEqual(results, [false]); // no return true: the answer is already sent
});

test('an answer is given once: a second question without a new right click is none', () => {
  const { click, ask } = load(() => ({ url: 'https://cdn.test/a.jpg' }));
  click({}, 5, 5);
  assert.deepEqual(ask({ type: 'image-at-point' }).replies, [{ url: 'https://cdn.test/a.jpg' }]);
  assert.deepEqual(ask({ type: 'image-at-point' }).replies, [{ miss: 'none' }]);
});

test('a finder that throws on the right click answers none', () => {
  const { click, ask } = load(() => { throw new Error('detached'); });
  assert.doesNotThrow(() => click({}, 5, 5));
  assert.deepEqual(ask({ type: 'image-at-point' }).replies, [{ miss: 'none' }]);
});

test('image-at-point before any right click is none, and the finder is not asked', () => {
  const { calls, ask } = load();
  assert.deepEqual(ask({ type: 'image-at-point' }).replies, [{ miss: 'none' }]);
  assert.deepEqual(calls, []);
});

test('the finder verdict is passed on unchanged (many stays many)', () => {
  const { click, ask } = load(() => ({ miss: 'many' }));
  click({}, 5, 5);
  assert.deepEqual(ask({ type: 'image-at-point' }).replies, [{ miss: 'many' }]);
});

test('other messages, probes and garbage are ignored without a reply and keep the answer', () => {
  const { click, ask } = load(() => ({ url: 'https://cdn.test/a.jpg' }));
  click({}, 5, 5);
  const others = [{ type: 'probe-context', srcUrl: 'https://cdn.test/a.jpg' }, { type: 'other' }, {}, null, undefined,
    'image-at-point'];
  for (const msg of others) {
    const { replies, results } = ask(msg);
    assert.deepEqual([replies, results], [[], [false]]);
  }
  assert.deepEqual(ask({ type: 'image-at-point' }).replies, [{ url: 'https://cdn.test/a.jpg' }]);
});

test('the manifest loads overlay.js before behance.js on behance.net and every host it names is one https site', () => {
  const manifest = JSON.parse(source('manifest.json'));
  const entry = manifest.content_scripts.find((c) => c.js.includes('src/content/behance.js'));
  assert.deepEqual(entry.matches, ['https://*.behance.net/*']);
  assert.deepEqual(entry.js, ['src/lib/overlay.js', 'src/content/behance.js']);
  assert.ok(manifest.host_permissions.includes('https://*.behance.net/*'));
  const site = /^https:\/\/(\*\.)?[a-z0-9.-]+\/\*$/;
  const named = [...manifest.host_permissions, ...manifest.content_scripts.flatMap((c) => c.matches)];
  assert.ok(named.length > 0 && named.every((pattern) => site.test(pattern)), named.join(' '));
  assert.ok(fs.existsSync(path.join(APP, entry.js[1])));
});

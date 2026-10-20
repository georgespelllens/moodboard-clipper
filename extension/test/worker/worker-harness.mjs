import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

// Every unhandled rejection of the whole run lands here; the last lines of the file demand it is empty.
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

// flags: initial `env` flags that must hold while background.js loads (it reconciles at load time).
function makeEnv({ store = {}, session = {}, files = {}, flags = {} } = {}) {
  const log = { downloads: [], sent: [], ui: [], alarms: [], badges: [], badgeTries: [], later: [], fetches: [], timeouts: [], warns: [], scripts: [], fetchInit: [], holder: [], permissionChecks: [] };
  // env.storageFails: true (every call), or a list such as 'session' or 'session.get,local.set'.
  const storageFails = (name, op) => env.storageFails === true
    || String(env.storageFails || '').split(',').some((p) => p === name || p === `${name}.${op}`);
  const area = (data, name) => ({
    data,
    async get(q) {
      if (storageFails(name, 'get')) throw new Error(`storage ${name}`);
      if (typeof q === 'string') q = [q];
      if (Array.isArray(q)) return Object.fromEntries(q.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
      return Object.fromEntries(Object.entries(q).map(([k, d]) => [k, k in data ? structuredClone(data[k]) : d]));
    },
    async set(o) {
      if (storageFails(name, 'set')) throw new Error(`storage ${name}`);
      Object.assign(data, structuredClone(o));
    },
  });
  const ev = () => { const l = []; return { addListener: (f) => l.push(f), fire: (...a) => l.map((f) => f(...a)), l }; };
  const downloadsItems = {};
  let nextId = 1;
  const chrome = {
    storage: { local: area(store, 'local'), session: area(session, 'session') },
    // getContexts/sendMessage serve the folder holder (the offscreen page) and only matter once `offscreen: true` is set
    runtime: {
      onInstalled: ev(), onStartup: ev(), onMessage: ev(), getURL: (p) => 'chrome-extension://test/' + p,
      getContexts: async () => (env.offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
      sendMessage: async (m) => { log.holder.push(['message', m.type]); return env.holderReply; },
    },
    i18n: { getMessage: (key) => key, getUILanguage: () => 'en' },
    contextMenus: { removeAll: async () => log.menu = [], create: (o) => log.menu.push(o), onClicked: ev() },
    alarms: {
      create: (n, o) => log.alarms.push(['create', n, o]),
      clear: async (n) => { if (env.alarmClearFails) throw new Error('alarm'); log.alarms.push(['clear', n]); },
      onAlarm: ev(),
    },
    // badgeThrows: true rejects like MV3 does, 'sync' throws like an old API
    // env.shown is what the toolbar shows: it outlives the worker, so a test may set it to '!' after boot
    action: {
      setBadgeText: (o) => {
        log.badgeTries.push(o.text);
        if (env.badgeThrows === 'sync') throw new Error('badge');
        if (env.badgeThrows) return Promise.reject(new Error('badge'));
        log.badges.push(o.text);
        env.shown = o.text;
        return Promise.resolve();
      },
      getBadgeText: async () => env.shown,
    },
    // hostAccess: whether the extension may read the page's host (chrome.permissions.contains)
    permissions: { contains: async (q) => { log.permissionChecks.push(q); return env.hostAccess; } },
    // scriptResult: what the injected findImageUnderLink returns; scriptRaw: the whole results array instead (e.g. [] when no frame ran it);
    // scriptFails: true rejects like a page the extension may not script
    scripting: {
      executeScript: async (o) => {
        log.scripts.push(o);
        if (env.scriptFails) throw new Error('Cannot access contents of the page');
        return env.scriptRaw ?? [{ result: env.scriptResult }];
      },
    },
    // probeFails: true rejects the probe like a frame without a content script ("Receiving end does not exist")
    tabs: {
      sendMessage: async (tabId, msg, opt) => {
        log.sent.push({ tabId, msg, opt });
        if (msg.type === 'probe-context') {
          if (env.probeFails) throw new Error('no receiver');
          return env.probe;
        }
        // atPointFails: true rejects like a tab without the Behance content script ("Receiving end does not exist")
        if (msg.type === 'image-at-point') {
          if (env.atPointFails) throw new Error('Could not establish connection. Receiving end does not exist.');
          return env.atPoint;
        }
      },
    },
    downloads: {
      onChanged: ev(),
      setUiOptions: async (o) => log.ui.push(o.enabled),
      download: async (o) => {
        if (env.failDownload) throw new Error('boom');
        const id = nextId++;
        downloadsItems[id] = { id, state: 'in_progress' };
        log.downloads.push({ id, ...o });
        if (env.fireEarly) { downloadsItems[id].state = 'complete'; chrome.downloads.onChanged.fire({ id, state: { current: 'complete' } }); }
        return id;
      },
      search: async ({ id }) => (downloadsItems[id] ? [downloadsItems[id]] : []),
      cancel: async () => {},
    },
  };
  // files[url]: a content type, { type, status = 200, head } (`head` answers HEAD requests only), 'hang' or 'reject' (fetch throws).
  // For the folder mode a GET can carry a body: { bytes: [..] } streams the bytes in two chunks (`noStream`: body is null, blob() answers),
  // `breakStream` errors the stream after the first chunk, `rejectGet` makes only the GET throw, `gate` (a promise) holds the GET back.
  const fetchMock = async (url, opt = {}) => {
    const method = opt.method ?? 'GET';
    log.fetches.push(`${method} ${url}${opt.headers?.Range ? ' range' : ''}`);
    log.fetchInit.push({ method, url, credentials: opt.credentials, cache: opt.cache });
    const spec = files[url];
    if (spec === 'reject') throw new TypeError('Failed to fetch');
    if (spec === 'hang') {
      return new Promise((_, reject) => {
        const stop = () => reject(new Error('aborted'));
        if (opt.signal?.aborted) stop(); else opt.signal?.addEventListener('abort', stop);
      });
    }
    const { type, status = 200, head, bytes, noStream, breakStream, rejectGet, gate } = typeof spec === 'string' ? { type: spec } : spec ?? { status: 404 };
    if (method === 'GET' && rejectGet) throw new TypeError('Failed to fetch');
    if (method === 'GET' && gate) await gate;
    const code = method === 'HEAD' && head !== undefined ? head : status;
    let body = method === 'GET' ? { cancel: () => (env.cancelRejects ? Promise.reject(new Error('cancel')) : Promise.resolve()) } : null;
    let blob;
    if (method === 'GET' && bytes) {
      const data = Uint8Array.from(bytes);
      let pulls = 0;
      body = noStream ? null : new ReadableStream({
        pull(c) {
          if (++pulls === 1) return c.enqueue(data.slice(0, 2));
          if (breakStream) return c.error(new TypeError('network error'));
          c.enqueue(data.slice(2));
          c.close();
        },
      });
      blob = async () => new Blob([data]);
    }
    return { ok: code >= 200 && code < 300, status: code, headers: { get: () => type ?? null }, body, blob };
  };
  const AbortSignalStub = {
    timeout(ms) { log.timeouts.push(ms); const c = new AbortController(); setTimeout(() => c.abort(), 5); return c.signal; },
  };
  const ctxConsole = { ...console, warn: (...a) => log.warns.push(a.map(String).join(' ')) };
  const ctx = vm.createContext({ chrome, fetch: fetchMock, crypto, TextEncoder, URL, ReadableStream, AbortSignal: AbortSignalStub, setTimeout: (fn) => { log.later.push(fn); return 0; }, console: ctxConsole, structuredClone });
  // The real getRoot reads IndexedDB, which this sandbox lacks: it answers env.root (a fake directory handle, or null) instead.
  // background.js destructures getRoot right after importScripts, so the swap has to happen inside it.
  ctx.importScripts = (...p) => p.forEach((f) => {
    vm.runInContext(fs.readFileSync(SRC + f, 'utf8'), ctx, { filename: f });
    if (f === 'lib/folder.js') ctx.MoodboardClip.getRoot = async () => env.root;
  });
  if (flags.offscreen) {
    chrome.offscreen = {
      createDocument: async (o) => { log.holder.push(['create', o.url, o.reasons.join()]); env.offscreenOpen = true; },
      closeDocument: async () => { log.holder.push(['close']); env.offscreenOpen = false; },
    };
  }
  const env = { chrome, log, ctx, downloadsItems, root: null, hostAccess: false, shown: '', offscreenOpen: false, holderReply: { ok: true }, probe: null, failDownload: false, fireEarly: false, cancelRejects: false, badgeThrows: false, storageFails: false, alarmClearFails: false, probeFails: false, atPoint: undefined, atPointFails: false, scriptResult: undefined, scriptRaw: undefined, scriptFails: false, ...flags };
  vm.runInContext(fs.readFileSync(SRC + 'background.js', 'utf8'), ctx, { filename: 'background.js' });
  return env;
}
const tick = () => new Promise((r) => setTimeout(r, 20));
// Polls instead of guessing a sleep: keyFor() hashes through crypto.subtle, which really is asynchronous.
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`until timed out: ${fn}`);
    await tick();
  }
}
// The load-time reconcile has run (it ends by showing the download shelf again).
const booted = (env) => until(() => env.log.ui.length > 0);
const noUnhandled = async () => { await tick(); assert.deepEqual(unhandled.map(String), []); };
const menuInfo = (extra = {}) => ({ menuItemId: 'moodboard-clip', srcUrl: 'https://example.com/a.png', pageUrl: 'https://example.com/p', frameId: 0, ...extra });
const send = (env, msg, sender) => new Promise((res) => { const r = env.chrome.runtime.onMessage.l[0](msg, sender, (v) => res(JSON.parse(JSON.stringify(v)))); if (!r) res('NO-ASYNC'); });
const finishDl = async (env, id, state = 'complete', error) => {
  env.downloadsItems[id].state = state;
  env.chrome.downloads.onChanged.fire({ id, state: { current: state }, ...(error ? { error: { current: error } } : {}) });
  await tick();
};
const pinSender = { tab: { id: 7 }, frameId: 0, url: 'https://www.pinterest.com/pin/1/' };
const pinMsg = { type: 'clip', token: 'tok1', site: 'pinterest', shownUrl: 'https://i.pinimg.com/236x/ab/cd/ef/abcdef.jpg',
  srcset: null, pageUrl: 'https://www.pinterest.com/pin/123/', pageUrlKind: 'pin', key: '123', title: 'T', alt: 'A', author: 'Au', authorUrl: null, media: 'image' };

const pinN = (n) => ({ ...pinMsg, token: `tok${n}`, shownUrl: `https://i.pinimg.com/236x/ab/cd/ef/pin${n}.jpg`, key: `k${n}`, pageUrl: `https://www.pinterest.com/pin/${n}/` });
const origJpg = (n) => `https://i.pinimg.com/originals/ab/cd/ef/pin${n}.jpg`;
const cardOf = (d) => JSON.parse(decodeURIComponent(d.url.split(',')[1]));
const clipResults = (env) => env.log.sent.filter((s) => s.msg.type === 'clip-result').map((s) => [s.msg.status, s.msg.reason]);
const data = (env) => ({ local: env.chrome.storage.local.data, ses: env.chrome.storage.session.data });
// Marks every item finished and fires all onChanged events in the same tick.
const finishAll = async (env, ids, state = 'complete') => {
  for (const id of ids) env.downloadsItems[id].state = state;
  for (const id of ids) env.chrome.downloads.onChanged.fire({ id, state: { current: state } });
  await tick();
};

// 1. pinterest happy path with fallback ladder
{
  const env = makeEnv({ files: { 'https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg': 'image/jpeg' } });
  await tick();
  const res = await send(env, pinMsg, pinSender);
  assert.equal(res.status, 'pending');
  console.log('probes:', env.log.fetches.map((f) => f.split('pinimg.com')[1]).join(' | '));
  const d1 = env.log.downloads[0];
  assert.match(d1.filename, /^moodboard-inbox\/unsorted\/\d{8}T\d{6}Z-pinterest-123\.jpg$/);
  assert.deepEqual([d1.saveAs, d1.conflictAction], [false, 'overwrite']);
  await finishDl(env, d1.id);
  const d2 = env.log.downloads[1];
  assert.match(d2.filename, /^moodboard-inbox\/unsorted\/.*-pinterest-123\.json$/);
  const card = JSON.parse(decodeURIComponent(d2.url.split(',')[1]));
  assert.equal(card.asset_fallback, '736x');
  await finishDl(env, d2.id);
  const sent = env.log.sent.find((s) => s.msg.type === 'clip-result');
  assert.deepEqual([sent.tabId, sent.opt.frameId, sent.msg.token, sent.msg.status], [7, 0, 'tok1', 'ok']);
  const local = env.chrome.storage.local.data, ses = env.chrome.storage.session.data;
  assert.equal(local.counts.unsorted, 1);
  assert.equal(local.seen.length, 1);
  assert.equal(local.recent[0].status, 'ok');
  assert.deepEqual(ses.pending, {}); assert.deepEqual(ses.inflight, []);
  assert.deepEqual(env.log.ui, [true, false, true]);
  assert.deepEqual(env.log.alarms.at(-1), ['clear', 'mbc-ui-restore']);
  const again = await send(env, { ...pinMsg, token: 'tok2' }, pinSender);
  assert.equal(again.status, 'repeat');
  assert.equal(env.chrome.storage.local.data.recent[0].status, 'repeat');
  console.log('1 ok: ladder, two-stage download, clip-result, repeat');
}

// 2. concurrent duplicate while in flight, interrupted download, all probes failing
{
  const env = makeEnv({ files: { 'https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg': 'image/jpeg' } });
  const [a, b] = await Promise.all([send(env, pinMsg, pinSender), send(env, { ...pinMsg, token: 'tok2' }, pinSender)]);
  assert.deepEqual([a.status, b.status].sort(), ['error', 'pending']);
  assert.equal([a, b].find((r) => r.status === 'error').reason, 'already_saving');
  await finishDl(env, env.log.downloads[0].id, 'interrupted', 'NETWORK_FAILED');
  const sent = env.log.sent.find((s) => s.msg.type === 'clip-result');
  assert.deepEqual([sent.msg.status, sent.msg.reason], ['error', 'NETWORK_FAILED']);
  assert.equal(env.chrome.storage.local.data.seen?.length ?? 0, 0);
  assert.equal(env.chrome.storage.local.data.counts?.unsorted ?? 0, 0);
  const none = makeEnv({ files: {} });
  const r = await send(none, pinMsg, pinSender);
  assert.deepEqual(r, { status: 'error', reason: 'image_unavailable' });
  assert.deepEqual(none.log.ui, [true]);
  console.log('2 ok: inflight guard, interrupted, unreachable');
}

// 3. validation and rejected download
{
  const env = makeEnv({ files: {} });
  assert.equal((await send(env, pinMsg, { ...pinSender, url: 'http://www.pinterest.com/' })).reason, 'not_https');
  assert.equal((await send(env, pinMsg, { ...pinSender, url: 'https://evil.example/' })).reason, 'unknown_site');
  assert.equal(await send(env, pinMsg, { frameId: 0, url: pinSender.url }), 'NO-ASYNC');
  assert.equal((await send(env, { ...pinMsg, shownUrl: 'blob:https://x/1' }, pinSender)).reason, 'no_image_url');
  const env2 = makeEnv({ files: { 'https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg': 'image/jpeg' } });
  env2.failDownload = true;
  const r = await send(env2, pinMsg, pinSender);
  assert.deepEqual([r.status, r.reason], ['error', 'boom']);
  assert.deepEqual(env2.chrome.storage.session.data.inflight ?? [], []);
  assert.deepEqual(env2.log.ui, [true, false, true]);
  console.log('3 ok: sender validation, blob url, failing download() restores the UI');
}

// 4. context menu: web page, cosmos probe, non-https
{
  const env = makeEnv({ store: { activeBoard: 'Кино 2026!' }, files: { 'https://example.com/a/b.png?w=1': 'image/png' } });
  await booted(env);
  env.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: 'https://example.com/a/b.png?w=1', pageUrl: 'https://example.com/p?x=1' }), { id: 3, title: 'Заголовок' });
  await until(() => env.log.downloads[0]);
  const d = env.log.downloads[0];
  assert.match(d.filename, /^moodboard-inbox\/кино-2026\/.*-web-[0-9a-f]{10}\.png$/);
  assert.equal(d.url, 'https://example.com/a/b.png?w=1');
  await finishDl(env, d.id);
  await until(() => env.log.downloads[1]);
  await finishDl(env, env.log.downloads[1].id);
  const card = JSON.parse(decodeURIComponent(env.log.downloads[1].url.split(',')[1]));
  assert.deepEqual([card.page_url, card.asset_url, card.title, card.alt, card.saved_from], ['https://example.com/p', 'https://example.com/a/b.png', 'Заголовок', null, 'context-menu']);
  assert.equal(env.log.sent.filter((s) => s.msg.type === 'clip-result').length, 0);
  assert.deepEqual(env.log.badges, ['✓']);
  // The 2 s reset of a healthy badge: exactly one timer was queued by the save, and running it clears the badge.
  assert.equal(env.log.later.length, 1);
  env.log.later.forEach((fn) => fn());
  assert.deepEqual(env.log.badges, ['✓', '']);
  await Promise.all(env.chrome.runtime.onInstalled.fire({}));
  assert.deepEqual(JSON.parse(JSON.stringify(env.log.menu)), [{ id: 'moodboard-clip', title: 'menuSave', contexts: ['image', 'link'] }, { id: 'moodboard-clip-page', title: 'menuSave', contexts: ['page'], documentUrlPatterns: ['https://*.behance.net/*'] }]);

  const env2 = makeEnv({ files: { 'https://cdn.cosmos.so/x.jpg': 'image/jpeg' } });
  env2.probe = { shownUrl: 'https://cdn.cosmos.so/x.jpg', srcset: null, pageUrl: 'https://www.cosmos.so/e/abc', pageUrlKind: 'element', key: 'abc', title: null, alt: null, author: null, authorUrl: null, media: 'image' };
  env2.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: 'https://cdn.cosmos.so/x.jpg', pageUrl: 'https://www.cosmos.so/home', frameId: 4 }), { id: 9, title: 'x' });
  await until(() => env2.log.downloads[0]);
  assert.equal(env2.log.sent[0].msg.type, 'probe-context'); assert.equal(env2.log.sent[0].opt.frameId, 4);
  assert.match(env2.log.downloads[0].filename, /-cosmos-abc\.jpg$/);

  const env3 = makeEnv({});
  env3.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: 'https://a.example/i.png', pageUrl: 'http://a.example/' }), { id: 1, title: 't' });
  await until(() => env3.log.badges.length);
  assert.deepEqual(env3.log.badges, ['✗']);
  assert.equal(env3.chrome.storage.local.data.recent[0].reason, 'not_https');

  // Cosmos button: COSMOS_RULE picks the original (by default the CDN address without a query), its extension
  // comes from Content-Type; when it does not answer with an image, the shown copy is saved.
  const { cosmosOriginal } = createRequire(import.meta.url)('../../src/lib/original.js');
  const cosmosMsg = { ...pinMsg, token: 'tok-c', site: 'cosmos', shownUrl: 'https://cdn.cosmos.so/u1?format=jpeg&w=400',
    pageUrl: 'https://www.cosmos.so/e/u1', pageUrlKind: 'element', key: 'u1' };
  const cosmosSender = { tab: { id: 8 }, frameId: 0, url: 'https://www.cosmos.so/home' };
  const cosmosBest = cosmosOriginal(cosmosMsg.shownUrl, null);
  for (const [files, ext, url, fallback] of [
    [{ [cosmosBest]: 'image/webp' }, 'webp', cosmosBest, null],
    [{ [cosmosMsg.shownUrl]: 'image/jpeg' }, 'jpg', cosmosMsg.shownUrl, cosmosBest === cosmosMsg.shownUrl ? null : 'shown'],
  ]) {
    const env4 = makeEnv({ files });
    assert.equal((await send(env4, cosmosMsg, cosmosSender)).status, 'pending');
    assert.match(env4.log.downloads[0].filename, new RegExp(`-cosmos-u1\\.${ext}$`));
    await finishDl(env4, env4.log.downloads[0].id);
    const cosmosCard = JSON.parse(decodeURIComponent(env4.log.downloads[1].url.split(',')[1]));
    assert.deepEqual([cosmosCard.asset_url, cosmosCard.asset_fallback], [url, fallback]);
  }
  console.log('4 ok: web card, cosmos probe, non-https badge, cosmos original by COSMOS_RULE');
}

// 5. reconcile after worker restart
{
  const pending = {
    5: { stage: 'image', card: { id: 'X', board: 'b', site: 'web', title: 't', file: 'X.png' }, ext: 'png', tabId: 1, frameId: 0, token: 'k', key: 'b|u', savedFrom: 'feed-button', startedAt: Date.now() },
    6: { stage: 'card', card: { id: 'Y', board: 'b', site: 'web', title: 't' }, tabId: -1, key: 'b|v', savedFrom: 'context-menu', startedAt: Date.now() - 11 * 60000 },
  };
  const env = makeEnv({ session: { pending, inflight: ['b|u', 'b|v'] } });
  env.downloadsItems[5] = { id: 5, state: 'complete' };
  env.downloadsItems[6] = { id: 6, state: 'in_progress' };
  await tick();
  const ses = env.chrome.storage.session.data;
  assert.deepEqual(Object.keys(ses.pending), ['1']);
  assert.equal(ses.pending[1].stage, 'card');
  assert.deepEqual(ses.inflight, ['b|u']);
  assert.deepEqual(env.log.alarms.at(-1).slice(0, 2), ['create', 'mbc-ui-restore']);
  assert.equal(env.chrome.storage.local.data.recent[0].reason, 'download_lost');
  await finishDl(env, 1);
  assert.deepEqual(env.chrome.storage.session.data.pending, {});
  assert.deepEqual(env.chrome.storage.local.data.seen, ['b|u']);
  assert.deepEqual(env.log.sent.map((m) => m.msg.status), ['ok']);
  assert.deepEqual(env.log.ui.slice(-1), [true]);
  console.log('5 ok: reconcile replays a finished image, drops a stale one, then completes');
}
// 6. onChanged fires inside download(), before it has resolved
{
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' } });
  env.fireEarly = true;
  await tick();
  assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
  await tick();
  assert.equal(env.log.downloads.length, 2);
  assert.match(env.log.downloads[1].filename, /\.json$/);
  assert.deepEqual(clipResults(env), [['ok', null]]);
  const { local, ses } = data(env);
  assert.deepEqual([ses.pending, ses.inflight], [{}, []]);
  assert.deepEqual([local.seen.length, local.counts.unsorted], [1, 1]);
  console.log('6 ok: onChanged inside download() still ends ok');
}

// 7. two clips finish in the same tick
{
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg', [origJpg(2)]: 'image/jpeg' } });
  assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
  assert.equal((await send(env, pinN(2), pinSender)).status, 'pending');
  await finishAll(env, env.log.downloads.slice(0, 2).map((d) => d.id));
  assert.equal(env.log.downloads.length, 4);
  await finishAll(env, env.log.downloads.slice(2).map((d) => d.id));
  const { local, ses } = data(env);
  assert.equal(local.counts.unsorted, 2);
  assert.equal(local.seen.length, 2);
  assert.deepEqual([ses.pending, ses.inflight], [{}, []]);
  assert.deepEqual(clipResults(env), [['ok', null], ['ok', null]]);
  console.log('7 ok: two clips finishing together are both counted');
}

// 8. exactly one card download
{
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' } });
  await send(env, pinN(1), pinSender);
  const id = env.log.downloads[0].id;
  env.downloadsItems[id].state = 'complete';
  env.chrome.downloads.onChanged.fire({ id, state: { current: 'complete' } });
  env.chrome.downloads.onChanged.fire({ id, state: { current: 'complete' } });
  await tick();
  assert.equal(env.log.downloads.length, 2);

  const env2 = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' } });
  await send(env2, pinN(1), pinSender);
  const id2 = env2.log.downloads[0].id;
  env2.downloadsItems[id2].state = 'complete';
  env2.chrome.alarms.onAlarm.fire({ name: 'mbc-ui-restore' });
  env2.chrome.downloads.onChanged.fire({ id: id2, state: { current: 'complete' } });
  await tick();
  assert.equal(env2.log.downloads.length, 2);

  // The card stage starts its own clock: a slow image must not make a fresh card download look stale.
  const env3 = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' } });
  await send(env3, pinN(1), pinSender);
  const id3 = env3.log.downloads[0].id;
  env3.chrome.storage.session.data.pending[id3].startedAt = Date.now() - 11 * 60000;
  await finishAll(env3, [id3]);
  const card = env3.log.downloads[1];
  assert.ok(Date.now() - env3.chrome.storage.session.data.pending[card.id].startedAt < 60000);
  await Promise.all(env3.chrome.alarms.onAlarm.fire({ name: 'mbc-ui-restore' }));
  await tick();
  assert.deepEqual(Object.keys(env3.chrome.storage.session.data.pending), [String(card.id)]);
  assert.deepEqual(clipResults(env3), []);
  console.log('8 ok: one card download per image; a fresh card stage is not stale');
}

// 9. probe ladder: wrong content type, HEAD refused
{
  const env = makeEnv({ files: { [origJpg(1)]: 'text/html', 'https://i.pinimg.com/originals/ab/cd/ef/pin1.png': 'image/png' } });
  assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
  assert.deepEqual(env.log.fetches, [`HEAD ${origJpg(1)}`, 'HEAD https://i.pinimg.com/originals/ab/cd/ef/pin1.png']);
  assert.match(env.log.downloads[0].filename, /-pinterest-k1\.png$/);
  await finishAll(env, [env.log.downloads[0].id]);
  assert.equal(cardOf(env.log.downloads[1]).asset_fallback, 'originals.png');

  const env2 = makeEnv({ files: { [origJpg(1)]: { type: 'image/jpeg', head: 403 } } });
  env2.cancelRejects = true; // a failing body.cancel() must not become an unhandled rejection
  assert.equal((await send(env2, pinN(1), pinSender)).status, 'pending');
  assert.deepEqual(env2.log.fetches, [`HEAD ${origJpg(1)}`, `GET ${origJpg(1)} range`]);
  assert.equal(env2.log.downloads[0].url, origJpg(1));
  await finishAll(env2, [env2.log.downloads[0].id]);
  assert.equal(cardOf(env2.log.downloads[1]).asset_fallback, null);
  await tick();

  // the srcset of a feed image names the real original: it is probed first, whatever extension the thumbnail has
  const png = 'https://i.pinimg.com/originals/ab/cd/ef/pin1.png';
  const env3 = makeEnv({ files: { [png]: 'image/png' } });
  assert.equal((await send(env3, { ...pinN(1), srcset: `${pinN(1).shownUrl} 1x, ${png} 4x` }, pinSender)).status, 'pending');
  assert.deepEqual(env3.log.fetches, [`HEAD ${png}`]);
  assert.equal(env3.log.downloads[0].url, png);
  await finishAll(env3, [env3.log.downloads[0].id]);
  assert.equal(cardOf(env3.log.downloads[1]).asset_fallback, null);
  console.log('9 ok: html candidate skipped, HEAD 403 falls back to a Range GET, srcset original probed first');
}

// 10. failures at the card stage
{
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' } });
  await send(env, pinN(1), pinSender);
  await finishAll(env, [env.log.downloads[0].id]);
  await finishDl(env, env.log.downloads[1].id, 'interrupted', 'NETWORK_FAILED');
  assert.deepEqual(clipResults(env), [['error', 'NETWORK_FAILED']]);
  let { local, ses } = data(env);
  assert.deepEqual([ses.pending, ses.inflight], [{}, []]);
  assert.deepEqual([local.seen ?? [], local.counts ?? {}], [[], {}]);
  assert.equal(local.recent[0].status, 'error');

  const env2 = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' } });
  await send(env2, pinN(1), pinSender);
  env2.failDownload = true; // the image is already on its way, the card download() throws
  await finishAll(env2, [env2.log.downloads[0].id]);
  assert.deepEqual(clipResults(env2), [['error', 'boom']]);
  ({ local, ses } = data(env2));
  assert.deepEqual([ses.pending, ses.inflight], [{}, []]);
  assert.deepEqual([local.seen ?? [], local.counts ?? {}], [[], {}]);

  // UI side effects come last: a badge that rejects (MV3) or throws (old API) must not lose the saved state,
  // and neither the immediate call nor the 2 s reset may leave an unhandled rejection.
  for (const mode of [true, 'sync']) {
    const env3 = makeEnv({ files: { 'https://example.com/a.png': 'image/png' } });
    await booted(env3);
    env3.badgeThrows = mode;
    env3.chrome.contextMenus.onClicked.fire(menuInfo(), { id: 3, title: 'T' });
    await until(() => env3.log.downloads[0]);
    await finishAll(env3, [env3.log.downloads[0].id]);
    await until(() => env3.log.downloads[1]);
    await finishAll(env3, [env3.log.downloads[1].id]);
    await until(() => data(env3).local.recent?.[0]?.status === 'ok');
    ({ local, ses } = data(env3));
    assert.deepEqual([ses.pending, ses.inflight], [{}, []]);
    assert.deepEqual([local.seen.length, local.counts.unsorted, local.recent[0].status], [1, 1, 'ok']);
    assert.equal(env3.log.ui.at(-1), true);
    assert.equal(env3.log.later.length, 1);
    env3.log.later.forEach((fn) => fn()); // the 2 s badge reset
    assert.deepEqual(env3.log.badgeTries, ['✓', '']);
    assert.deepEqual(env3.log.warns, []);
    await noUnhandled();
  }
  console.log('10 ok: card-stage failures clear inflight; a rejecting or throwing badge keeps the state');
}

// 11. type confusion and foreign hosts are rejected before any fetch or download
{
  const BAD = 'bad_request', FOREIGN = 'foreign_image_host', UNKNOWN = 'unknown_site';
  const cosmosPage = 'https://www.cosmos.so/e/u1';
  const cosmosMsg = { ...pinMsg, site: 'cosmos', shownUrl: 'https://cdn.cosmos.so/u1?w=400', pageUrl: cosmosPage, pageUrlKind: 'element' };
  const cosmosSender = { tab: { id: 8 }, frameId: 0, url: 'https://www.cosmos.so/home' };
  const env = makeEnv({ files: new Proxy({}, { get: () => 'image/jpeg' }) });
  const cases = [
    [pinMsg, pinSender, { pageUrl: ['https://www.pinterest.com/pin/1/'] }, BAD],
    [pinMsg, pinSender, { shownUrl: 42 }, BAD],
    [pinMsg, pinSender, { shownUrl: ['https://i.pinimg.com/236x/ab/cd/ef/abcdef.jpg'] }, BAD],
    [pinMsg, pinSender, { pageUrlKind: 'evil' }, BAD],
    [pinMsg, pinSender, { pageUrlKind: 'element' }, BAD],
    [pinMsg, pinSender, { media: 'x' }, BAD],
    [pinMsg, pinSender, { title: 'x'.repeat(30000) }, BAD],
    [pinMsg, pinSender, { alt: ['a'] }, BAD],
    [pinMsg, pinSender, { token: 'x'.repeat(129) }, BAD],
    [pinMsg, pinSender, { key: 'x'.repeat(513) }, BAD],
    [pinMsg, pinSender, { srcset: 7 }, BAD],
    [pinMsg, pinSender, { shownUrl: 'https://evil.example/236x/ab/cd/ef/abcdef.jpg' }, FOREIGN],
    [pinMsg, pinSender, { shownUrl: 'http://i.pinimg.com/236x/ab/cd/ef/abcdef.jpg' }, FOREIGN],
    [pinMsg, pinSender, { shownUrl: 'https://i.pinimg.com.evil.example/236x/ab/cd/ef/abcdef.jpg' }, FOREIGN],
    [pinMsg, pinSender, { pageUrl: cosmosPage }, UNKNOWN],
    [cosmosMsg, cosmosSender, { shownUrl: 'https://i.pinimg.com/236x/ab/cd/ef/abcdef.jpg' }, FOREIGN],
    [cosmosMsg, cosmosSender, { shownUrl: 'http://cdn.cosmos.so/u1' }, FOREIGN],
  ];
  for (const [msg, sender, patch, reason] of cases) {
    const r = await send(env, { ...msg, ...patch }, sender);
    assert.deepEqual(r, { status: 'error', reason }, JSON.stringify(patch).slice(0, 70));
  }
  assert.deepEqual(env.log.fetches, []);
  assert.deepEqual(env.log.downloads, []);
  console.log('11 ok: wrong types, enums, sizes and hosts are refused without a fetch');
}

// 12. a hanging probe is abandoned after PROBE_MS
{
  const env = makeEnv({ files: { [origJpg(1)]: 'hang', 'https://i.pinimg.com/originals/ab/cd/ef/pin1.png': 'image/png' } });
  const r = await send(env, pinN(1), pinSender);
  assert.equal(r.status, 'pending');
  assert.match(env.log.downloads[0].filename, /-pinterest-k1\.png$/);
  assert.ok(env.log.timeouts.length >= 2);
  assert.ok(env.log.timeouts.every((ms) => ms === 8000), String(env.log.timeouts));
  console.log('12 ok: probe timeout skips a hanging candidate');
}

// 13. Chrome renames `<id>.img` to the real extension: the card names the file that is on disk
// webClip: a context-menu save of an extensionless URL (saved as `.img`); `rename(env, downloadId, id)` plays Chrome.
const webClip = async (rename) => {
  const env = makeEnv({});
  env.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: 'https://example.com/photo' }), { id: 3, title: 'T' });
  await until(() => env.log.downloads[0]);
  const d = env.log.downloads[0];
  assert.match(d.filename, /\.img$/);
  const id = d.filename.split('/').pop().replace(/\.img$/, '');
  rename?.(env, d.id, id);
  await finishDl(env, d.id);
  await until(() => env.log.downloads[1]);
  const cardDl = env.log.downloads[1];
  const stored = env.chrome.storage.session.data.pending[cardDl.id].card.file;
  await finishDl(env, cardDl.id);
  return { env, id, stored, card: cardOf(cardDl) };
};
{
  for (const [name, ext] of [
    [(id) => `/home/x/Downloads/moodboard-inbox/unsorted/${id}.png`, 'png'],
    [(id) => `/home/x/Downloads/moodboard-inbox/unsorted/${id}.jpg`, 'jpg'],
    [(id) => `C:\\Users\\x\\Downloads\\moodboard-inbox\\unsorted\\${id}.webp`, 'webp'],
  ]) {
    const { env, id, stored, card } = await webClip((e, dl, id2) => { e.downloadsItems[dl].filename = name(id2); });
    assert.equal(card.file, `${id}.${ext}`);
    assert.equal(stored, `${id}.${ext}`);
    assert.equal(card.id, id);
    assert.equal(env.chrome.storage.local.data.recent[0].status, 'ok');
    assert.deepEqual(env.chrome.storage.session.data.pending, {});
  }
  console.log('13 ok: the card records the extension Chrome gave the saved file');
}

// 14. anything but `<id>.<extension>` leaves the card as built (a name that is not `<id>.…` at all is not in the board: see 23)
{
  const same = (id) => `${id}.img`;
  const cases = [
    (id) => `/d/moodboard-inbox/unsorted/${id}.tar.gz`,
    (id) => `/d/moodboard-inbox/unsorted/${id}.`,
    (id) => `/d/moodboard-inbox/unsorted/${id}.p ng`,
    () => '',
    () => undefined,
    (id) => `/d/moodboard-inbox/unsorted/${same(id)}`,
  ];
  for (const name of cases) {
    const { env, id, stored, card } = await webClip((e, dl, id2) => { e.downloadsItems[dl].filename = name(id2); });
    assert.deepEqual([card.file, stored], [same(id), same(id)], String(name));
    assert.equal(env.chrome.storage.local.data.recent[0].status, 'ok');
  }
  for (const search of [async () => { throw new Error('gone'); }, async () => []]) {
    const { env, id, card } = await webClip((e) => { e.chrome.downloads.search = search; });
    assert.equal(card.file, same(id));
    assert.equal(env.chrome.storage.local.data.recent[0].status, 'ok');
  }
  console.log('14 ok: other names, a failing lookup and an empty lookup keep the built file name');
}

// 15. a failing settleUi (alarms.clear rejects) must not skip the notice, the flash or the saved state
{
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg', 'https://example.com/a.png': 'image/png' } });
  await booted(env);
  env.alarmClearFails = true;
  assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
  await finishAll(env, [env.log.downloads[0].id]);
  await finishAll(env, [env.log.downloads[1].id]);
  assert.deepEqual(clipResults(env), [['ok', null]]);
  assert.deepEqual(env.log.warns, ['mbc finish ui Error: alarm']);
  assert.equal(data(env).local.recent[0].status, 'ok');
  assert.deepEqual([data(env).ses.pending, data(env).ses.inflight], [{}, []]);

  env.log.warns.length = 0;
  env.chrome.contextMenus.onClicked.fire(menuInfo(), { id: 3, title: 'T' });
  await until(() => env.log.downloads[2]);
  await finishAll(env, [env.log.downloads[2].id]);
  await until(() => env.log.downloads[3]);
  await finishAll(env, [env.log.downloads[3].id]);
  await until(() => env.log.badges.length);
  assert.deepEqual(env.log.badges, ['✓']);
  assert.deepEqual(env.log.warns, ['mbc finish ui Error: alarm']);
  assert.equal(data(env).local.recent[0].status, 'ok');
  await noUnhandled();
  console.log('15 ok: a rejecting settleUi is logged on its own; notify, flash and state survive');
}

// 16. the probe reply is page-built: the worker alone names the tab, frame, token, origin and site
{
  const reply = { shownUrl: 'https://cdn.cosmos.so/x.jpg', srcset: null, pageUrl: 'https://www.cosmos.so/e/abc', pageUrlKind: 'element', key: 'abc',
    title: 'T', alt: null, author: null, authorUrl: null, media: 'image' };
  const evil = { tabId: 999, frameId: 77, token: 'evil', savedFrom: 'feed-button', site: 'pinterest' };
  const env = makeEnv({ files: { 'https://cdn.cosmos.so/x.jpg': 'image/jpeg' } });
  await booted(env);
  env.probe = { ...reply, ...evil };
  env.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: reply.shownUrl, pageUrl: 'https://www.cosmos.so/home', frameId: 4 }), { id: 5, title: 'x' });
  await until(() => env.log.downloads[0]);
  const entry = Object.values(data(env).ses.pending)[0];
  assert.deepEqual([entry.tabId, entry.frameId, entry.token, entry.savedFrom], [5, 4, null, 'context-menu']);
  assert.equal(entry.card.site, 'cosmos');
  await finishAll(env, [env.log.downloads[0].id]);
  await until(() => env.log.downloads[1]);
  assert.equal(cardOf(env.log.downloads[1]).saved_from, 'context-menu');
  await finishAll(env, [env.log.downloads[1].id]);
  await until(() => env.log.badges.length);
  assert.deepEqual(env.log.sent.map((m) => [m.tabId, m.msg.type]), [[5, 'probe-context']]); // nothing reached tab 999
  assert.ok(!JSON.stringify(data(env)).includes('evil'));

  // no tab at all (a context menu outside any tab) and a tab without id: a plain web image with null tab and token
  for (const tab of [undefined, {}]) {
    const web = makeEnv({ files: { 'https://example.com/a.png': 'image/png' } });
    await booted(web);
    const res = JSON.parse(JSON.stringify(await web.ctx.mbcMenuClick(menuInfo({ frameId: undefined }), tab)));
    assert.equal(res.status, 'pending');
    const pend = Object.values(data(web).ses.pending)[0];
    assert.deepEqual([pend.tabId, pend.frameId, pend.token, pend.savedFrom], [null, 0, null, 'context-menu']);
    assert.deepEqual(web.log.sent, []);
  }
  await noUnhandled();
  console.log('16 ok: a probe reply cannot choose the tab, frame, token, saved_from or site');
}

// 17. failing storage: every background entry point logs a warning and rejects nothing
{
  // (a) reconcile: load time, startup, alarm
  const boot = makeEnv({ flags: { storageFails: 'session' } });
  await until(() => boot.log.warns.length);
  assert.deepEqual(boot.log.warns, ['mbc reconcile Error: storage session']);
  boot.log.warns.length = 0;
  await Promise.all(boot.chrome.runtime.onStartup.fire());
  await Promise.all(boot.chrome.alarms.onAlarm.fire({ name: 'mbc-ui-restore' }));
  await until(() => boot.log.warns.length >= 2);
  assert.deepEqual(boot.log.warns, ['mbc reconcile Error: storage session', 'mbc reconcile Error: storage session']);
  boot.chrome.alarms.onAlarm.fire({ name: 'other' });
  await tick();
  assert.equal(boot.log.warns.length, 2);

  // (b) downloads.onChanged -> advance: first the image stage, then the card stage; the chain survives both
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg', [origJpg(2)]: 'image/jpeg' } });
  await booted(env);
  assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
  env.storageFails = 'session.get';
  await finishAll(env, [env.log.downloads[0].id]);
  assert.deepEqual(env.log.warns, ['mbc advance Error: storage session']);
  assert.equal(env.log.downloads.length, 1);
  env.storageFails = false;
  env.log.warns.length = 0;
  await finishAll(env, [env.log.downloads[0].id]); // the pending entry is still there: the same event goes through now
  assert.equal(env.log.downloads.length, 2);
  env.storageFails = 'local.set';
  await finishAll(env, [env.log.downloads[1].id]);
  assert.deepEqual(env.log.warns, ['mbc advance Error: storage local']);
  env.storageFails = false;
  env.log.warns.length = 0;
  assert.equal((await send(env, pinN(2), pinSender)).status, 'pending'); // the serial chain is still alive
  await finishAll(env, [env.log.downloads[2].id]);
  await finishAll(env, [env.log.downloads[3].id]);
  assert.equal(data(env).local.recent[0].status, 'ok');
  assert.deepEqual(env.log.warns, []);

  // (c) menuClick: storage fails before or inside the serialized part of clip()
  for (const failing of ['local', 'session.get']) {
    const menu = makeEnv({ files: { 'https://example.com/a.png': 'image/png' } });
    await booted(menu);
    menu.storageFails = failing;
    const [res] = await Promise.all(menu.chrome.contextMenus.onClicked.fire(menuInfo(), { id: 3, title: 'T' }));
    assert.deepEqual(JSON.parse(JSON.stringify(res)), { status: 'error', reason: failing === 'local' ? 'storage local' : 'storage session' });
    assert.deepEqual(menu.log.badges, ['✗']);
    assert.deepEqual(menu.log.warns.map((w) => w.split(' Error')[0]), ['mbc menu']);
  }
  await noUnhandled();
  console.log('17 ok: reconcile, onChanged->advance and menuClick survive failing storage with a warning only');
}

// 18. positive controls: real-world shapes that must keep passing validation
{
  // (a) a Pinterest save from a country subdomain
  const ruPin = 'https://ru.pinterest.com/pin/100000000000000001/';
  const ruMsg = { ...pinMsg, token: 'tok-ru', pageUrl: ruPin, key: '100000000000000001' };
  const ruSender = { tab: { id: 7 }, frameId: 0, url: ruPin };
  const env = makeEnv({ files: { 'https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg': 'image/jpeg' } });
  assert.equal((await send(env, ruMsg, ruSender)).status, 'pending');
  assert.equal(Object.values(data(env).ses.pending)[0].stage, 'image');
  await finishDl(env, env.log.downloads[0].id);
  assert.equal(cardOf(env.log.downloads[1]).page_url, ruPin);
  await finishDl(env, env.log.downloads[1].id);
  assert.deepEqual(clipResults(env), [['ok', null]]);
  for (const url of ['https://evilpinterest.com/pin/1/', 'https://pinterest.com.evil.example/pin/1/']) {
    const bad = makeEnv({ files: {} });
    assert.equal((await send(bad, { ...ruMsg, pageUrl: url }, { ...ruSender, url })).reason, 'unknown_site');
    assert.deepEqual(bad.log.fetches, []);
  }

  // (b) a Cosmos video poster: the original is the CDN address without the query
  const uuid = '5a3b9c0e-1d2f-4a6b-8c7d-9e0f1a2b3c4d';
  const poster = `https://cdn.cosmos.so/${uuid}?format=webp&w=400`;
  const cosmosPage = 'https://www.cosmos.so/e/1000000001';
  const cosmosSender = { tab: { id: 8 }, frameId: 0, url: cosmosPage };
  const videoMsg = { ...pinMsg, token: 'tok-v', site: 'cosmos', shownUrl: poster, pageUrl: cosmosPage, pageUrlKind: 'element', key: '1000000001', media: 'video-poster' };
  const video = makeEnv({ files: { [`https://cdn.cosmos.so/${uuid}`]: 'image/webp' } });
  assert.equal((await send(video, videoMsg, cosmosSender)).status, 'pending');
  assert.equal(video.log.downloads[0].url, `https://cdn.cosmos.so/${uuid}`);
  assert.match(video.log.downloads[0].filename, /-cosmos-1000000001\.webp$/);
  await finishDl(video, video.log.downloads[0].id);
  const videoCard = cardOf(video.log.downloads[1]);
  assert.deepEqual([videoCard.media, videoCard.asset_url, videoCard.page_url], ['video-poster', `https://cdn.cosmos.so/${uuid}`, cosmosPage]);
  await finishDl(video, video.log.downloads[1].id);
  assert.deepEqual(clipResults(video), [['ok', null]]);

  // (c) a Cosmos context-menu save: a reply shaped like cosmos.js `read()` passes validation and starts the download
  const menu = makeEnv({ files: { [`https://cdn.cosmos.so/${uuid}`]: 'image/webp' } });
  await booted(menu);
  menu.probe = { shownUrl: poster, srcset: null, pageUrl: cosmosPage, pageUrlKind: 'element', key: '1000000001', title: null, alt: null, author: 'someone', authorUrl: null, media: 'image' };
  menu.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: poster, pageUrl: cosmosPage, frameId: 0 }), { id: 8, title: 'Cosmos' });
  await until(() => menu.log.downloads[0]);
  assert.equal(menu.log.downloads[0].url, `https://cdn.cosmos.so/${uuid}`);
  assert.match(menu.log.downloads[0].filename, /-cosmos-1000000001\.webp$/);
  assert.deepEqual(menu.log.badges, []);
  assert.equal(Object.values(data(menu).ses.pending)[0].stage, 'image');
  await noUnhandled();
  console.log('18 ok: ru. pinterest, cosmos video poster and cosmos context menu are accepted; look-alike hosts are not');
}

// 19. the menu probe: a probe that rejects falls back to a plain web save; a missing frameId means the main frame
{
  const srcUrl = 'https://cdn.cosmos.so/x.jpg';
  const pageUrl = 'https://www.cosmos.so/home';
  const files = { [srcUrl]: 'image/jpeg' };
  const probesOf = (env) => env.log.sent.filter((s) => s.msg.type === 'probe-context');
  const settle = async (env) => {
    await finishAll(env, [env.log.downloads[0].id]);
    await until(() => env.log.downloads[1]);
    await finishAll(env, [env.log.downloads[1].id]);
    await until(() => env.log.badges.length);
  };

  // (a) no content script answers: the probe was tried in the clicked frame, then the image is saved as a plain web image
  const env = makeEnv({ files, flags: { probeFails: true } });
  await booted(env);
  env.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl, pageUrl, frameId: 3 }), { id: 6, title: 'T' });
  await until(() => env.log.downloads[0]);
  assert.equal(probesOf(env).length, 1);
  assert.deepEqual([probesOf(env)[0].tabId, probesOf(env)[0].opt.frameId], [6, 3]);
  const entry = Object.values(data(env).ses.pending)[0];
  assert.deepEqual([entry.tabId, entry.frameId, entry.token, entry.savedFrom], [6, 3, null, 'context-menu']);
  assert.deepEqual([entry.card.site, entry.card.page_url_kind, entry.card.page_url, entry.card.title], ['web', 'tab', pageUrl, 'T']);
  assert.equal(env.log.downloads[0].url, srcUrl);
  assert.match(env.log.downloads[0].filename, /-web-[0-9a-f]{10}\.jpg$/);
  await settle(env);
  assert.deepEqual(env.log.badges, ['✓']);
  assert.deepEqual(env.log.sent.map((m) => [m.tabId, m.msg.type]), [[6, 'probe-context']]); // no token: no clip-result either
  assert.deepEqual(data(env).ses.pending, {});
  assert.equal(data(env).local.recent[0].status, 'ok');
  await noUnhandled();

  // (b) the probe answers but the click carries no frameId: the worker names frame 0 itself, never undefined
  const env2 = makeEnv({ files });
  await booted(env2);
  env2.probe = { shownUrl: srcUrl, srcset: null, pageUrl: 'https://www.cosmos.so/e/abc', pageUrlKind: 'element', key: 'abc',
    title: null, alt: null, author: null, authorUrl: null, media: 'image' };
  env2.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl, pageUrl, frameId: undefined }), { id: 6, title: 'T' });
  await until(() => env2.log.downloads[0]);
  assert.equal(probesOf(env2).length, 1);
  const entry2 = Object.values(data(env2).ses.pending)[0];
  assert.deepEqual([entry2.tabId, entry2.frameId, entry2.token, entry2.savedFrom], [6, 0, null, 'context-menu']);
  assert.deepEqual([entry2.card.site, entry2.card.page_url_kind], ['cosmos', 'element']);
  await settle(env2);
  assert.deepEqual(env2.log.badges, ['✓']);
  assert.deepEqual(data(env2).ses.pending, {});
  await noUnhandled();
  console.log('19 ok: a failing probe falls back to a plain web save in the clicked frame; a missing frameId becomes 0');
}

// 20. the error path of attempt() survives a failing settleUi; notify only talks to a real tab id
{
  // (a) the download is refused AND settleUi rejects (alarms.clear): the caller still gets the download's own error
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg', 'https://example.com/a.png': 'image/png' } });
  await booted(env);
  env.failDownload = true;
  env.alarmClearFails = true;
  const r = await send(env, pinN(1), pinSender);
  assert.deepEqual([r.status, r.reason], ['error', 'boom']); // not 'alarm': the settleUi error is logged on its own
  assert.deepEqual(env.log.warns, ['mbc attempt ui Error: alarm']);
  assert.deepEqual(env.log.ui, [true, false, true]); // the shelf is shown again before alarms.clear fails
  assert.deepEqual([data(env).local.recent[0].status, data(env).local.recent[0].reason], ['error', 'boom']);
  assert.deepEqual([data(env).ses.pending ?? {}, data(env).ses.inflight ?? []], [{}, []]);
  assert.deepEqual(env.log.sent, []);

  // the same through the context menu: the result and the flash name the download error, not the alarm error
  env.log.warns.length = 0;
  const [res] = await Promise.all(env.chrome.contextMenus.onClicked.fire(menuInfo(), { id: 3, title: 'T' }));
  assert.deepEqual([res.status, res.reason], ['error', 'boom']);
  assert.deepEqual(env.log.badges, ['✗']);
  assert.deepEqual(env.log.warns, ['mbc attempt ui Error: alarm']);
  assert.deepEqual([data(env).local.recent[0].status, data(env).local.recent[0].reason], ['error', 'boom']);
  await noUnhandled();

  // (b) a sender whose tab id is not a non-negative integer: the save completes, but no clip-result is sent to it
  const env2 = makeEnv({ files: Object.fromEntries([21, 22, 23, 24].map((n) => [origJpg(n), 'image/jpeg'])) });
  await booted(env2);
  const save = async (n, sender, done) => {
    assert.equal((await send(env2, pinN(n), sender)).status, 'pending');
    const k = env2.log.downloads.length - 1;
    await finishAll(env2, [env2.log.downloads[k].id]);
    await until(() => env2.log.downloads[k + 1]);
    await finishAll(env2, [env2.log.downloads[k + 1].id]);
    await until(() => data(env2).local.recent?.length === done);
  };
  await save(21, { ...pinSender, tab: { id: 1.5 } }, 1);
  await save(22, { ...pinSender, tab: { id: '7' } }, 2);
  await save(23, { ...pinSender, tab: { id: -1 } }, 3);
  assert.deepEqual(env2.log.sent, []);
  assert.deepEqual(data(env2).local.recent.map((e) => e.status), ['ok', 'ok', 'ok']);
  assert.deepEqual([data(env2).ses.pending, data(env2).ses.inflight], [{}, []]);
  // positive control: the same save from a real tab id does reach its tab
  await save(24, pinSender, 4);
  await until(() => env2.log.sent.length);
  assert.deepEqual(env2.log.sent.map((s) => [s.tabId, s.msg.type, s.msg.token, s.msg.status]), [[7, 'clip-result', 'tok24', 'ok']]);
  await noUnhandled();
  console.log('20 ok: a rejecting settleUi cannot hide the error of a refused download; non-integer tab ids get no clip-result');
}

// 21. the menu also shows on links: a click without srcUrl asks the page for the image under the link
{
  const LINK = 'https://example.com/gallery/1';
  const IMG = 'https://cdn.example.com/work/1.png?w=800';
  const linkInfo = (extra = {}) => menuInfo({ srcUrl: undefined, linkUrl: LINK, ...extra });
  const json = (v) => JSON.parse(JSON.stringify(v));
  const failure = async (env, info, tab) => {
    const [res] = await Promise.all(env.chrome.contextMenus.onClicked.fire(info, tab));
    return json(res);
  };

  // (a) the first menu item is registered for images and for links (the Behance page item is covered in 22)
  const reg = makeEnv({});
  await Promise.all(reg.chrome.runtime.onInstalled.fire({}));
  assert.deepEqual(json(reg.log.menu)[0], { id: 'moodboard-clip', title: 'menuSave', contexts: ['image', 'link'] });

  // (b) link-only click on a web page: the injected function finds the image, a web card is saved from it
  const env = makeEnv({ files: { [IMG]: 'image/png' }, flags: { scriptResult: { url: IMG } } });
  await booted(env);
  env.chrome.contextMenus.onClicked.fire(linkInfo({ frameId: 2 }), { id: 3, title: 'Behance' });
  await until(() => env.log.downloads[0]);
  assert.equal(env.log.scripts.length, 1);
  const call = env.log.scripts[0];
  assert.deepEqual(json(call.target), { tabId: 3, frameIds: [2] });
  assert.deepEqual(json(call.args), [LINK]);
  assert.equal(call.func, env.ctx.MoodboardClip.findImageUnderLink);
  assert.equal(call.world, undefined); // the default isolated world
  assert.equal(env.log.downloads[0].url, IMG);
  assert.match(env.log.downloads[0].filename, /^moodboard-inbox\/unsorted\/.*-web-[0-9a-f]{10}\.png$/);
  assert.deepEqual(env.log.sent, []); // example.com has no content script to probe
  await finishDl(env, env.log.downloads[0].id);
  await until(() => env.log.downloads[1]);
  await finishDl(env, env.log.downloads[1].id);
  const card = cardOf(env.log.downloads[1]);
  assert.deepEqual([card.site, card.saved_from, card.asset_url, card.page_url, card.title], ['web', 'context-menu', IMG.split('?')[0], 'https://example.com/p', 'Behance']);
  assert.deepEqual(env.log.badges, ['✓']);
  assert.equal(data(env).local.recent[0].status, 'ok');
  await noUnhandled();

  // (c) the script finds nothing, or answers with something that is not an address: no download, a recorded error, a red badge
  const NO_IMAGE = 'no_image_under_link';
  const rejected = async (flags, reason, label) => {
    const none = makeEnv({ flags });
    await booted(none);
    const res = await failure(none, linkInfo(), { id: 3, title: 'Текст' });
    assert.deepEqual(res, { status: 'error', reason }, label);
    assert.deepEqual([none.log.downloads, none.log.fetches, none.log.badges], [[], [], ['✗']], label);
    const [entry] = data(none).local.recent;
    assert.deepEqual([entry.board, entry.site, entry.title, entry.id, entry.status, entry.reason], ['unsorted', 'web', 'Текст', null, 'error', reason], label);
    assert.equal(data(none).local.recent.length, 1, label);
    assert.deepEqual([data(none).local.seen ?? [], data(none).local.counts ?? {}], [[], {}], label);
  };
  for (const result of [null, undefined, 42, 'https://cdn.example.com/a.png', {}, { miss: 'none' }, { miss: 'other' }, { url: 42 }, { url: '' }, { url: null }]) {
    await rejected({ scriptResult: result }, NO_IMAGE, JSON.stringify(result) ?? 'undefined');
  }
  // a results array that carries no answer at all: no frame ran the script, or the frame answered with an empty object
  await rejected({ scriptRaw: [] }, NO_IMAGE, 'scriptRaw []');
  await rejected({ scriptRaw: [{}] }, NO_IMAGE, 'scriptRaw [{}]');
  await rejected({ scriptRaw: null }, NO_IMAGE, 'scriptRaw null');
  // several different images could be meant: its own reason, nothing saved
  await rejected({ scriptResult: { miss: 'many' } }, 'many_images_under_link', 'many');
  const named = makeEnv({ store: { activeBoard: 'Кино 2026!' }, flags: { scriptResult: null } });
  await booted(named);
  await failure(named, linkInfo({ pageUrl: 'https://www.pinterest.com/pin/1/' }), { id: 3, title: 'T' });
  assert.deepEqual([data(named).local.recent[0].board, data(named).local.recent[0].site], ['кино-2026', 'pinterest']);

  // (d) the page cannot be scripted, or the tab id is unusable: the same kind of failure, with its own reason
  const denied = makeEnv({ flags: { scriptFails: true } });
  await booted(denied);
  const refused = await failure(denied, linkInfo(), { id: 3, title: 'T' });
  assert.deepEqual(refused, { status: 'error', reason: 'no_page_access' });
  assert.deepEqual([denied.log.scripts.length, denied.log.downloads, denied.log.badges], [1, [], ['✗']]);
  assert.deepEqual([data(denied).local.recent[0].status, data(denied).local.recent[0].reason, data(denied).local.recent[0].id], ['error', 'no_page_access', null]);
  await noUnhandled();
  for (const tab of [undefined, { title: 'T' }, { id: -1, title: 'T' }, { id: 1.5, title: 'T' }, { id: '3', title: 'T' }]) {
    const bad = makeEnv({ flags: { scriptResult: { url: IMG } } });
    await booted(bad);
    const res = await failure(bad, linkInfo(), tab);
    assert.deepEqual(res, { status: 'error', reason: 'no_page_access' });
    assert.deepEqual([bad.log.scripts, bad.log.downloads, bad.log.badges], [[], [], ['✗']]);
    assert.equal(data(bad).local.recent[0].reason, 'no_page_access');
  }
  await noUnhandled();

  // (e) a click on a real image never touches the page: srcUrl present means exactly the old behaviour
  const direct = makeEnv({ files: { 'https://example.com/a.png': 'image/png' }, flags: { scriptResult: { url: IMG } } });
  await booted(direct);
  direct.chrome.contextMenus.onClicked.fire(menuInfo({ linkUrl: LINK }), { id: 3, title: 'T' });
  await until(() => direct.log.downloads[0]);
  assert.deepEqual([direct.log.scripts, direct.log.downloads[0].url], [[], 'https://example.com/a.png']);
  // and with neither srcUrl nor linkUrl the click ends as the old validation error (a missing address), still without the page
  const neither = makeEnv({ flags: { scriptResult: { url: IMG } } });
  await booted(neither);
  const res = await failure(neither, menuInfo({ srcUrl: undefined }), { id: 3, title: 'T' });
  assert.deepEqual([res.status, res.reason, neither.log.scripts, neither.log.badges], ['error', 'bad_request', [], ['✗']]);

  // (f) link-only click on a Pinterest page: the found address goes through the content-script probe like a clicked image
  const shown = 'https://i.pinimg.com/236x/ab/cd/ef/abcdef.jpg';
  const pinPage = 'https://www.pinterest.com/pin/123/';
  const pin = makeEnv({ files: { 'https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg': 'image/jpeg' }, flags: { scriptResult: { url: shown } } });
  await booted(pin);
  pin.probe = { shownUrl: shown, srcset: null, pageUrl: pinPage, pageUrlKind: 'pin', key: '123', title: 'Pin', alt: 'A', author: 'Au', authorUrl: null, media: 'image' };
  pin.chrome.contextMenus.onClicked.fire(linkInfo({ linkUrl: pinPage, pageUrl: pinPage }), { id: 7, title: 'x' });
  await until(() => pin.log.downloads[0]);
  assert.equal(pin.log.scripts.length, 1);
  assert.deepEqual(json(pin.log.sent.map((m) => [m.tabId, m.msg, m.opt])), [[7, { type: 'probe-context', srcUrl: shown, byUrl: true }, { frameId: 0 }]]);
  assert.match(pin.log.downloads[0].filename, /-pinterest-123\.jpg$/);
  const pinEntry = Object.values(data(pin).ses.pending)[0];
  assert.deepEqual([pinEntry.card.site, pinEntry.card.page_url_kind, pinEntry.card.title, pinEntry.savedFrom, pinEntry.token, pinEntry.frameId], ['pinterest', 'pin', 'Pin', 'context-menu', null, 0]);
  // (g) a click on the image itself (srcUrl present, even inside a link) probes by the click, never by address: no byUrl key at all
  const clicked = makeEnv({ files: { 'https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg': 'image/jpeg' }, flags: { scriptResult: { url: 'https://i.pinimg.com/236x/other.jpg' } } });
  await booted(clicked);
  clicked.probe = { ...pin.probe };
  clicked.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: shown, linkUrl: pinPage, pageUrl: pinPage, frameId: 0 }), { id: 7, title: 'x' });
  await until(() => clicked.log.downloads[0]);
  assert.deepEqual([clicked.log.scripts, json(clicked.log.sent.map((m) => m.msg))], [[], [{ type: 'probe-context', srcUrl: shown }]]);
  assert.equal('byUrl' in clicked.log.sent[0].msg, false);
  // (h) a click without frameId runs the script in the main frame, never in [undefined]
  const noFrame = makeEnv({ flags: { scriptResult: null } });
  await booted(noFrame);
  await failure(noFrame, linkInfo({ frameId: undefined }), { id: 3, title: 'T' });
  assert.deepEqual(json(noFrame.log.scripts[0].target), { tabId: 3, frameIds: [0] });
  // storage that fails while the error is being recorded still ends as a warning and a red badge, never a rejection
  const broken = makeEnv({ flags: { scriptResult: null } });
  await booted(broken);
  broken.storageFails = 'local';
  const gone = await failure(broken, linkInfo(), { id: 3, title: 'T' });
  assert.deepEqual([gone.status, broken.log.badges, broken.log.warns.map((w) => w.split(' Error')[0])], ['error', ['✗'], ['mbc menu']]);
  await noUnhandled();
  console.log('21 ok: link menu — image found under the link, failures recorded, srcUrl path untouched, pinterest probe on the found address');
}

// 22. the page item on Behance: a right click on a grid module reports the page context, the content script knows the point
{
  const PAGE = 'https://www.behance.net/gallery/123/Work';
  const IMG = 'https://mir-s3-cdn-cf.behance.net/project_modules/max_1200/abc.jpg';
  const json = (v) => JSON.parse(JSON.stringify(v));
  const pageInfo = (extra = {}) => menuInfo({ menuItemId: 'moodboard-clip-page', srcUrl: undefined, pageUrl: PAGE, ...extra });
  const failure = async (env, info, tab) => {
    const [res] = await Promise.all(env.chrome.contextMenus.onClicked.fire(info, tab));
    return json(res);
  };

  // (a) registration: second item, the same title, the page context only, and only on Behance
  const reg = makeEnv({});
  await Promise.all(reg.chrome.runtime.onInstalled.fire({}));
  assert.deepEqual(json(reg.log.menu), [
    { id: 'moodboard-clip', title: 'menuSave', contexts: ['image', 'link'] },
    { id: 'moodboard-clip-page', title: 'menuSave', contexts: ['page'], documentUrlPatterns: ['https://*.behance.net/*'] },
  ]);

  // (b) the content script answers with an address: one plain web clip, saved from the context menu
  const env = makeEnv({ files: { [IMG]: 'image/jpeg' }, flags: { atPoint: { url: IMG } } });
  await booted(env);
  env.chrome.contextMenus.onClicked.fire(pageInfo({ frameId: 0 }), { id: 5, title: 'Work on Behance' });
  await until(() => env.log.downloads[0]);
  assert.deepEqual(json(env.log.sent.map((m) => [m.tabId, m.msg, m.opt])), [[5, { type: 'image-at-point' }, { frameId: 0 }]]);
  assert.deepEqual(env.log.scripts, []); // no injection: the content script already knows where the click was
  assert.equal(env.log.downloads[0].url, IMG);
  assert.match(env.log.downloads[0].filename, /^moodboard-inbox\/unsorted\/.*-web-[0-9a-f]{10}\.jpg$/);
  await finishDl(env, env.log.downloads[0].id);
  await until(() => env.log.downloads[1]);
  await finishDl(env, env.log.downloads[1].id);
  const card = cardOf(env.log.downloads[1]);
  assert.deepEqual([card.site, card.saved_from, card.asset_url, card.page_url, card.title], ['web', 'context-menu', IMG, PAGE, 'Work on Behance']);
  assert.deepEqual(env.log.badges, ['✓']);
  assert.equal(data(env).local.recent[0].status, 'ok');
  assert.equal(data(env).local.recent.length, 1); // exactly one clip request
  await noUnhandled();

  // (c) a click without frameId asks the main frame, never [undefined]
  const noFrame = makeEnv({ flags: { atPoint: null } });
  await booted(noFrame);
  await failure(noFrame, pageInfo({ frameId: undefined }), { id: 5, title: 'T' });
  assert.deepEqual(json(noFrame.log.sent[0].opt), { frameId: 0 });
  // and a click in a sub-frame asks that frame
  const sub = makeEnv({ flags: { atPoint: null } });
  await booted(sub);
  await failure(sub, pageInfo({ frameId: 7 }), { id: 5, title: 'T' });
  assert.deepEqual(json(sub.log.sent[0].opt), { frameId: 7 });

  // (d) no content script on the tab (opened before the extension was reloaded): a hint to refresh, a red badge, nothing saved
  const noReceiver = makeEnv({ flags: { atPointFails: true } });
  await booted(noReceiver);
  const lost = await failure(noReceiver, pageInfo(), { id: 5, title: 'Работа' });
  assert.equal(lost.status, 'error');
  assert.match(lost.reason, /^reload_page$/);
  assert.deepEqual([noReceiver.log.downloads, noReceiver.log.fetches, noReceiver.log.badges], [[], [], ['✗']]);
  const [lostEntry] = data(noReceiver).local.recent;
  assert.deepEqual([lostEntry.site, lostEntry.title, lostEntry.id, lostEntry.status], ['web', 'Работа', null, 'error']);
  assert.match(lostEntry.reason, /^reload_page$/);

  // (e) several different images under the point, and every answer that carries no address
  const rejected = async (reply, reason, label) => {
    const none = makeEnv({ flags: { atPoint: reply } });
    await booted(none);
    const res = await failure(none, pageInfo(), { id: 5, title: 'Текст' });
    assert.deepEqual(res, { status: 'error', reason }, label);
    assert.deepEqual([none.log.downloads, none.log.fetches, none.log.badges], [[], [], ['✗']], label);
    assert.equal(data(none).local.recent.length, 1, label);
    assert.equal(data(none).local.recent[0].reason, reason, label);
  };
  await rejected({ miss: 'many' }, 'many_images_at_point', 'many');
  for (const reply of [undefined, null, 42, 'https://x.test/a.jpg', {}, { miss: 'none' }, { miss: 'other' }, { url: 42 }, { url: '' }, { url: null }]) {
    await rejected(reply, 'no_image_at_point', JSON.stringify(reply) ?? 'undefined');
  }

  // (f) an unusable tab id never reaches the content script
  for (const tab of [undefined, { title: 'T' }, { id: -1, title: 'T' }, { id: 1.5, title: 'T' }, { id: '5', title: 'T' }]) {
    const bad = makeEnv({ flags: { atPoint: { url: IMG } } });
    await booted(bad);
    const res = await failure(bad, pageInfo(), tab);
    assert.deepEqual(res, { status: 'error', reason: 'no_page_access' });
    assert.deepEqual([bad.log.sent, bad.log.downloads, bad.log.badges], [[], [], ['✗']]);
  }

  // (g) the image/link item is untouched: a click on an image never messages the page for a point
  const direct = makeEnv({ files: { 'https://example.com/a.png': 'image/png' }, flags: { atPoint: { url: IMG } } });
  await booted(direct);
  direct.chrome.contextMenus.onClicked.fire(menuInfo(), { id: 5, title: 'T' });
  await until(() => direct.log.downloads[0]);
  assert.deepEqual([direct.log.sent, direct.log.downloads[0].url], [[], 'https://example.com/a.png']);

  // (h) any other menu id is ignored
  const other = makeEnv({ flags: { atPoint: { url: IMG } } });
  await booted(other);
  const ignored = await Promise.all(other.chrome.contextMenus.onClicked.fire(menuInfo({ menuItemId: 'something-else' }), { id: 5, title: 'T' }));
  assert.deepEqual([ignored.map((r) => r ?? null), other.log.sent, other.log.downloads, other.log.badges], [[null], [], [], []]);
  await noUnhandled();
  console.log('22 ok: behance page item — registered for the page context on behance.net only, the point answer is clipped as a web card, failures recorded');
}

// 23. the browser asks where to save: the picture lands outside moodboard-inbox/<board>/, so no card follows and the entry is an error
{
  const ASKS = 'browser_asks_where_to_save';
  // A web save through the menu; `place(id, board)` plays the browser and names the saved file, `error` interrupts the image instead.
  const saved = async (place, { store = {}, error } = {}) => {
    const env = makeEnv({ store: { ...store } }); // makeEnv writes into the object it is given
    env.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: 'https://example.com/photo.jpg' }), { id: 3, title: 'T' });
    await until(() => env.log.downloads[0]);
    const d = env.log.downloads[0];
    const [, board, file] = d.filename.split('/');
    const id = file.replace(/\.jpg$/, '');
    if (place) env.downloadsItems[d.id].filename = place(id, board);
    await finishDl(env, d.id, error ? 'interrupted' : 'complete', error);
    if (env.log.downloads[1]) await finishDl(env, env.log.downloads[1].id);
    return { env, id, board, recent: env.chrome.storage.local.data.recent[0] };
  };
  const refused = ({ env, recent }) => {
    assert.equal(env.log.downloads.length, 1);
    assert.deepEqual([recent.status, recent.reason], ['error', ASKS]);
  };
  const accepted = ({ env, recent }) => {
    assert.equal(env.log.downloads.length, 2);
    assert.match(env.log.downloads[1].filename, /\.json$/);
    assert.deepEqual([recent.status, recent.reason], ['ok', null]);
  };

  // (a) the dialog sent the picture to Downloads under the site's own name: no card, an error, nothing remembered as saved
  const a = await saved(() => '/home/x/Downloads/picture-named-by-the-site.jpeg');
  refused(a);
  {
    const { local, ses } = data(a.env);
    assert.deepEqual([ses.pending, ses.inflight], [{}, []]);
    assert.deepEqual([local.seen ?? [], local.counts ?? {}], [[], {}]);
    assert.deepEqual(a.env.log.badges, ['✗']);
    assert.equal(a.env.log.ui.at(-1), true);
    // the picture is not marked as saved: the same click starts a fresh image download
    a.env.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl: 'https://example.com/photo.jpg' }), { id: 3, title: 'T' });
    await until(() => a.env.log.downloads[1]);
    assert.match(a.env.log.downloads[1].filename, /\.jpg$/);
  }

  // (b) the right file name in the wrong place
  refused(await saved((id) => `/home/x/Desktop/${id}.jpg`));
  refused(await saved((id) => `/home/x/Downloads/moodboard-inbox/other/${id}.jpg`));
  refused(await saved(() => '/home/x/Downloads/moodboard-inbox/unsorted/other.jpg'));
  refused(await saved((id) => `/home/x/Downloads/moodboard-inbox/unsorted/${id} (1).jpg`));
  refused(await saved((id) => `/home/x/Downloads/moodboard-inbox/unsorted/${id}`));
  refused(await saved((id) => `/home/x/Downloads/moodboard-inbox/unsorted/sub/${id}.jpg`));
  refused(await saved((id) => `/home/x/Downloads/moodboard-inbox-old/unsorted/${id}.jpg`));
  refused(await saved((id) => `${id}.jpg`));

  // (c) a Windows path, a POSIX path and a relative name all count as in the board
  accepted(await saved((id) => `C:\\Users\\x\\Downloads\\moodboard-inbox\\unsorted\\${id}.jpg`));
  accepted(await saved((id) => `/home/x/Downloads/moodboard-inbox/unsorted/${id}.jpg`));
  accepted(await saved((id) => `moodboard-inbox/unsorted/${id}.jpg`));
  accepted(await saved((id) => `moodboard-inbox\\unsorted\\${id}.jpg`));

  // (d) a Cyrillic board whose folder name the file system hands back decomposed
  {
    const store = { activeBoard: 'Ёжик-Йога' };
    const probe = await saved(null, { store });
    assert.equal(probe.board, 'ёжик-йога');
    const nfd = probe.board.normalize('NFD');
    assert.notEqual(nfd, probe.board);
    accepted(await saved((id, board) => `/home/x/Downloads/moodboard-inbox/${board.normalize('NFD')}/${id}.jpg`, { store }));
    accepted(await saved((id, board) => `/home/x/Downloads/moodboard-inbox/${board}/${id}.jpg`, { store }));
    refused(await saved((id) => `/home/x/Downloads/moodboard-inbox/${'кино'.normalize('NFD')}/${id}.jpg`, { store }));
  }

  // (e) the dialog was cancelled: a user cancel almost always means that dialog, any other error stays as it is
  const cancelled = await saved(null, { error: 'USER_CANCELED' });
  refused(cancelled);
  assert.deepEqual([cancelled.env.log.ui.at(-1), data(cancelled.env).local.seen ?? []], [true, []]);
  const failed = await saved(null, { error: 'NETWORK_FAILED' });
  assert.deepEqual([failed.recent.status, failed.recent.reason], ['error', 'NETWORK_FAILED']);
  // the card stage too
  {
    const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' } });
    assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
    await finishDl(env, env.log.downloads[0].id);
    await finishDl(env, env.log.downloads[1].id, 'interrupted', 'USER_CANCELED');
    assert.deepEqual(clipResults(env), [['error', ASKS]]);
    const { local, ses } = data(env);
    assert.deepEqual([local.recent[0].reason, local.seen ?? [], ses.pending, ses.inflight], [ASKS, [], {}, []]);
  }
  await noUnhandled();
  console.log('23 ok: a picture saved outside moodboard-inbox/<board>/ or a cancelled save ends as browser_asks_where_to_save, nothing is marked as saved');
}

// --- Own folder mode (File System Access): a save is written straight into <folder>/<board>/, no download starts ---

const fsError = (name, message = name) => new DOMException(message, name);
const text = (u8) => new TextDecoder().decode(u8);
const bytesOf = async (chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk instanceof Blob ? Buffer.from(await chunk.arrayBuffer()) : Buffer.from(chunk));

// What FileSystemFileHandle.createWritable() returns: a WritableStream that also takes write(data). Like the real one it
// commits only on close; a write that throws leaves the empty file that getFileHandle({ create: true }) already made.
class FakeWritable extends WritableStream {
  constructor(root, dir, name) {
    const parts = [];
    super({
      async write(chunk) {
        const error = root.failWrite?.(name);
        if (error) throw error;
        parts.push(await bytesOf(chunk));
      },
      close() {
        dir.files.set(name, Buffer.concat(parts));
        root.ops.push(['commit', dir.name, name]);
      },
    });
  }
  async write(data) {
    const writer = this.getWriter();
    try { await writer.write(data); } finally { writer.releaseLock(); }
  }
}

// An in-memory FileSystemDirectoryHandle. `permission` is what queryPermission answers, `failDir` an error for
// getDirectoryHandle, `failWrite(fileName)` an error (or null) for the next chunk of that file; `ops` is the order in which
// things reached the "disk".
function makeRoot({ permission = 'granted', name = 'Boards' } = {}) {
  const dirs = new Map();
  const root = {
    kind: 'directory', name, permission, dirs, ops: [], queries: [], failDir: null, failWrite: null,
    async queryPermission(descriptor) { root.queries.push(descriptor); return root.permission; },
    async getDirectoryHandle(dirName, { create = false } = {}) {
      if (root.failDir) throw root.failDir;
      let dir = dirs.get(dirName);
      if (!dir) {
        if (!create) throw fsError('NotFoundError', `${dirName} not found`);
        const files = new Map();
        dir = {
          kind: 'directory', name: dirName, files,
          async getFileHandle(fileName, { create: make = false } = {}) {
            if (!files.has(fileName)) {
              if (!make) throw fsError('NotFoundError', `${fileName} not found`);
              files.set(fileName, Buffer.alloc(0));
              root.ops.push(['create', dirName, fileName]);
            }
            return { kind: 'file', name: fileName, createWritable: async () => new FakeWritable(root, dir, fileName) };
          },
          async removeEntry(fileName) {
            if (!files.delete(fileName)) throw fsError('NotFoundError', `${fileName} not found`);
            root.ops.push(['remove', dirName, fileName]);
          },
        };
        dirs.set(dirName, dir);
        root.ops.push(['mkdir', dirName]);
      }
      return dir;
    },
  };
  return root;
}

const commits = (root) => root.ops.filter(([op]) => op === 'commit').map(([, , file]) => file);
const removed = (root) => root.ops.filter(([op]) => op === 'remove').map(([, , file]) => file).sort();
// An environment in folder mode: `folder` is in storage, the fake handle is what getRoot() returns.
const folderEnv = ({ root = makeRoot(), files = {}, store = {}, session = {}, flags = {} } = {}) =>
  makeEnv({ store: { folder: { name: root.name }, ...store }, session, files, flags: { root, ...flags } });
// Boot (load-time reconcile and folder check) is over.
const bootedFolder = async (env) => { await booted(env); await tick(); };
// The n-th save has been recorded and its notices are out; returns the newest recent entry.
const settled = async (env, n = 1) => {
  await until(() => (data(env).local.recent ?? []).length >= n);
  await tick();
  return data(env).local.recent[0];
};
const clickWeb = (env, srcUrl, tab = { id: 3, title: 'T' }) => env.chrome.contextMenus.onClicked.fire(menuInfo({ srcUrl }), tab);
const ownSender = { url: 'chrome-extension://test/src/popup.html' };
const PIC = [1, 2, 3, 4, 5, 6];

// 24. folder mode, feed button: the picture goes into <folder>/<board>/ first, the card last; no download starts
{
  // (a) Pinterest into the default board, the body streamed straight into the file
  const root = makeRoot();
  const env = folderEnv({ root, files: { [origJpg(1)]: { type: 'image/jpeg', bytes: PIC } } });
  await bootedFolder(env);
  const res = await send(env, pinN(1), pinSender);
  assert.equal(res.status, 'pending');
  const recent = await settled(env);
  assert.deepEqual([recent.status, recent.reason, recent.board, recent.site, recent.id], ['ok', null, 'unsorted', 'pinterest', res.id]);
  const dir = root.dirs.get('unsorted');
  assert.deepEqual([...root.dirs.keys()], ['unsorted']);
  assert.deepEqual([...dir.files.keys()].sort(), [`${res.id}.jpg`, `${res.id}.json`]);
  assert.deepEqual(commits(root), [`${res.id}.jpg`, `${res.id}.json`], 'the card is committed last');
  assert.deepEqual([...dir.files.get(`${res.id}.jpg`)], PIC);
  const card = JSON.parse(text(dir.files.get(`${res.id}.json`)));
  assert.deepEqual(
    [card.id, card.file, card.board, card.site, card.asset_url, card.saved_from],
    [res.id, `${res.id}.jpg`, 'unsorted', 'pinterest', origJpg(1), 'feed-button'],
  );
  assert.deepEqual(env.log.downloads, []);
  assert.ok(!env.log.ui.includes(false), 'the download shelf is never hidden in folder mode');
  assert.deepEqual(env.log.fetchInit.filter((f) => f.method === 'GET').map((f) => [f.url, f.credentials]), [[origJpg(1), 'omit']]);
  assert.deepEqual(root.queries.every((q) => q.mode === 'readwrite'), true);
  const sent = env.log.sent.find((s) => s.msg.type === 'clip-result');
  assert.deepEqual([sent.tabId, sent.msg.token, sent.msg.status, sent.msg.reason], [7, 'tok1', 'ok', null]);
  const { local, ses } = data(env);
  assert.deepEqual([local.counts.unsorted, local.seen.length, ses.pending, ses.inflight], [1, 1, {}, []]);
  // saved once: the same click again is a repeat and writes nothing
  assert.equal((await send(env, { ...pinN(1), token: 'again' }, pinSender)).status, 'repeat');
  assert.equal(commits(root).length, 2);

  // (b) Cosmos into a Cyrillic board; a response without a streamable body goes through blob()
  const { cosmosOriginal } = createRequire(import.meta.url)('../../src/lib/original.js');
  const cosmosMsg = { ...pinMsg, token: 'tok-c', site: 'cosmos', shownUrl: 'https://cdn.cosmos.so/u1?format=jpeg&w=400',
    pageUrl: 'https://www.cosmos.so/e/u1', pageUrlKind: 'element', key: 'u1' };
  const best = cosmosOriginal(cosmosMsg.shownUrl, null);
  const root2 = makeRoot();
  const env2 = folderEnv({ root: root2, store: { activeBoard: 'Кино 2026!' }, files: { [best]: { type: 'image/webp', bytes: PIC, noStream: true } } });
  await bootedFolder(env2);
  const res2 = await send(env2, cosmosMsg, { tab: { id: 8 }, frameId: 0, url: 'https://www.cosmos.so/home' });
  assert.equal(res2.status, 'pending');
  assert.deepEqual([(await settled(env2)).status, env2.log.downloads], ['ok', []]);
  const dir2 = root2.dirs.get('кино-2026');
  assert.deepEqual([...dir2.files.keys()].sort(), [`${res2.id}.json`, `${res2.id}.webp`]);
  assert.deepEqual([...dir2.files.get(`${res2.id}.webp`)], PIC);
  assert.equal(JSON.parse(text(dir2.files.get(`${res2.id}.json`))).file, `${res2.id}.webp`);
  await noUnhandled();
  console.log('24 ok: folder save from the feed button — picture then card, card.file matches, no download, credentials omitted, repeat writes nothing');
}

// 25. a web picture whose address has no extension is named after the response's content type
{
  const cases = [
    // [address, content type, file extension]
    ['https://example.com/photo?id=7', 'image/webp', 'webp'],
    ['https://example.com/photo?id=7', 'image/jpeg; charset=binary', 'jpg'],
    ['https://example.com/photo?id=7', 'application/octet-stream', 'img'],
    ['https://example.com/photo?id=7', null, 'img'],
    ['https://example.com/photo.png?id=7', 'image/webp', 'png'], // an extension in the address wins
  ];
  for (const [url, type, ext] of cases) {
    const root = makeRoot();
    const env = folderEnv({ root, files: { [url]: { type, bytes: PIC } } });
    await bootedFolder(env);
    clickWeb(env, url);
    const recent = await settled(env);
    const label = `${url} ${type}`;
    assert.deepEqual([recent.status, recent.reason], ['ok', null], label);
    const dir = root.dirs.get('unsorted');
    assert.deepEqual([...dir.files.keys()].sort(), [`${recent.id}.json`, `${recent.id}.${ext}`].sort(), label);
    assert.equal(JSON.parse(text(dir.files.get(`${recent.id}.json`))).file, `${recent.id}.${ext}`, label);
    assert.deepEqual([...dir.files.get(`${recent.id}.${ext}`)], PIC, label);
    assert.deepEqual(env.log.downloads, [], label);
    assert.deepEqual(env.log.badges.slice(-1), ['✓'], label);
  }
  await noUnhandled();
  console.log('25 ok: an extension-less web picture takes its extension from Content-Type; the address wins when it has one');
}

// 26. the grant has lapsed: nothing is fetched or written, the badge asks for "Connect folder"
{
  for (const state of ['prompt', 'denied']) {
    const root = makeRoot();
    const env = folderEnv({ root, files: { [origJpg(1)]: { type: 'image/jpeg', bytes: PIC } } });
    await bootedFolder(env);
    assert.deepEqual(env.log.badges, [''], 'granted at boot: no badge');
    root.permission = state;
    assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
    const recent = await settled(env);
    assert.deepEqual([recent.status, recent.reason], ['error', 'folder_not_connected'], state);
    assert.deepEqual([root.ops, root.dirs.size], [[], 0], state);
    assert.deepEqual(env.log.fetches, [`HEAD ${origJpg(1)}`], 'the picture itself is not fetched');
    assert.deepEqual([env.log.badges, env.shown], [['', '!'], '!'], state);
    assert.deepEqual(clipResults(env), [['error', 'folder_not_connected']], state);
    const { local, ses } = data(env);
    assert.deepEqual([local.seen ?? [], local.counts ?? {}, ses.pending, ses.inflight], [[], {}, {}, []], state);
    assert.deepEqual(env.log.downloads, [], state);

    // a context-menu save flashes ✗ and falls back to the '!' of the folder, not to an empty badge
    clickWeb(env, 'https://example.com/a.png');
    await settled(env, 2);
    assert.equal(data(env).local.recent[0].reason, 'folder_not_connected');
    assert.deepEqual(env.log.badges.slice(-2), ['!', '✗']);
    env.log.later.forEach((fn) => fn());
    assert.deepEqual([env.log.badges.slice(-1), env.shown], [['!'], '!'], state);
    assert.deepEqual(root.ops, []);
  }
  await noUnhandled();
  console.log('26 ok: a folder that is not granted writes nothing, fetches nothing, and keeps "!" on the badge');
}

// 27. the folder is gone: a missing board folder or a lost handle reads as folder_missing
{
  // (a) getDirectoryHandle: NotFoundError although the grant says granted
  const root = makeRoot();
  root.failDir = fsError('NotFoundError', 'A requested file or directory could not be found');
  const env = folderEnv({ root, files: { [origJpg(1)]: { type: 'image/jpeg', bytes: PIC } } });
  await bootedFolder(env);
  assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
  const recent = await settled(env);
  assert.deepEqual([recent.status, recent.reason], ['error', 'folder_missing']);
  assert.deepEqual([root.ops, clipResults(env), env.log.downloads, data(env).local.seen ?? []], [[], [['error', 'folder_missing']], [], []]);
  assert.deepEqual(env.log.badges, [''], 'a missing folder is not a grant problem: no "!"');
  assert.deepEqual([data(env).ses.pending, data(env).ses.inflight], [{}, []]);

  // (b) the handle is no longer in the browser's storage while `folder` still says one was chosen
  const lost = folderEnv({ files: { [origJpg(1)]: { type: 'image/jpeg', bytes: PIC } }, flags: { root: null } });
  await bootedFolder(lost);
  assert.equal((await send(lost, pinN(1), pinSender)).status, 'pending');
  assert.deepEqual([(await settled(lost)).reason, lost.log.downloads, lost.log.fetches], ['folder_missing', [], [`HEAD ${origJpg(1)}`]]);

  // (c) a grant that lapses between the permission check and the board folder is still a reason code, not a stuck entry
  const racing = makeRoot();
  racing.failDir = fsError('NotAllowedError');
  const env3 = folderEnv({ root: racing, files: { [origJpg(1)]: { type: 'image/jpeg', bytes: PIC } } });
  await bootedFolder(env3);
  await send(env3, pinN(1), pinSender);
  assert.equal((await settled(env3)).reason, 'folder_not_connected');
  assert.equal(env3.shown, '!');
  assert.deepEqual([data(env3).ses.pending, data(env3).ses.inflight], [{}, []]);
  await noUnhandled();
  console.log('27 ok: NotFoundError on the board folder and a lost handle give folder_missing; a lapsed grant there gives folder_not_connected and "!"; nothing is left in flight');
}

// 28. the picture cannot be fetched: web saves tell a missing site permission from an unavailable picture
{
  const url = 'https://example.com/photo.png';
  const attempts = [
    // [label, spec, host access, reason, permission asked about]
    ['network error, no access to the host', 'reject', false, 'site_access_needed', [{ origins: ['https://example.com/*'] }]],
    ['network error, access granted', 'reject', true, 'image_unavailable', [{ origins: ['https://example.com/*'] }]],
    ['HTTP 404', { type: 'text/html', status: 404 }, false, 'image_unavailable', []],
    ['HTTP 500 with access', { status: 500 }, true, 'image_unavailable', []],
    ['not in the mock at all (404)', undefined, false, 'image_unavailable', []],
  ];
  for (const [label, spec, access, reason, asked] of attempts) {
    const root = makeRoot();
    const env = folderEnv({ root, files: spec === undefined ? {} : { [url]: spec }, flags: { hostAccess: access } });
    await bootedFolder(env);
    clickWeb(env, url);
    const recent = await settled(env);
    assert.deepEqual([recent.status, recent.reason], ['error', reason], label);
    assert.deepEqual(JSON.parse(JSON.stringify(env.log.permissionChecks)), asked, label);
    assert.deepEqual([root.ops, root.dirs.size, env.log.downloads], [[], 0, []], label);
    assert.deepEqual(env.log.badges.slice(-1), ['✗'], label);
    const { local, ses } = data(env);
    assert.deepEqual([local.seen ?? [], local.counts ?? {}, ses.pending, ses.inflight], [[], {}, {}, []], label);
  }
  // a feed site is never blamed on host access: the probe found the picture, its GET failed
  const feed = folderEnv({ files: { [origJpg(1)]: { type: 'image/jpeg', rejectGet: true } } });
  await bootedFolder(feed);
  await send(feed, pinN(1), pinSender);
  assert.equal((await settled(feed)).reason, 'image_unavailable');
  assert.deepEqual([feed.log.permissionChecks, clipResults(feed)], [[], [['error', 'image_unavailable']]]);
  // the unavailable picture can be tried again: it was not remembered as saved
  const retry = folderEnv({ files: { [url]: 'reject' } });
  await bootedFolder(retry);
  clickWeb(retry, url);
  await settled(retry);
  retry.log.fetches.length = 0;
  clickWeb(retry, url);
  assert.deepEqual([(await settled(retry, 2)).reason, retry.log.fetches], ['site_access_needed', [`GET ${url}`]]);
  await noUnhandled();
  console.log('28 ok: a failed fetch is site_access_needed only on a web host without permission, otherwise image_unavailable; HTTP errors too');
}

// 29. a write fails part-way: whatever reached the folder is removed again
{
  const url = (n) => `https://example.com/p${n}.png`;
  // (a) the card cannot be written after the picture was: both files go
  const a = makeRoot();
  a.failWrite = (file) => (file.endsWith('.json') ? Object.assign(new Error('The quota has been exceeded'), { name: 'QuotaExceededError' }) : null);
  const envA = folderEnv({ root: a, files: { [url(1)]: { type: 'image/png', bytes: PIC } } });
  await bootedFolder(envA);
  clickWeb(envA, url(1));
  const recentA = await settled(envA);
  assert.deepEqual([recentA.status, recentA.reason], ['error', 'folder_write_failed']);
  const idA = recentA.id;
  assert.deepEqual(commits(a), [`${idA}.png`], 'the picture was written before the card failed');
  assert.deepEqual(removed(a), [`${idA}.json`, `${idA}.png`]);
  assert.equal(a.dirs.get('unsorted').files.size, 0);
  assert.deepEqual(data(envA).local.seen ?? [], []);
  assert.deepEqual(envA.log.badges.slice(-1), ['✗']);

  // (b) the grant lapses while the picture is written: not connected, the badge asks to reconnect, no card was started
  const b = makeRoot();
  b.failWrite = (file) => (file.endsWith('.png') ? fsError('NotAllowedError') : null);
  const envB = folderEnv({ root: b, files: { [url(2)]: { type: 'image/png', bytes: PIC } } });
  await bootedFolder(envB);
  clickWeb(envB, url(2));
  const recentB = await settled(envB);
  assert.deepEqual([recentB.status, recentB.reason], ['error', 'folder_not_connected']);
  assert.equal(b.dirs.get('unsorted').files.size, 0);
  assert.deepEqual(b.ops.filter(([op, , file]) => op === 'create' && file.endsWith('.json')), []);
  assert.equal(envB.shown, '✗', 'the flash is showing');
  envB.log.later.forEach((fn) => fn());
  assert.equal(envB.shown, '!');

  // (c) the connection breaks while the picture streams in: the half-written file is removed
  const c = makeRoot();
  const envC = folderEnv({ root: c, files: { [url(3)]: { type: 'image/png', bytes: PIC, breakStream: true } } });
  await bootedFolder(envC);
  clickWeb(envC, url(3));
  const recentC = await settled(envC);
  assert.deepEqual([recentC.status, recentC.reason], ['error', 'folder_write_failed']);
  assert.deepEqual([commits(c), c.dirs.get('unsorted').files.size, removed(c)], [[], 0, [`${recentC.id}.png`]]);
  assert.deepEqual([data(envC).ses.pending, data(envC).ses.inflight], [{}, []]);

  // (d) the same on a feed site: the tab is told, nothing is counted
  const d = makeRoot();
  d.failWrite = (file) => (file.endsWith('.json') ? new Error('disk full') : null);
  const envD = folderEnv({ root: d, files: { [origJpg(1)]: { type: 'image/jpeg', bytes: PIC } } });
  await bootedFolder(envD);
  await send(envD, pinN(1), pinSender);
  assert.equal((await settled(envD)).reason, 'folder_write_failed');
  assert.deepEqual([clipResults(envD), d.dirs.get('unsorted').files.size, data(envD).local.counts ?? {}], [[['error', 'folder_write_failed']], 0, {}]);
  await noUnhandled();
  console.log('29 ok: a failed write removes the picture and the card; reason folder_write_failed, or folder_not_connected with "!" when the grant lapsed');
}

// 30. reconcile: a folder write that this worker is not running any more is lost; one that it is running stays
{
  // (a) a worker restart left an fsa: entry behind
  const id = '20261020T101010Z-web-abc1234567';
  const url = 'https://example.com/a.png';
  const entry = {
    stage: 'write', url, ext: 'png', tabId: 4, frameId: 0, token: 'old-token', key: `unsorted|${url}`, savedFrom: 'feed-button', startedAt: Date.now() - 1000,
    card: { id, board: 'unsorted', site: 'web', title: 'Old', file: `${id}.png` },
  };
  const root = makeRoot();
  const env = folderEnv({ root, session: { pending: { [`fsa:${id}`]: entry }, inflight: [`unsorted|${url}`] } });
  await bootedFolder(env);
  const recent = await settled(env);
  assert.deepEqual([recent.status, recent.reason, recent.id, recent.board], ['error', 'save_lost', id, 'unsorted']);
  const { local, ses } = data(env);
  assert.deepEqual([ses.pending, ses.inflight, local.seen ?? [], local.counts ?? {}], [{}, [], [], {}]);
  assert.deepEqual(clipResults(env), [['error', 'save_lost']]);
  const lost = env.log.sent.find((s) => s.msg.type === 'clip-result');
  assert.deepEqual([lost.tabId, lost.msg.token], [4, 'old-token']);
  assert.deepEqual([root.ops, env.log.downloads], [[], []]);
  assert.equal(env.log.ui.at(-1), true);

  // (b) a write still running here survives a reconcile (the alarm), the same click is refused meanwhile, and it ends ok
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const live = makeRoot();
  const env2 = folderEnv({ root: live, files: { [origJpg(1)]: { type: 'image/jpeg', bytes: PIC, gate } } });
  await bootedFolder(env2);
  const first = await send(env2, pinN(1), pinSender);
  assert.equal(first.status, 'pending');
  await tick();
  assert.deepEqual(await send(env2, { ...pinN(1), token: 'dup' }, pinSender), { status: 'error', reason: 'already_saving' });
  env2.chrome.alarms.onAlarm.fire({ name: 'mbc-ui-restore' });
  await tick();
  assert.deepEqual(Object.keys(data(env2).ses.pending), [`fsa:${first.id}`]);
  assert.deepEqual([data(env2).local.recent.map((r) => r.reason), clipResults(env2)], [['already_saving'], []], 'only the refused click is on record');
  release();
  assert.equal((await settled(env2, 2)).status, 'ok');
  assert.deepEqual(commits(live), [`${first.id}.jpg`, `${first.id}.json`]);
  assert.deepEqual([data(env2).ses.pending, data(env2).ses.inflight], [{}, []]);
  await noUnhandled();
  console.log('30 ok: reconcile turns a stale fsa: entry into save_lost and leaves a write that is still running alone');
}

// 31. folder messages are honoured only from the extension's own pages
{
  const foreign = [
    { tab: { id: 7 }, frameId: 0, url: 'https://www.pinterest.com/pin/1/' },
    { url: 'chrome-extension://other/src/popup.html' },
    { url: 'chrome-extension://testing/src/popup.html' }, // starts like the extension's address, is another one
    {},
  ];
  const types = ['ensure-holder', 'folder-changed', 'folder-connected'];

  // (a) the badge follows the folder's grant, but only for the extension's own pages
  const root = makeRoot();
  const env = folderEnv({ root });
  await bootedFolder(env);
  assert.deepEqual([env.log.badges, env.shown], [[''], '']);
  root.permission = 'prompt';
  for (const sender of foreign) for (const type of types) assert.equal(await send(env, { type }, sender), 'NO-ASYNC', `${type} ${JSON.stringify(sender)}`);
  assert.deepEqual([env.log.badges, env.shown], [[''], ''], 'foreign senders change nothing');
  assert.deepEqual(await send(env, { type: 'folder-connected' }, ownSender), { ok: true });
  assert.deepEqual([env.log.badges, env.shown], [['', '!'], '!']);
  root.permission = 'granted';
  assert.equal(await send(env, { type: 'folder-changed' }, pinSender), 'NO-ASYNC');
  assert.equal(env.shown, '!');
  assert.deepEqual(await send(env, { type: 'folder-changed' }, ownSender), { ok: true });
  assert.deepEqual([env.log.badges, env.shown], [['', '!', ''], '']);

  // (b) no folder any more: a '!' left on the toolbar by the folder mode (it outlives the worker) is cleared, nothing else is touched
  const none = makeEnv({});
  await booted(none);
  await tick();
  none.shown = '!';
  assert.equal(await send(none, { type: 'folder-changed' }, pinSender), 'NO-ASYNC');
  assert.deepEqual([none.log.badges, none.shown], [[], '!']);
  await send(none, { type: 'folder-changed' }, ownSender);
  assert.deepEqual([none.log.badges, none.shown], [[''], '']);
  await send(none, { type: 'folder-changed' }, ownSender);
  assert.deepEqual(none.log.badges, [''], 'a clean badge is left alone in Downloads mode');
  none.shown = '✓';
  await send(none, { type: 'folder-changed' }, ownSender);
  assert.deepEqual(none.log.badges, [''], 'a flash is not mistaken for the folder warning');

  // (c) the holder (offscreen page) is created on request of the extension's pages only, once, and closed when the folder is gone
  const holder = makeEnv({ flags: { offscreen: true } });
  await bootedFolder(holder);
  holder.root = makeRoot();
  for (const sender of foreign) assert.equal(await send(holder, { type: 'ensure-holder' }, sender), 'NO-ASYNC');
  assert.deepEqual(holder.log.holder, []);
  assert.deepEqual(await send(holder, { type: 'ensure-holder' }, ownSender), { ok: true });
  assert.deepEqual(holder.log.holder, [['create', 'src/holder.html', 'BLOBS'], ['message', 'holder-reload']]);
  await send(holder, { type: 'ensure-holder' }, ownSender);
  assert.deepEqual(holder.log.holder.slice(2), [['message', 'holder-reload']], 'an open holder is reused');
  holder.root = null;
  await send(holder, { type: 'folder-changed' }, pinSender);
  assert.deepEqual(holder.log.holder.slice(3), [], 'a foreign folder-changed does not close it');
  await send(holder, { type: 'folder-changed' }, ownSender);
  assert.deepEqual(holder.log.holder.slice(3), [['close']]);
  await noUnhandled();
  console.log('31 ok: ensure-holder, folder-changed and folder-connected are ignored from foreign senders; own pages move the "!" badge and the holder');
}

// 32. Downloads mode is untouched: no `folder` in storage means the browser's own download, even if a handle is still stored
{
  const root = makeRoot();
  const env = makeEnv({ files: { [origJpg(1)]: 'image/jpeg' }, flags: { root } });
  await booted(env);
  await tick();
  assert.equal((await send(env, pinN(1), pinSender)).status, 'pending');
  assert.equal(env.log.downloads.length, 1);
  assert.match(env.log.downloads[0].filename, /^moodboard-inbox\/unsorted\/\d{8}T\d{6}Z-pinterest-k1\.jpg$/);
  assert.deepEqual(Object.keys(data(env).ses.pending), [String(env.log.downloads[0].id)]);
  assert.deepEqual(env.log.ui, [true, false]);
  await finishAll(env, [env.log.downloads[0].id]);
  assert.match(env.log.downloads[1].filename, /\.json$/);
  assert.deepEqual([root.ops, root.queries, root.dirs.size, env.log.badges, env.log.holder], [[], [], 0, [], []]);
  assert.deepEqual(env.log.fetchInit.filter((f) => f.method === 'GET'), [], 'the extension itself fetches no picture');
  console.log('32 ok: without a chosen folder a save still goes through chrome.downloads.download');
}

// Last: nothing in the whole run ended as an unhandled rejection.
await noUnhandled();
console.log('harness done');

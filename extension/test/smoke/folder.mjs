#!/usr/bin/env node
// Folder mode in Chrome for Testing with "Ask where to save each file" on: a folder dropped on folder.html, one click on
// "Connect folder" in the action popup, then a Cosmos save lands in <folder>/<board>/ with no download at all.
// The real folder picker cannot open headless, so the folder comes in by drag and drop (the page supports both).
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launch } from '../harness/browser.mjs';
import { click, discoverExtension, evaluate, hover, inWorker, openPage, sleep, targets, attach } from '../harness/cdp.mjs';
import { startFixtures } from '../harness/fixture-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(here, 'out', `folder-${stamp}`);
mkdirSync(path.join(out, 'dl'), { recursive: true });
mkdirSync(path.join(out, 'boards'), { recursive: true });
const downloads = await realpath(path.join(out, 'dl'));
const boards = await realpath(path.join(out, 'boards'));

const failures = [];
function expect(label, actual, wanted) {
  const ok = isDeepStrictEqual(actual, wanted);
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (wanted ${JSON.stringify(wanted)})`}`);
}
const files = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : []);
async function waitUntil(predicate, label, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const v = await predicate(); if (v) return v; await sleep(150); }
  throw new Error(`${label}: not reached within ${timeoutMs} ms`);
}

let fixtures;
let browser;
try {
  fixtures = await startFixtures({ pagesDir: path.join(app, 'test/fixtures/pages') });
  browser = await launch({ extensionDir: process.env.MBC_EXT_DIR ?? app, downloadDir: downloads, fixturePort: fixtures.port, promptForDownload: true });
  const { cdp } = browser;
  const ext = await discoverExtension(cdp, 'src/background.js');
  const w = (expression) => inWorker(cdp, ext, expression, 'src/popup.html');
  const page = (p) => (expression) => evaluate(cdp, p.sessionId, expression);
  await w(`chrome.storage.local.set({ activeBoard: 'cosmos' })`);

  // 1. folder.html: drop the folder on the drop zone.
  const setup = await openPage(cdp, `chrome-extension://${ext}/src/folder.html`);
  const [x, y] = await page(setup)(`(() => { const r = document.getElementById('drop').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const data = { items: [], files: [boards], dragOperationsMask: 1 | 2 | 16 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data }, setup.sessionId);
  const status = await waitUntil(() => page(setup)(`document.getElementById('status').textContent`), 'folder page status');
  expect('folder page says done', status.includes(path.basename(boards)), true);
  expect('storage folder name', await w(`chrome.storage.local.get('folder').then((r) => r.folder)`), { name: 'boards' });
  await cdp.send('Target.closeTarget', { targetId: setup.targetId });
  await sleep(500);

  // 2. Action popup: "Connect folder" is shown, enabled once the holder has the handle, one click grants.
  const before = new Set((await targets(cdp)).map((t) => t.targetId));
  // Headless Comet and Yandex keep no window once the last tab closes, and openPopup needs one.
  await w(`chrome.windows.getAll({ windowTypes: ['normal'] })
    .then(async ([win]) => win ?? chrome.windows.create({ url: 'about:blank' }))
    .then((win) => chrome.action.openPopup({ windowId: win.id })).then(() => 'ok')`);
  const popTarget = await waitUntil(async () => (await targets(cdp)).find((t) => t.type === 'page' && t.url.endsWith('/src/popup.html') && !before.has(t.targetId)), 'popup target');
  const pop = { targetId: popTarget.targetId, sessionId: await attach(cdp, popTarget.targetId) };
  await cdp.send('Runtime.enable', {}, pop.sessionId);
  const ready = await waitUntil(() => page(pop)(`(() => { const b = document.getElementById('connect'); return !b.hidden && !b.disabled; })()`), 'connect button ready');
  expect('connect button shown and enabled', ready, true);
  expect('badge before connect', await w('chrome.action.getBadgeText({})'), '!');
  const [cx, cy] = await page(pop)(`(() => { const r = document.getElementById('connect').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await click(cdp, pop.sessionId, cx, cy);
  await waitUntil(() => page(pop)(`document.getElementById('connect').hidden`), 'connect button hidden after click');
  expect('popup folder line', await page(pop)(`document.getElementById('whereText').textContent === chrome.i18n.getMessage('folderName', ['boards'])`), true);
  expect('badge after connect', await w('chrome.action.getBadgeText({})'), '');
  await cdp.send('Target.closeTarget', { targetId: pop.targetId });
  await sleep(1000);

  // 3. A Cosmos save goes into boards/cosmos/ through the holder's grant, with no download.
  const cosmos = await openPage(cdp, 'https://www.cosmos.so/fixture/feed');
  const [r] = await evaluate(cdp, cosmos.sessionId, `[...document.querySelectorAll('img[data-el="1001"]')].map((el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; })`);
  await cdp.send('Page.bringToFront', {}, cosmos.sessionId);
  await hover(cdp, cosmos.sessionId, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
  await sleep(150);
  await hover(cdp, cosmos.sessionId, r.left + 23, r.bottom - 23);
  await sleep(150);
  await click(cdp, cosmos.sessionId, r.left + 23, r.bottom - 23);
  const board = path.join(boards, 'cosmos');
  const saved = await waitUntil(() => { const f = files(board); return f.length === 2 && f.some((n) => n.endsWith('.json')) ? f : null; }, 'two files in boards/cosmos', 20000);
  const card = JSON.parse(readFileSync(path.join(board, saved.find((n) => n.endsWith('.json'))), 'utf8'));
  expect('image next to its card', saved.includes(card.file), true);
  expect('card fields', [card.site, card.board, card.saved_from], ['cosmos', 'cosmos', 'feed-button']);
  const recent = await waitUntil(() => w('chrome.storage.local.get({ recent: [] }).then((x) => x.recent[0])'), 'recent entry');
  expect('recent status', [recent.status, recent.reason ?? null], ['ok', null]);
  expect('no downloads at all', await w('chrome.downloads.search({}).then((d) => d.length)'), 0);
  expect('downloads folder empty', files(downloads), []);
} catch (error) {
  failures.push(error.message);
  console.log('FAIL', error.stack || error.message);
} finally {
  await browser?.close?.().catch(() => {});
  await fixtures?.close?.().catch(() => {});
}
console.log(failures.length ? `FOLDER SMOKE FAILED (${failures.length})` : `FOLDER SMOKE OK boards=${boards}`);
process.exit(failures.length ? 1 : 0);

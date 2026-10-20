#!/usr/bin/env node
// Autosmoke: the real extension in Chrome for Testing against local fixtures under real hostnames.
// Feed buttons on Pinterest and Cosmos, the context menu on any page, repeats, and the inbox layout on disk.
// The inbox stays in test/smoke/out/<stamp>/ to look at by hand.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launch } from '../harness/browser.mjs';
import { click, discoverExtension, evaluate, hover, inWorker, openPage, sleep } from '../harness/cdp.mjs';
import { COSMOS_MAX_WIDTH, ELEMENTS, PINS, startFixtures } from '../harness/fixture-server.mjs';

const require = createRequire(import.meta.url);
const { cosmosOriginal } = require('../../src/lib/original.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '../..');
// src/background.js names the file 'img' when neither the content type nor the URL gives an extension (the fixture's second web image).
const unknownExt = 'img';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(path.join(here, 'out', stamp), { recursive: true });
const downloads = await realpath(path.join(here, 'out', stamp));
const inbox = path.join(downloads, 'moodboard-inbox');

const failures = [];
function expect(label, actual, wanted) {
  const ok = isDeepStrictEqual(actual, wanted);
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (wanted ${JSON.stringify(wanted)})`}`);
}

function boardFiles(board) {
  const dir = path.join(inbox, board);
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : [];
}

async function waitUntil(predicate, label, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`${label}: not reached within ${timeoutMs} ms`);
}

// A download in progress: Chrome's `<name>.crdownload`, Yandex's `Не подтверждено 461304.~` next to the finished files.
const partial = (name) => name.endsWith('.crdownload') || name.endsWith('.~');

async function waitFiles(board, count, label, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const names = boardFiles(board);
    if (names.length >= count && !names.some(partial)) return names;
    await sleep(200);
  }
  throw new Error(`${label}: wanted ${count} files in ${board}/, have ${JSON.stringify(boardFiles(board))}`);
}

function width(file) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', file], { encoding: 'utf8' });
  return Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1] ?? NaN);
}

// First card in the board that satisfies the predicate. Cosmos feed tiles share one page_url, so they are told apart by asset_url.
function cardBy(board, match, label) {
  for (const name of boardFiles(board).filter((n) => n.endsWith('.json'))) {
    const card = JSON.parse(readFileSync(path.join(inbox, board, name), 'utf8'));
    if (match(card)) return card;
  }
  throw new Error(`no card for ${label} in ${board}/`);
}
const cardFor = (board, pageUrl) => cardBy(board, (card) => card.page_url === pageUrl, pageUrl);

// Started inside the try below, so that a failing launch still closes the fixture server.
let fixtures;
let browser;
let cdp;

async function rects(page, selector) {
  return evaluate(cdp, page.sessionId, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      src: el.currentSrc || el.poster || el.src, srcset: el.getAttribute('srcset') };
  })`);
}

// The host div lives on <html> with a closed shadow root, so hit testing from the page returns the host itself.
const buttonAt = (page, x, y) => evaluate(cdp, page.sessionId,
  `(() => { const el = document.elementsFromPoint(${x}, ${y})[0]; return el?.tagName === 'DIV' && el.parentElement === document.documentElement; })()`);

// The fixture pages count clicks on the site's own save buttons here; the extension must never press them.
const nativeSaves = (page) => evaluate(cdp, page.sessionId, 'typeof document.body.dataset.nativeSaves');

async function press(page, r) {
  await cdp.send('Page.bringToFront', {}, page.sessionId);
  await hover(cdp, page.sessionId, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
  await sleep(150);
  const x = r.left + 23;
  const y = r.bottom - 23;
  await hover(cdp, page.sessionId, x, y);
  await sleep(150);
  if (!(await buttonAt(page, x, y))) throw new Error(`no save button over ${r.src}`);
  await click(cdp, page.sessionId, x, y);
}

try {
  fixtures = await startFixtures({ pagesDir: path.join(app, 'test/fixtures/pages') });
  browser = await launch({ extensionDir: process.env.MBC_EXT_DIR ?? app, downloadDir: downloads, fixturePort: fixtures.port });
  ({ cdp } = browser);
  const ext = await discoverExtension(cdp, 'src/background.js');
  const w = (expression) => inWorker(cdp, ext, expression, 'src/popup.html');
  const recent = () => w('chrome.storage.local.get({ recent: [] }).then((r) => r.recent)');
  async function waitRecent(pred, label, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const list = await recent();
      if (pred(list)) return list;
      await sleep(250);
    }
    throw new Error(`${label}: recent never matched, last ${JSON.stringify(await recent())}`);
  }
  await w(`chrome.storage.local.set({ activeBoard: 'smoke' })`);
  // The menu scenarios below call mbcMenuClick directly: check that the worker registered that same function as the menu listener.
  expect('mbcMenuClick is the contextMenus listener', await w('chrome.contextMenus.onClicked.hasListener(mbcMenuClick)'), true);

  // A. Pinterest feed button: the original ladder per pin.
  // 9002 has a closeup-style srcset (736w/1152w, no originals entry): its png original comes from the extension-probe ladder.
  const pinWanted = {
    9001: { ext: 'jpg', width: 1200, fallback: null, media: 'image' },
    9002: { ext: 'png', width: 1200, fallback: 'originals.png', media: 'image' },
    9003: { ext: 'jpg', width: 736, fallback: '736x', media: 'image' },
    9004: { ext: 'jpg', width: 1200, fallback: null, media: 'video-poster' },
    // 9005: jpg thumbnails, png original named by the srcset 4x entry: no extension guessing, no fallback.
    9005: { ext: 'png', width: 1200, fallback: null, media: 'image' },
  };
  let pinterest = await openPage(cdp, 'https://www.pinterest.com/fixture/feed/');
  for (const [i, pin] of PINS.entries()) {
    const [r] = await rects(pinterest, `[data-pin="${pin.id}"]`);
    await press(pinterest, r);
    await waitFiles('smoke', 2 * (i + 1), `pin ${pin.id}`);
    const card = cardFor('smoke', `https://www.pinterest.com/pin/${pin.id}/`);
    await waitRecent((list) => list[0]?.status === 'ok' && list[0]?.id === card.id, `pin ${pin.id}`);
    const want = pinWanted[pin.id];
    expect(`pin ${pin.id} card`, [card.site, card.page_url_kind, card.saved_from, card.media, card.asset_fallback, card.title],
      ['pinterest', 'pin', 'feed-button', want.media, want.fallback, `Fixture pin ${pin.id}`]);
    expect(`pin ${pin.id} file`, [card.file.split('.').pop(), width(path.join(inbox, 'smoke', card.file))], [want.ext, want.width]);
  }
  expect('pinterest: native save never pressed', await nativeSaves(pinterest), 'undefined');
  // The srcset entry wins over extension guessing: nothing asked for the jpg that does not exist under /originals/.
  const pin5 = PINS.find((p) => p.id === '9005');
  expect('pin 9005: no guess at /originals/ .jpg', fixtures.log.filter((r) => r.host === 'i.pinimg.com'
    && r.path === `/originals/${pin5.path}.jpg`).length, 0);

  // B. Images under 150 px get no button.
  // The same probe runs twice: once on the 120 px image and, as a positive control, on that image enlarged to 200 px.
  // Without the control the negative result would also hold if the hover never landed or buttonAt looked at the wrong spot.
  const probeButton = async (r) => {
    await cdp.send('Page.bringToFront', {}, pinterest.sessionId);
    await hover(cdp, pinterest.sessionId, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
    await sleep(150);
    await hover(cdp, pinterest.sessionId, r.left + 23, r.bottom - 23);
    await sleep(150);
    return buttonAt(pinterest, r.left + 23, r.bottom - 23);
  };
  const [small] = await rects(pinterest, '[data-pin="small"]');
  expect('no button on a 120 px image', await probeButton(small), false);
  await evaluate(cdp, pinterest.sessionId, `Object.assign(document.querySelector('[data-pin="small"]').style, { width: '200px', height: '200px' })`);
  const [grown] = await rects(pinterest, '[data-pin="small"]');
  expect('small image measures 200 px', [Math.round(grown.right - grown.left), Math.round(grown.bottom - grown.top)], [200, 200]);
  expect('button appears once the small image is 200 px', await probeButton(grown), true);
  await evaluate(cdp, pinterest.sessionId, `Object.assign(document.querySelector('[data-pin="small"]').style, { width: '', height: '' })`);
  const [restored] = await rects(pinterest, '[data-pin="small"]');
  expect('small image is 120 px again', [Math.round(restored.right - restored.left), Math.round(restored.bottom - restored.top)], [120, 90]);
  expect('no button on the restored 120 px image', await probeButton(restored), false);

  // C. Repeats: same page (content-script memory) and after reload (worker memory). Neither writes a file.
  const filesBefore = boardFiles('smoke').length;
  const recentBefore = (await recent()).length;
  const [first] = await rects(pinterest, '[data-pin="9001"]');
  await press(pinterest, first);
  await sleep(1500);
  expect('repeat on the same page', [boardFiles('smoke').length, (await recent()).length], [filesBefore, recentBefore]);
  const oldOrigin = await evaluate(cdp, pinterest.sessionId, 'performance.timeOrigin');
  await cdp.send('Page.reload', {}, pinterest.sessionId);
  // A new document has a new timeOrigin: a bare readyState check right after the reload could still see the old, complete document.
  await waitUntil(async () => {
    const [origin, state] = await evaluate(cdp, pinterest.sessionId, '[performance.timeOrigin, document.readyState]').catch(() => []);
    return origin !== undefined && origin !== oldOrigin && state === 'complete';
  }, 'page reload');
  await sleep(500);
  await press(pinterest, (await rects(pinterest, '[data-pin="9001"]'))[0]);
  await waitRecent((list) => list.length > recentBefore, 'repeat after reload');
  expect('repeat after reload', [(await recent())[0].status, boardFiles('smoke').length], ['repeat', filesBefore]);
  expect('pinterest after repeats: native save never pressed', await nativeSaves(pinterest), 'undefined');
  await cdp.send('Target.closeTarget', { targetId: pinterest.targetId });

  // D. Cosmos feed button. Feed tiles carry no element id and no link: page_url is the tab address and both cards share it,
  // so they are found by asset_url. The original is the CDN address without query, no fallback.
  const cosmos = await openPage(cdp, 'https://www.cosmos.so/fixture/feed');
  for (const element of ELEMENTS.filter((e) => e.id === '1001' || e.id === '1002')) {
    const [r] = await rects(cosmos, `img[data-el="${element.id}"]`);
    const before = boardFiles('smoke').length;
    await press(cosmos, r);
    await waitFiles('smoke', before + 2, `element ${element.id}`);
    const asset = cosmosOriginal(r.src, r.srcset);
    const card = cardBy('smoke', (c) => c.asset_url === asset, asset);
    await waitRecent((list) => list[0]?.status === 'ok' && list[0]?.id === card.id, `element ${element.id}`);
    expect(`element ${element.id} feed card`,
      [card.site, card.page_url_kind, card.page_url, card.asset_url, card.asset_fallback, card.saved_from, card.media],
      ['cosmos', 'tab', 'https://www.cosmos.so/fixture/feed', `https://cdn.cosmos.so/${element.asset}`, null, 'feed-button', 'image']);
    expect(`element ${element.id} feed width`, width(path.join(inbox, 'smoke', card.file)), COSMOS_MAX_WIDTH);
  }
  expect('cosmos feed: native save never pressed', await nativeSaves(cosmos), 'undefined');
  await cdp.send('Target.closeTarget', { targetId: cosmos.targetId });

  // D2. Cosmos element page: the main image (on top of a w=400 placeholder of the same uuid) gives the element address and the author.
  const element = ELEMENTS.find((e) => e.id === '1003');
  const cosmosElement = await openPage(cdp, 'https://www.cosmos.so/e/1003');
  const [main] = await rects(cosmosElement, 'img[data-el="1003"]');
  const beforeElement = boardFiles('smoke').length;
  await press(cosmosElement, main);
  await waitFiles('smoke', beforeElement + 2, 'element 1003');
  const elementAsset = `https://cdn.cosmos.so/${element.asset}`;
  const elementCard = cardBy('smoke', (c) => c.asset_url === elementAsset, elementAsset);
  await waitRecent((list) => list[0]?.status === 'ok' && list[0]?.id === elementCard.id, 'element 1003');
  expect('element 1003 page card', [elementCard.site, elementCard.page_url_kind, elementCard.page_url, elementCard.asset_url,
    elementCard.asset_fallback, elementCard.author],
    ['cosmos', 'element', 'https://www.cosmos.so/e/1003', 'https://cdn.cosmos.so/7d1c0000-0000-4000-8000-000000000003', null, 'fixture-author']);
  expect('element 1003 page width', width(path.join(inbox, 'smoke', elementCard.file)), COSMOS_MAX_WIDTH);
  expect('cosmos element page: native save never pressed', await nativeSaves(cosmosElement), 'undefined');
  await cdp.send('Target.closeTarget', { targetId: cosmosElement.targetId });

  // E. Any other site: the context-menu handler, called directly (a native menu cannot be clicked over CDP).
  const web = await openPage(cdp, 'https://fixture.test/web.html');
  const webImages = await rects(web, 'img');
  for (const [i, image] of webImages.entries()) {
    const before = boardFiles('smoke').length;
    const result = await w(`mbcMenuClick({ menuItemId: 'moodboard-clip', srcUrl: ${JSON.stringify(image.src)},
      pageUrl: 'https://fixture.test/web.html', frameId: 0 }, { id: -1, title: 'web fixture' })`);
    expect(`web image ${i + 1} starts`, result?.status, 'pending');
    const names = await waitFiles('smoke', before + 2, `web image ${i + 1}`);
    await waitRecent((list) => list[0]?.status === 'ok' && list[0]?.id === result.id, `web image ${i + 1}`);
    const cardName = names.find((n) => n === `${result.id}.json`);
    if (!cardName) throw new Error(`no card ${result.id}.json for web image ${i + 1}`);
    const card = JSON.parse(readFileSync(path.join(inbox, 'smoke', cardName), 'utf8'));
    expect(`web image ${i + 1} card`, [card.site, card.page_url_kind, card.alt, card.saved_from, card.title],
      ['web', 'tab', null, 'context-menu', 'web fixture']);
    expect(`web image ${i + 1} file`, [card.file.split('.').pop(), width(path.join(inbox, 'smoke', card.file))],
      [i === 0 ? 'png' : unknownExt, 640]);
  }
  await cdp.send('Target.closeTarget', { targetId: web.targetId });

  // E2. Links that lie over a picture: the function the worker injects (executeScript is covered by the worker harness)
  // is run in a real page. The sibling-overlay link (with a caption link to the same address) and the wrapping link give the image,
  // the text link gives { miss: 'none' }, and two cards that both link to "#" give { miss: 'many' }: the clicked one cannot be told apart.
  const overlay = await openPage(cdp, 'https://fixture.test/overlay.html');
  const finder = await w('MoodboardClip.findImageUnderLink.toString()');
  const WEB_1 = 'https://fixture.test/img/web-1.png';
  const answerFor = (href) => evaluate(cdp, overlay.sessionId, `(${finder})(${JSON.stringify(href)})`);
  for (const [n, wanted] of [[1, { url: WEB_1 }], [2, { url: WEB_1 }], [3, { miss: 'none' }]]) {
    expect(`link ${n} answers ${wanted.url ? 'the image' : 'no image'}`, await answerFor(`https://fixture.test/gallery/${n}`), wanted);
  }
  const hashHrefs = await evaluate(cdp, overlay.sessionId, `[...document.querySelectorAll('#four a, #five a')].map((a) => a.href)`);
  expect('the two "#" cards share one address', [hashHrefs.length, new Set(hashHrefs).size], [2, 1]);
  expect('two cards that both link to "#" answer many', await answerFor(hashHrefs[0]), { miss: 'many' });
  await cdp.send('Target.closeTarget', { targetId: overlay.targetId });

  // F. blob: has no address to save.
  const beforeBlob = boardFiles('smoke').length;
  const blob = await w(`mbcMenuClick({ menuItemId: 'moodboard-clip', srcUrl: 'blob:https://fixture.test/x',
    pageUrl: 'https://fixture.test/web.html', frameId: 0 }, { id: -1, title: 'web fixture' })`);
  expect('blob: is refused', [blob?.status, blob?.reason], ['error', 'no_image_url']);
  await sleep(500);
  expect('blob: writes nothing', boardFiles('smoke').length, beforeBlob);

  // G. Right-click on a pin: the content script hands its pin data to the menu handler.
  await w(`chrome.storage.local.set({ activeBoard: 'smoke-2' })`);
  pinterest = await openPage(cdp, 'https://www.pinterest.com/fixture/feed/');
  await sleep(500);
  const [third] = await rects(pinterest, '[data-pin="9003"]');
  await cdp.send('Page.bringToFront', {}, pinterest.sessionId);
  await click(cdp, pinterest.sessionId, (third.left + third.right) / 2, (third.top + third.bottom) / 2, 'right');
  await sleep(200);
  const menu = await w(`chrome.tabs.query({ url: 'https://www.pinterest.com/*' }).then(([tab]) =>
    mbcMenuClick({ menuItemId: 'moodboard-clip', srcUrl: ${JSON.stringify(third.src)}, pageUrl: tab.url, frameId: 0 }, tab))`);
  expect('right-click on a pin starts', menu?.status, 'pending');
  await waitFiles('smoke-2', 2, 'right-click pin');
  const rightCard = cardFor('smoke-2', 'https://www.pinterest.com/pin/9003/');
  await waitRecent((list) => list[0]?.status === 'ok' && list[0]?.id === rightCard.id, 'right-click pin');
  expect('right-click card', [rightCard.saved_from, rightCard.page_url_kind, rightCard.asset_fallback,
    width(path.join(inbox, 'smoke-2', rightCard.file))], ['context-menu', 'pin', '736x', 736]);
  expect('pinterest after right-click: native save never pressed', await nativeSaves(pinterest), 'undefined');

  // H. Totals on disk and in storage.
  // smoke: 5 pins + 2 cosmos feed + 1 cosmos element + 2 web = 10 saves, 2 files each; smoke-2: the right-clicked pin.
  const totals = await w(`chrome.storage.local.get({ seen: [], counts: {} }).then((r) => ({ seen: r.seen.length, counts: r.counts }))`);
  expect('files per board', [boardFiles('smoke').length, boardFiles('smoke-2').length], [20, 2]);
  expect('no partial downloads', [...boardFiles('smoke'), ...boardFiles('smoke-2')].filter(partial), []);
  expect('storage totals', totals, { seen: 11, counts: { smoke: 10, 'smoke-2': 1 } });

  // I. Positive control for the nativeSaves counter: press the uncovered part of a native Save button on the local Pinterest fixture.
  // The extension button covers the pin's bottom-left 8..38 px of the image; the native button is 64 px at the same corner,
  // so its top-right area is free. Only a dataset counter changes: files, storage and totals are not affected.
  const [nativeButton] = await rects(pinterest, '[data-test-id="pin-better-save-button"]');
  const nativeX = nativeButton.right - 6;
  const nativeY = nativeButton.top + 6;
  const topmost = await evaluate(cdp, pinterest.sessionId, `document.elementsFromPoint(${nativeX}, ${nativeY})[0]?.getAttribute('data-test-id')`);
  expect('native save button is topmost where the control clicks', topmost, 'pin-better-save-button');
  await cdp.send('Page.bringToFront', {}, pinterest.sessionId);
  await click(cdp, pinterest.sessionId, nativeX, nativeY);
  expect('native save counter works (positive control)', await nativeSaves(pinterest), 'string');

  // J. Link menu on Pinterest: a right click on the text link under a card gives the menu a linkUrl and no srcUrl. The worker injects
  // findImageUnderLink, gets the picture's address, and asks the content script by that address (byUrl), because the click did not land
  // on the picture and nothing is remembered. The result must be a Pinterest read (pin page, original), not a plain web clip of the thumbnail.
  // DPR 2 makes the shown candidate (currentSrc, 474x) differ from src (236x): the lookup must follow the same currentSrc || src chain
  // as the finder, and a comparison on src alone would find nothing. Board smoke-3: its repeat memory is empty.
  await w(`chrome.storage.local.set({ activeBoard: 'smoke-3' })`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false }, pinterest.sessionId);
  const originBeforeJ = await evaluate(cdp, pinterest.sessionId, 'performance.timeOrigin');
  await cdp.send('Page.reload', {}, pinterest.sessionId);
  await waitUntil(async () => {
    const [origin, state] = await evaluate(cdp, pinterest.sessionId, '[performance.timeOrigin, document.readyState]').catch(() => []);
    return origin !== undefined && origin !== originBeforeJ && state === 'complete';
  }, 'page reload for DPR 2');
  await sleep(500);
  const shownJ = await evaluate(cdp, pinterest.sessionId, `(() => { const i = document.querySelector('[data-pin="9005"]'); return [i.currentSrc, i.src]; })()`);
  const pin5Url = (size) => `https://i.pinimg.com/${size}/${pin5.path}.jpg`;
  expect('DPR 2: pin 9005 shows its 2x candidate while src stays the 1x one', shownJ, [pin5Url('474x'), pin5Url('236x')]);

  const pinterestTabs = `chrome.tabs.query({ url: 'https://www.pinterest.com/*' })`;
  expect('one pinterest tab is open', await w(`${pinterestTabs}.then((tabs) => tabs.length)`), 1);
  const probe = (srcUrl, byUrl) => w(`${pinterestTabs}.then(([tab]) => chrome.tabs.sendMessage(tab.id,
    { type: 'probe-context', srcUrl: ${JSON.stringify(srcUrl)}${byUrl ? ', byUrl: true' : ''} }, { frameId: 0 }))`);
  const [titleLink] = await rects(pinterest, '[data-title-link="9005"]');
  const titleX = (titleLink.left + titleLink.right) / 2;
  const titleY = (titleLink.top + titleLink.bottom) / 2;
  expect('the title link is topmost where the right click lands',
    await evaluate(cdp, pinterest.sessionId, `document.elementsFromPoint(${titleX}, ${titleY})[0]?.getAttribute('data-title-link')`), '9005');
  await cdp.send('Page.bringToFront', {}, pinterest.sessionId);
  await click(cdp, pinterest.sessionId, titleX, titleY, 'right');
  await sleep(200);
  expect('right click on the title remembers nothing: the plain probe is empty', await probe(shownJ[0], false), null);
  const byUrl = await probe(shownJ[0], true);
  expect('byUrl finds the picture and reads it as a pin',
    [byUrl?.key, byUrl?.pageUrl, byUrl?.pageUrlKind, byUrl?.shownUrl, byUrl?.media], ['9005', 'https://www.pinterest.com/pin/9005/', 'pin', shownJ[0], 'image']);
  expect('byUrl for an address that is not on the page gives nothing', await probe(pin5Url('1200x'), true), null);

  const linkMenu = (linkUrl) => w(`${pinterestTabs}.then(([tab]) =>
    mbcMenuClick({ menuItemId: 'moodboard-clip', linkUrl: ${JSON.stringify(linkUrl)}, pageUrl: tab.url, frameId: 0 }, tab))`);
  const linkRun = await linkMenu('https://www.pinterest.com/pin/9005/');
  expect('title link starts a save', linkRun?.status, 'pending');
  await waitFiles('smoke-3', 2, 'title link');
  const linkCard = cardFor('smoke-3', 'https://www.pinterest.com/pin/9005/');
  await waitRecent((list) => list[0]?.status === 'ok' && list[0]?.id === linkCard.id, 'title link');
  expect('title link card is a Pinterest read, not a web clip',
    [linkCard.site, linkCard.page_url_kind, linkCard.page_url, linkCard.saved_from, linkCard.media, linkCard.asset_fallback, linkCard.title],
    ['pinterest', 'pin', 'https://www.pinterest.com/pin/9005/', 'context-menu', 'image', null, 'Fixture pin 9005']);
  expect('title link saved the png original', [linkCard.file.split('.').pop(), width(path.join(inbox, 'smoke-3', linkCard.file))], ['png', 1200]);

  // Pin 9001 and the 120 px "Small fixture" card share /pin/9001/: two different pictures under one address are refused, nothing is saved.
  const many = await linkMenu('https://www.pinterest.com/pin/9001/');
  expect('same address over two pictures is refused', [many?.status, many?.reason], ['error', 'many_images_under_link']);
  await sleep(500);
  expect('refused link writes nothing', boardFiles('smoke-3').length, 2);
  await cdp.send('Target.closeTarget', { targetId: pinterest.targetId });
} catch (error) {
  failures.push(String(error?.message || error));
  console.log(`FAIL ${error?.stack || error}`);
} finally {
  // Each cleanup step runs on its own: one failure must not skip the others or the SMOKE line.
  for (const [name, step] of [['browser.close', () => browser?.close()], ['fixtures.close', () => fixtures?.close()]]) {
    try { await step(); } catch (error) { failures.push(`cleanup ${name}: ${error?.message || error}`); console.log(`FAIL cleanup ${name}: ${error?.stack || error}`); }
  }
}
console.log(failures.length ? `SMOKE FAILED: ${failures.join('; ')}` : `SMOKE OK inbox=${inbox}`);
process.exit(failures.length ? 1 : 0);

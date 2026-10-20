#!/usr/bin/env node
// README and site GIF: hover a card in the demo feed, press ＋, see the picture and its card in the board folder.
// Run from the repo root: node demo/record.mjs <extension dir> <out dir> [en] [ru]   (MBC_CHROME → Chrome for Testing)
// Prints one line per language: GIF <out>/demo-<lang>.gif <frames> frames <bytes> bytes
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../extension/test/harness/browser.mjs';
import { click, discoverExtension, evaluate, inWorker, openPage, sleep } from '../extension/test/harness/cdp.mjs';
import { makeGif, recorder } from './frames.mjs';
import { DEMO_HOSTS, FEED_URL, folderUrl, loadWorks, startDemo } from './serve.mjs';

const [extensionDir, out] = process.argv.slice(2, 4).map((p) => p && path.resolve(p));
const langs = process.argv.slice(4).length ? process.argv.slice(4) : ['en', 'ru'];
if (!extensionDir || !out || langs.some((l) => !['en', 'ru'].includes(l))) {
  throw new Error('usage: record.mjs <extension dir> <out dir> [en] [ru]');
}
const fail = (message) => { console.error(message); process.exit(1); };
if (!existsSync(path.join(extensionDir, 'manifest.json'))) fail('build the extension first: scripts/package-extension.sh');
// The works are read before any temporary folder exists, so a missing works.json leaves nothing behind.
if (!existsSync(fileURLToPath(new URL('./works/works.json', import.meta.url)))) {
  fail('demo/works/works.json not found: draw the pictures first with node demo/draw-works.mjs (see demo/README.md)');
}
const works = loadWorks();
await mkdir(out, { recursive: true });

const BOARD = 'concept-a';
const VIEW = { width: 1200, height: 750, deviceScaleFactor: 2, mobile: false };
// The card nearest the middle of the window that is fully in view: the button and the cursor stay clear of the edges.
const PICK = `(() => {
  const cx = innerWidth / 2;
  const cy = innerHeight / 2;
  const away = (r) => Math.hypot((r.left + r.right) / 2 - cx, (r.top + r.bottom) / 2 - cy);
  const cards = [...document.querySelectorAll('[data-test-pin-id] img')].map((img) => {
    const r = img.getBoundingClientRect();
    return { pin: img.closest('[data-test-pin-id]').dataset.testPinId, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }).filter((r) => r.top >= 72 && r.bottom <= innerHeight - 8);
  return cards.sort((a, b) => away(a) - away(b))[0] ?? null;
})()`;

for (const lang of langs) {
  const downloads = await realpath(await mkdtemp(path.join(tmpdir(), 'mbc-demo-dl-')));
  const work = await mkdtemp(path.join(tmpdir(), 'mbc-demo-frames-'));
  const inbox = path.join(downloads, 'moodboard-inbox');
  let demo;
  let browser;
  try {
    demo = await startDemo({ works, inboxDir: inbox, lang });
    browser = await launch({ extensionDir, downloadDir: downloads, fixturePort: demo.port, hosts: DEMO_HOSTS });
    const { cdp } = browser;
    const ext = await discoverExtension(cdp, 'src/background.js');
    const w = (expression) => inWorker(cdp, ext, expression, 'src/popup.html');
    await w(`chrome.storage.local.set({ activeBoard: '${BOARD}', boards: ['${BOARD}'] }).then(() => true)`);

    const rec = recorder(cdp, work);
    const feed = await openPage(cdp, FEED_URL);
    await cdp.send('Emulation.setDeviceMetricsOverride', VIEW, feed.sessionId);
    await sleep(500);
    const r = await evaluate(cdp, feed.sessionId, PICK);
    if (!r) throw new Error('no card of the demo feed is fully in view');

    rec.use(feed, { x: VIEW.width - 360, y: 32 });
    await rec.shot(900);
    await rec.moveTo((r.left + r.right) / 2, (r.top + r.bottom) / 2, 16);
    await rec.shot(500);
    // The extension's button sits over the image's bottom-left corner, as in extension/test/smoke/smoke.mjs.
    const x = r.left + 23;
    const y = r.bottom - 23;
    await rec.moveTo(x, y, 10);
    await rec.shot(450);
    await click(cdp, feed.sessionId, x, y);
    // The cursor steps off the button, still over the card, so ＋ → ⏳ → ✓ stay in view.
    await rec.moveTo(x + 30, y - 24, 4);
    const until = Date.now() + 15000;
    let saved = false;
    while (!saved) {
      if (Date.now() > until) throw new Error('the save did not finish within 15 s');
      await rec.shot(100);
      const recent = await w('chrome.storage.local.get({ recent: [] }).then((r) => r.recent)');
      const files = existsSync(path.join(inbox, BOARD)) ? readdirSync(path.join(inbox, BOARD)) : [];
      saved = recent[0]?.status === 'ok' && files.some((n) => n.endsWith('.json')) && !files.some((n) => n.endsWith('.crdownload'));
    }
    await rec.shot(1400);

    const folder = await openPage(cdp, folderUrl(BOARD, lang));
    await cdp.send('Emulation.setDeviceMetricsOverride', VIEW, folder.sessionId);
    await sleep(300);
    rec.use(folder);
    await rec.shot(2800);

    const gif = path.join(out, `demo-${lang}.gif`);
    const bytes = makeGif(rec.frames, gif);
    console.log(`GIF ${gif} ${rec.frames.length} frames ${bytes} bytes`);
  } finally {
    await browser?.close();
    await demo?.close();
    await rm(work, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
  }
}

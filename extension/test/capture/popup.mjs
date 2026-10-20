#!/usr/bin/env node
// Popup screenshots for review and the site: en and ru, light and dark, three saves in the list.
// Run from extension/: node test/capture/popup.mjs <extension dir> <out dir>   (MBC_CHROME → Chrome for Testing)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launch } from '../harness/browser.mjs';
import { discoverExtension, evaluate, inWorker, openPage, sleep } from '../harness/cdp.mjs';

const [extensionDir, out] = process.argv.slice(2).map((p) => path.resolve(p));
if (!extensionDir || !out) throw new Error('usage: popup.mjs <extension dir> <out dir>');
await mkdir(out, { recursive: true });

// Chrome on macOS may take the UI language from AppleLanguages rather than --lang.
const LANG_ARGS = { en: ['--lang=en-US', '-AppleLanguages', '(en)'], ru: ['--lang=ru', '-AppleLanguages', '(ru)'] };
const LABEL = { en: 'Board', ru: 'Доска' };
const now = Date.now();
const SEED = {
  activeBoard: 'concept-a',
  boards: ['concept-a'],
  counts: { 'concept-a': 12 },
  recent: [
    { at: now - 60_000, status: 'ok', board: 'concept-a', site: 'pinterest', id: '100000000000000001', title: 'Concrete stair in morning light' },
    { at: now - 600_000, status: 'repeat', board: 'concept-a', site: 'cosmos', id: '1000000001', title: 'Blue field' },
    { at: now - 3_600_000, status: 'error', board: 'concept-a', site: 'web', id: null, title: 'Studio notes', reason: 'not_https' },
  ],
};

const shots = [];
for (const locale of ['en', 'ru']) {
  const downloads = await mkdtemp(path.join(tmpdir(), 'mbc-capture-'));
  const browser = await launch({ extensionDir, downloadDir: downloads, extraArgs: LANG_ARGS[locale] });
  try {
    const { cdp } = browser;
    const ext = await discoverExtension(cdp, 'src/background.js');
    await inWorker(cdp, ext, `chrome.storage.local.set(${JSON.stringify(SEED)}).then(() => true)`, 'src/popup.html');
    const page = await openPage(cdp, `chrome-extension://${ext}/src/popup.html`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: false }, page.sessionId);
    for (const scheme of ['light', 'dark']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, page.sessionId);
      await sleep(300);
      const label = await evaluate(cdp, page.sessionId, `document.querySelector('label[for=board]').textContent`);
      if (label !== LABEL[locale]) throw new Error(`${locale}: the label reads "${label}", the UI language did not switch`);
      const height = await evaluate(cdp, page.sessionId, 'Math.ceil(document.documentElement.getBoundingClientRect().height)');
      const { data } = await cdp.send('Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: 320, height, scale: 1 } }, page.sessionId);
      const file = `popup-${locale}-${scheme}.png`;
      await writeFile(path.join(out, file), Buffer.from(data, 'base64'));
      shots.push(file);
    }
  } finally {
    await browser.close();
    await rm(downloads, { recursive: true, force: true });
  }
}

const figures = shots.map((file) => `<figure><img src="${file}" width="320"><figcaption>${file}</figcaption></figure>`).join('\n');
await writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Popup</title>
<style>body{margin:0;padding:24px;display:flex;flex-wrap:wrap;gap:24px;background:#8E8E94;font:12px system-ui}figure{margin:0}img{display:block;border-radius:8px}</style>
${figures}
`);
console.log(`CAPTURED ${shots.length} ${out}`);

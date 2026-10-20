#!/usr/bin/env node
// Step pictures for the README, the site and the video: scripts/steps/<en|ru>/step-{1,2,3}.png, 336×210.
// Steps 1–2 are shots of chrome://extensions in Chrome for Testing; step 3 is folder-picker.html,
// because the macOS folder sheet cannot be captured headless.
// Run from the repo root: node scripts/steps/capture.mjs [step ...]   (MBC_CHROME → Chrome for Testing)
// With no arguments it redraws all three steps. Step numbers redraw only those: node scripts/steps/capture.mjs 3
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../../extension/test/harness/browser.mjs';
import { evaluate, openPage, sleep } from '../../extension/test/harness/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const requested = process.argv.slice(2);
if (requested.some((step) => !['1', '2', '3'].includes(step))) {
  console.error('usage: node scripts/steps/capture.mjs [1] [2] [3]   (no arguments: all three steps)');
  process.exit(2);
}
const wanted = new Set(requested.length ? requested.map(Number) : [1, 2, 3]);
// Chrome on macOS may take the UI language from AppleLanguages rather than --lang. The pair --lang plus -AppleLanguages
// is the one that switched Chrome's UI language in a check.
const LANG_ARGS = { en: ['--lang=en-US', '-AppleLanguages', '(en)'], ru: ['--lang=ru', '-AppleLanguages', '(ru)'] };
const LOAD_UNPACKED = { en: 'Load unpacked', ru: 'Загрузить распакованное' };
const BOX = { width: 168, height: 105 }; // the picture on the steps screen, in points; files are 2x
// The Load unpacked picture covers the same area in both languages: the Russian button, 286 px wide, plus margins.
// Cropped to the English button (128 px) it would cut the title, the next button and the list on the 16:10 frame.
const LOAD_UNPACKED_AREA = 328;

// Rings the toolbar elements in the accent colour and returns the area around them, 16:10, inside the page,
// at least minWidth wide.
const ring = (ids, on, minWidth = BOX.width) => `(() => {
  const toolbar = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot;
  const found = ${JSON.stringify(ids)}.map((id) => toolbar?.querySelector('#' + id)).filter(Boolean);
  if (!found.length) return null;
  const target = found[found.length - 1];
  if (${on}) { target.style.outline = '3px solid #A99EFC'; target.style.outlineOffset = '3px'; }
  else { target.style.outline = ''; return null; }
  const boxes = found.map((el) => el.getBoundingClientRect());
  const left = Math.min(...boxes.map((b) => b.left)), right = Math.max(...boxes.map((b) => b.right));
  const top = Math.min(...boxes.map((b) => b.top)), bottom = Math.max(...boxes.map((b) => b.bottom));
  // width is a multiple of 8, so that height = width * 5/8 is a whole number and the file is exactly 336x210
  const width = 8 * Math.ceil(Math.max(${minWidth}, right - left + 40) / 8);
  const height = width * ${BOX.height / BOX.width};
  const clamp = (v, max) => Math.max(0, Math.min(v, max));
  return { text: target.textContent.trim(),
    x: clamp((left + right) / 2 - width / 2, innerWidth - width), y: clamp((top + bottom) / 2 - height / 2, innerHeight - height),
    width, height };
})()`;

// Chrome for Testing on a Mac that registers external extensions (system-wide External Extensions folder) may show the
// card of a foreign extension on chrome://extensions, asynchronously, ~1.5–2.5 s after the page opens.
// No extension of ours is loaded here, so the expected number of cards is 0. The cards are removed through the shadow roots
// (extensions-manager → extensions-item-list → extensions-item) and a shot is never written while one is on the page.
const EXPECTED_CARDS = 0;
const cardList = `document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot`;
const CARD_IDS = `(() => [...(${cardList}?.querySelectorAll('extensions-item') ?? [])].map((card) => card.id))()`;
const DROP_CARDS = `(() => { const cards = [...(${cardList}?.querySelectorAll('extensions-item') ?? [])]; cards.forEach((card) => card.remove()); return cards.map((card) => card.id); })()`;

async function dropForeignCards(cdp, sessionId, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await evaluate(cdp, sessionId, DROP_CARDS);
    await sleep(200);
    const left = await evaluate(cdp, sessionId, CARD_IDS);
    if (left.length === EXPECTED_CARDS) return;
    if (attempt === 2) throw new Error(`${label}: ${left.length} extension card(s) on chrome://extensions after removing them twice (${left.join(', ')}), expected ${EXPECTED_CARDS}`);
  }
}

// guard: the page is chrome://extensions. Cards are removed right before the shot and checked again right after it;
// the file is written only when no card is on the page, so a shot with a foreign card never reaches the disk.
async function shot(cdp, sessionId, clip, file, guard = null) {
  const scale = clip ? BOX.width / clip.width : 1;
  const params = clip ? { format: 'png', clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale } } : { format: 'png' };
  if (guard) await dropForeignCards(cdp, sessionId, guard);
  const { data } = await cdp.send('Page.captureScreenshot', params, sessionId);
  if (guard) {
    const after = await evaluate(cdp, sessionId, CARD_IDS);
    if (after.length !== EXPECTED_CARDS) throw new Error(`${guard}: an extension card appeared during the shot (${after.join(', ')}); ${path.basename(file)} not written`);
  }
  await writeFile(file, Buffer.from(data, 'base64'));
}

for (const locale of ['en', 'ru']) {
  const out = path.join(here, locale);
  await mkdir(out, { recursive: true });
  const downloads = await mkdtemp(path.join(tmpdir(), 'mbc-steps-'));
  const browser = await launch({ downloadDir: downloads, extraArgs: LANG_ARGS[locale] });
  try {
    const { cdp } = browser;
    if (wanted.has(3)) {
      const picker = await openPage(cdp, `${pathToFileURL(path.join(here, 'folder-picker.html'))}?lang=${locale}`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...BOX, deviceScaleFactor: 2, mobile: false }, picker.sessionId);
      await sleep(200);
      await shot(cdp, picker.sessionId, null, path.join(out, 'step-3.png'));
    }
    if (!wanted.has(1) && !wanted.has(2)) continue;

    const page = await openPage(cdp, 'chrome://extensions');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, page.sessionId);
    await sleep(3000); // once: the foreign extension card arrives ~1.5–2.5 s after the page opens; shot() removes and re-checks anyway
    await evaluate(cdp, page.sessionId, `(() => {
      const toggle = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode');
      if (toggle && !toggle.checked) toggle.click();
    })()`);
    await sleep(800); // the drawer with "Load unpacked" slides in
    if (wanted.has(1)) {
      const devMode = await evaluate(cdp, page.sessionId, ring(['devModeLabel', 'devMode'], true));
      if (!devMode) throw new Error(`${locale}: no Developer mode toggle on chrome://extensions`);
      await shot(cdp, page.sessionId, devMode, path.join(out, 'step-1.png'), `${locale} step-1`);
      await evaluate(cdp, page.sessionId, ring(['devMode'], false));
    }
    if (wanted.has(2)) {
      const loadUnpacked = await evaluate(cdp, page.sessionId, ring(['loadUnpacked'], true, LOAD_UNPACKED_AREA));
      if (!loadUnpacked) throw new Error(`${locale}: no "Load unpacked" button after turning Developer mode on`);
      if (!loadUnpacked.text.includes(LOAD_UNPACKED[locale])) {
        throw new Error(`${locale}: the button reads "${loadUnpacked.text}", the UI language did not switch`);
      }
      await shot(cdp, page.sessionId, loadUnpacked, path.join(out, 'step-2.png'), `${locale} step-2`);
    }
  } finally {
    await browser.close();
    await rm(downloads, { recursive: true, force: true });
  }
}
console.log(`STEPS ${wanted.size * 2} ${here}`);

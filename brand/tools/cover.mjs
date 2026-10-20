#!/usr/bin/env node
// brand/cover.jpg (1280×640, under GitHub's 1 MB limit for a social preview) from brand/cover.html.
// Run from the repo root: node brand/tools/cover.mjs   (MBC_CHROME → Chrome for Testing; its headless shell will do)
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../../extension/test/harness/browser.mjs';
import { evaluate, openPage } from '../../extension/test/harness/cdp.mjs';

// Chrome embeds an sRGB colour profile in its JPEG screenshots. Drop every APPn segment but JFIF (APP0) and every comment,
// so the cover carries no metadata; with no profile, viewers read the picture as sRGB, which is what it is.
function withoutMetadata(jpeg) {
  const parts = [jpeg.subarray(0, 2)];
  let at = 2;
  while (at < jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xda) break;
    const end = at + 2 + jpeg.readUInt16BE(at + 2);
    if (marker === 0xe0 || !(marker === 0xfe || (marker >= 0xe1 && marker <= 0xef))) parts.push(jpeg.subarray(at, end));
    at = end;
  }
  parts.push(jpeg.subarray(at));
  return Buffer.concat(parts);
}

const brand = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(brand, 'cover.jpg');
const downloads = await mkdtemp(path.join(tmpdir(), 'mbc-cover-'));
// file:// pages may not load fonts from a sibling folder without this switch.
const browser = await launch({ downloadDir: downloads, extraArgs: ['--allow-file-access-from-files'] });
try {
  const { cdp } = browser;
  const page = await openPage(cdp, pathToFileURL(path.join(brand, 'cover.html')).href);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false }, page.sessionId);
  const ready = await evaluate(cdp, page.sessionId, `document.fonts.ready.then(() => ({
    onest: document.fonts.check('700 72px Onest'),
    broken: [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute('src')),
  }))`);
  if (!ready.onest) throw new Error('Onest did not load: check site/assets/fonts/onest-variable.woff2');
  if (ready.broken.length) throw new Error(`pictures did not load: ${ready.broken.join(', ')}`);
  const { data } = await cdp.send('Page.captureScreenshot',
    { format: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1280, height: 640, scale: 1 } }, page.sessionId);
  await writeFile(out, withoutMetadata(Buffer.from(data, 'base64')));
  const { size } = await stat(out);
  if (size > 1_000_000) throw new Error(`cover is ${size} bytes, GitHub takes up to 1 MB`);
  console.log(`COVER ${out} 1280x640 ${size} bytes`);
} finally {
  await browser.close();
  await rm(downloads, { recursive: true, force: true });
}

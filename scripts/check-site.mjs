#!/usr/bin/env node
// Opens site/index.html and site/ru/index.html from disk at 1280 and 390 px wide and checks what a visitor would hit:
// the Onest font, broken pictures, sideways scrolling, in-page anchors and links to files of the site, and the cover
// for link previews (og:image: it has to exist and stay within 1 MB).
// Full-page shots go to dist/captures/site/<lang>-<width>.png. Run from anywhere: node scripts/check-site.mjs
// (MBC_CHROME → Chrome for Testing; its headless shell will do). Prints SITE OK 4 or throws with the list of problems.
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../extension/test/harness/browser.mjs';
import { evaluate, openPage, sleep } from '../extension/test/harness/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const out = path.join(root, 'dist', 'captures', 'site');
await mkdir(out, { recursive: true });

const PAGES = { en: path.join(site, 'index.html'), ru: path.join(site, 'ru', 'index.html') };
const WIDTHS = [1280, 390];
const PROBE = `document.fonts.ready.then(() => ({
  onest: document.fonts.check('700 40px Onest'),
  broken: [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute('src')),
  sideways: document.documentElement.scrollWidth - innerWidth,
  anchors: [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1))
    .filter((id) => id && !document.getElementById(id)),
  files: [...document.querySelectorAll('a[href], link[href], img[src]')].map((e) => e.href || e.src)
    .filter((u) => u.startsWith('file:')).map((u) => u.split('#')[0]),
  height: Math.ceil(document.documentElement.getBoundingClientRect().height),
}))`;

// A link must name a file of the site: opened from disk, a link to a folder shows a file listing instead of its index.html.
const missingFile = (url) => {
  const p = fileURLToPath(url);
  if (existsSync(p) && statSync(p).isDirectory()) return `${path.relative(root, p) || '.'}/ (a folder: link to its index.html)`;
  return existsSync(p) && p.startsWith(site + path.sep) ? null : path.relative(root, p);
};

const downloads = await mkdtemp(path.join(tmpdir(), 'mbc-site-'));
const browser = await launch({ downloadDir: downloads, extraArgs: ['--allow-file-access-from-files'] });
const problems = [];
let checked = 0;
const cover = path.join(site, 'assets', 'media', 'cover.jpg');
if (!existsSync(cover)) problems.push(`missing file ${path.relative(root, cover)} (og:image)`);
else if (statSync(cover).size > 1024 * 1024) problems.push(`${path.relative(root, cover)} is ${statSync(cover).size} bytes, over 1 MB (og:image)`);
try {
  const { cdp } = browser;
  for (const [lang, file] of Object.entries(PAGES)) {
    for (const width of WIDTHS) {
      const page = await openPage(cdp, pathToFileURL(file).href);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 }, page.sessionId);
      await sleep(300);
      const r = await evaluate(cdp, page.sessionId, PROBE);
      const where = `${lang} ${width}px`;
      if (!r.onest) problems.push(`${where}: Onest did not load`);
      for (const src of r.broken) problems.push(`${where}: broken picture ${src}`);
      if (r.sideways > 0) problems.push(`${where}: the page scrolls sideways by ${r.sideways}px`);
      for (const id of r.anchors) problems.push(`${where}: no element with id "${id}"`);
      for (const f of new Set(r.files)) { const m = missingFile(f); if (m) problems.push(`${where}: missing file ${m}`); }
      const { data } = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: r.height, scale: 1 } }, page.sessionId);
      await writeFile(path.join(out, `${lang}-${width}.png`), Buffer.from(data, 'base64'));
      console.log(`SITE ${lang} ${width} ${r.height}px tall`);
      checked += 1;
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
    }
  }
} finally {
  await browser.close();
  await rm(downloads, { recursive: true, force: true });
}
if (problems.length) throw new Error(`site check failed:\n${problems.join('\n')}`);
console.log(`SITE OK ${checked} → ${path.relative(root, out)}`);

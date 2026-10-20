#!/usr/bin/env node
// Opens site/index.html and site/ru/index.html from disk and checks what a visitor would hit:
// the SPELLLENS font of the headings and the Onest font, broken pictures, sideways scrolling, in-page anchors and links
// to files of the site (scripts too), errors on the page, and the cover for link previews (og:image: it has to exist
// and stay within 1 MB).
// Each page is opened at 1280, 1024, 860 and 390 px wide (900 tall), at 1280×700 and at 960×640. The animated frames
// have to get their scene within 5 s and play; the install steps sit under a sticky frame only on screens 960 px wide
// and 640 px tall, and there each of the five steps is scrolled to: it has to open, show its scene and fit the screen.
// Two more passes per language at 1280×900: without JavaScript (every step text shows, no empty frames) and with
// reduced motion (steps one under another, nothing animates).
// Full-page shots go to dist/captures/site/<lang>-<width>x<height>.png. Run from anywhere: node scripts/check-site.mjs
// (MBC_CHROME → Chrome for Testing; its headless shell will do). Prints SITE OK 16 or throws with the list of problems.
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../extension/test/harness/browser.mjs';
import { attach, evaluate, sleep, waitForLoad } from '../extension/test/harness/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const out = path.join(root, 'dist', 'captures', 'site');
await mkdir(out, { recursive: true });

const PAGES = { en: path.join(site, 'index.html'), ru: path.join(site, 'ru', 'index.html') };
const SIZES = [[1280, 900], [1024, 900], [860, 900], [390, 900], [1280, 700], [960, 640]];
const shown = `(e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'`;
const PROBE = `document.fonts.ready.then(() => ({
  onest: document.fonts.check('700 40px Onest'),
  spelllens: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'SPELLLENS' && f.status === 'loaded')
    && getComputedStyle(document.querySelector('h1')).fontFamily.startsWith('SPELLLENS'),
  broken: [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute('src')),
  sideways: document.documentElement.scrollWidth - innerWidth,
  anchors: [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1))
    .filter((id) => id && !document.getElementById(id)),
  files: [...document.querySelectorAll('a[href], link[href], img[src], script[src]')].map((e) => e.href || e.src)
    .filter((u) => u.startsWith('file:')).map((u) => u.split('#')[0]),
  sticky: getComputedStyle(document.querySelector('.steps__sticky')).position === 'sticky',
  emptyFrames: [...document.querySelectorAll('[data-scene]')].filter(${shown}).filter((s) => !s.querySelector('.scene'))
    .map((s) => s.dataset.scene),
  hiddenSteps: [...document.querySelectorAll('.steps__list .d')].filter((d) => !(${shown})(d) || d.offsetHeight < 10)
    .map((d) => d.closest('li').querySelector('.n').textContent),
  running: document.getAnimations().filter((a) => a.playState === 'running').length,
  unscaled: [...document.querySelectorAll('[data-scene]')].filter(${shown})
    .filter((s) => !(parseFloat(getComputedStyle(s).getPropertyValue('--k')) > 0)).map((s) => s.dataset.scene),
  height: Math.ceil(document.documentElement.getBoundingClientRect().height),
}))`;
// In the sticky layout: scroll to the middle of step k's share of the track and report what the visitor sees.
const STEP = (k) => `(async () => {
  const track = document.querySelector('.steps__track'), sticky = document.querySelector('.steps__sticky');
  const stick = parseFloat(getComputedStyle(sticky).top) || 0, span = track.offsetHeight - sticky.offsetHeight;
  scrollTo(0, track.getBoundingClientRect().top + scrollY - stick + ((${k} + 0.5) / 5) * span);
  await new Promise((r) => setTimeout(r, 700));
  const items = [...document.querySelectorAll('.steps__list li')];
  const frame = document.querySelector('.steps__frame [data-scene]');
  const on = [...frame.querySelectorAll('.scene')].findIndex((s) => s.classList.contains('is-on'));
  return {
    active: items.map((li, i) => li.classList.contains('is-active') ? i : -1).filter((i) => i >= 0),
    open: items.map((li, i) => li.querySelector('.d').inert ? -1 : i).filter((i) => i >= 0),
    label: frame.getAttribute('aria-label') === items[${k}].querySelector('[data-scene]').getAttribute('aria-label'),
    on,
    playing: frame.getAnimations({ subtree: true }).some((a) => a.playState === 'running'),
    overflow: sticky.scrollHeight - sticky.clientHeight,
    below: Math.ceil(sticky.getBoundingClientRect().bottom - innerHeight),
  };
})()`;

// Every visible frame has its scene and every picture has loaded (or failed): then the probe sees the settled page.
const SETTLED = `[...document.querySelectorAll('[data-scene]')].filter(${shown}).every((s) => s.querySelector('.scene'))
  && [...document.images].every((i) => i.complete)`;

// A link must name a file of the site: opened from disk, a link to a folder shows a file listing instead of its index.html.
const missingFile = (url) => {
  const p = fileURLToPath(url);
  if (existsSync(p) && statSync(p).isDirectory()) return `${path.relative(root, p) || '.'}/ (a folder: link to its index.html)`;
  return existsSync(p) && p.startsWith(site + path.sep) ? null : path.relative(root, p);
};

const downloads = await mkdtemp(path.join(tmpdir(), 'mbc-site-'));
const browser = await launch({ downloadDir: downloads, extraArgs: ['--allow-file-access-from-files'] });
const { cdp } = browser;
const problems = [];
let checked = 0;
const cover = path.join(site, 'assets', 'media', 'cover.jpg');
if (!existsSync(cover)) problems.push(`missing file ${path.relative(root, cover)} (og:image)`);
else if (statSync(cover).size > 1024 * 1024) problems.push(`${path.relative(root, cover)} is ${statSync(cover).size} bytes, over 1 MB (og:image)`);

// Errors are collected from before the navigation, so an exception thrown while the page loads is not missed.
async function open(url, { width, height, js = true, reduce = false }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await attach(cdp, targetId);
  const errors = [];
  const off = cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
    }
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
  if (!js) await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
  if (reduce) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitForLoad(cdp, sessionId, 15000, url);
  return { targetId, sessionId, errors, close: async () => { off(); await cdp.send('Target.closeTarget', { targetId }); } };
}

async function check(lang, file, { width, height, js = true, reduce = false }) {
  const pass = !js ? 'no-js' : reduce ? 'reduced-motion' : `${width}x${height}`;
  const where = `${lang} ${pass}`;
  const page = await open(pathToFileURL(file).href, { width, height, js, reduce });
  try {
    const until = Date.now() + 5000;
    let settled = false;
    while (!settled && Date.now() < until) {
      settled = await evaluate(cdp, page.sessionId, SETTLED);
      if (!settled) await sleep(100);
    }
    if (!settled) problems.push(`${where}: frames or pictures still loading after 5 s`);
    await sleep(500); // let the step text open and the first scene start
    const r = await evaluate(cdp, page.sessionId, PROBE);
    if (!r.onest) problems.push(`${where}: Onest did not load`);
    if (!r.spelllens) problems.push(`${where}: the headings are not set in SPELLLENS`);
    for (const src of r.broken) problems.push(`${where}: broken picture ${src}`);
    if (r.sideways > 0) problems.push(`${where}: the page scrolls sideways by ${r.sideways}px`);
    for (const id of r.anchors) problems.push(`${where}: no element with id "${id}"`);
    for (const f of new Set(r.files)) { const m = missingFile(f); if (m) problems.push(`${where}: missing file ${m}`); }
    for (const s of r.emptyFrames) problems.push(`${where}: the ${s} frame shows without its scene`);
    for (const e of page.errors) problems.push(`${where}: page error: ${e}`);
    const sticky = js && !reduce && width >= 960 && height >= 640;
    if (r.sticky !== sticky) problems.push(`${where}: install steps ${r.sticky ? 'are' : 'are not'} under a sticky frame`);
    if (!sticky) for (const n of r.hiddenSteps) problems.push(`${where}: the text of step ${n} is hidden`);
    if (reduce && r.running) problems.push(`${where}: ${r.running} animations run with reduced motion`);
    if (js && !reduce) {
      const plays = await evaluate(cdp, page.sessionId, `(async () => {
        const hero = document.querySelector('[data-scene="hero"]');
        hero.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 400));
        const on = hero.getAnimations({ subtree: true }).some((a) => a.playState === 'running');
        scrollTo(0, 0);
        return on;
      })()`);
      if (!plays) problems.push(`${where}: the hero scene does not play when in view`);
    }
    for (const s of r.unscaled) problems.push(`${where}: the ${s} frame has no scale (--k)`);
    if (r.sticky && js && !reduce) {
      for (let k = 0; k < 5; k += 1) {
        const s = await evaluate(cdp, page.sessionId, STEP(k));
        const step = `${where} step ${k + 1}`;
        if (s.active.join() !== String(k)) problems.push(`${step}: active steps [${s.active}]`);
        if (s.open.join() !== String(k)) problems.push(`${step}: open step texts [${s.open}]`);
        if (s.on !== k) problems.push(`${step}: the frame shows scene ${s.on + 1}`);
        if (!s.label) problems.push(`${step}: the frame's aria-label is not the step's`);
        if (!s.playing) problems.push(`${step}: the frame's scene does not play`);
        if (s.overflow > 1 || s.below > 1) problems.push(`${step}: the sticky block overflows by ${Math.max(s.overflow, s.below)}px`);
      }
      await evaluate(cdp, page.sessionId, 'scrollTo(0, 0)');
    }
    if (js && !reduce) {
      const { data } = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: r.height, scale: 1 } }, page.sessionId);
      await writeFile(path.join(out, `${lang}-${width}x${height}.png`), Buffer.from(data, 'base64'));
    }
    console.log(`SITE ${where} ${r.height}px tall`);
    checked += 1;
  } finally {
    await page.close();
  }
}

try {
  for (const [lang, file] of Object.entries(PAGES)) {
    for (const [width, height] of SIZES) await check(lang, file, { width, height });
    await check(lang, file, { width: 1280, height: 900, js: false });
    await check(lang, file, { width: 1280, height: 900, reduce: true });
  }
} finally {
  await browser.close();
  await rm(downloads, { recursive: true, force: true });
}
if (problems.length) throw new Error(`site check failed:\n${problems.join('\n')}`);
console.log(`SITE OK ${checked} → ${path.relative(root, out)}`);

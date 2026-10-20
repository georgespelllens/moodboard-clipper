#!/usr/bin/env node
// Rig self-check without an extension: resolver rules, local HTTPS, generated images, CDP downloads,
// and that fixture mode reaches only the fixture server (every unmapped host fails to resolve).
// Works on any Chromium build, including chrome-headless-shell.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowDownloads, launch } from './browser.mjs';
import { attach, evaluate, openPage, sleep } from './cdp.mjs';
import { startFixtures } from './fixture-server.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
};
let fixtures = null;
let downloads = null;
let browser = null;
try {
  fixtures = await startFixtures({ pagesDir: path.join(app, 'test/fixtures/pages') });
  downloads = await realpath(await mkdtemp(path.join(tmpdir(), 'mbc-selfcheck-')));
  browser = await launch({ downloadDir: downloads, fixturePort: fixtures.port });
  const { cdp } = browser;
  for (const url of ['https://www.pinterest.com/fixture/probe/', 'https://www.cosmos.so/fixture/probe', 'https://fixture.test/frames.html']) {
    const page = await openPage(cdp, url);
    expect(url, await evaluate(cdp, page.sessionId, `document.title + ' / ' + document.getElementById('top-img').naturalWidth`), 'frames fixture / 640');
    await cdp.send('Target.closeTarget', { targetId: page.targetId });
  }
  await allowDownloads(cdp, downloads);
  const page = await openPage(cdp, 'https://fixture.test/frames.html');
  const before = fixtures.log.length; // frames.html already loaded the image: only requests after this point count
  await evaluate(cdp, page.sessionId, `(() => { const a = document.createElement('a'); a.href = '/img/web-1.png'; a.download = 'web-1.png'; document.body.append(a); a.click(); })()`);
  const file = path.join(downloads, 'web-1.png');
  for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100);
  expect('download keeps its name', existsSync(file), true);
  expect('download is the fixture image', existsSync(file) && (await readFile(file)).equals(fixtures.body('fixture.test/img/web-1.png')), true);
  expect('fixture server saw GET /img/web-1.png', fixtures.log.slice(before).some((r) => r.host === 'fixture.test' && r.path === '/img/web-1.png' && r.method === 'GET'), true);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // Network scope: hosts outside the mapped set must fail to resolve instead of reaching the fixture server.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, sessionId);
  for (const url of ['https://example.com/', 'https://pinterest.com/', 'https://s.pinimg.com/']) {
    const nav = await cdp.send('Page.navigate', { url }, sessionId);
    expect(`${url} does not resolve`, nav.errorText, 'net::ERR_NAME_NOT_RESOLVED');
    console.log(`     errorText: ${nav.errorText}`);
  }
  await cdp.send('Target.closeTarget', { targetId });
  const strays = fixtures.log.filter((r) => ['example.com', 'pinterest.com', 's.pinimg.com'].includes(r.host)).length;
  expect('unmapped hosts never reached the fixture server', strays, 0);
} catch (error) {
  failures.push(`error: ${error?.message || error}`);
  console.error(error);
} finally {
  // Each cleanup step runs on its own: one failure must not skip the others.
  for (const [name, step] of [['browser.close', () => browser?.close()], ['fixtures.close', () => fixtures?.close()],
    ['rm downloads', () => downloads && rm(downloads, { recursive: true, force: true })]]) {
    try { await step(); } catch (error) { failures.push(`cleanup ${name}: ${error?.message || error}`); console.error(`cleanup ${name} failed`, error); }
  }
}
console.log(failures.length ? `SELFCHECK FAILED: ${failures.join(', ')}` : 'SELFCHECK OK');
process.exit(failures.length ? 1 : 0);

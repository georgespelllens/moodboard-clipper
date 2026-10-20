// Launches Chrome for Testing directly (not branded Chrome: it ignores --load-extension).
// MBC_LOAD=pipe loads the extension over the DevTools pipe instead (Extensions.loadUnpacked): branded Chrome, Yandex.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from './cdp.mjs';

export const FIXTURE_HOSTS = ['*.pinterest.com', 'i.pinimg.com', '*.cosmos.so', 'fixture.test'];

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const within = (promise, ms) => { // resolves when promise does or after ms, without leaving a timer behind
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

export async function launch({ extensionDir = null, downloadDir, fixturePort = null, hosts = FIXTURE_HOSTS,
  headless = process.env.MBC_HEADFUL !== '1', chrome = process.env.MBC_CHROME, extraArgs = [], promptForDownload = false, loadVia = process.env.MBC_LOAD ?? 'flag' } = {}) {
  if (!chrome || !existsSync(chrome)) throw new Error('MBC_CHROME must point to Chrome for Testing');
  const viaPipe = Boolean(extensionDir) && loadVia === 'pipe';
  const profile = await mkdtemp(path.join(tmpdir(), 'mbc-profile-'));
  let child = null;
  let cdp = null;
  let stderr = '';
  let spawnError = null;
  let markExited;
  const exited = new Promise((resolve) => { markExited = resolve; });
  const running = () => child?.pid !== undefined && child.exitCode === null && child.signalCode === null;
  // SIGKILL (if still running), then wait for the exit event: only then is the profile dir safe to remove.
  const reap = async () => { if (!child) return; if (running()) child.kill('SIGKILL'); await within(exited, 5000); };
  try {
    await mkdir(path.join(profile, 'Default'), { recursive: true });
    await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: promptForDownload, directory_upgrade: true },
    }));
    const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
      '--no-default-browser-check', '--disable-component-update', '--disable-background-networking', '--window-size=1280,900',
      '--use-mock-keychain', '--password-store=basic']; // no Keychain prompt (it would take focus)
    if (headless) args.push('--headless=new');
    if (viaPipe) args.push('--remote-debugging-pipe', '--enable-unsafe-extension-debugging');
    else if (extensionDir) args.push(`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`);
    if (fixturePort) {
      // First match wins: mapped hosts go to the fixture server, every other host (apex pinterest.com, s.pinimg.com,
      // Google background traffic) fails to resolve, so --ignore-certificate-errors only ever reaches the fixture server.
      const rules = [...hosts.map((h) => `MAP ${h} 127.0.0.1:${fixturePort}`), 'MAP * ~NOTFOUND'];
      args.push(`--host-resolver-rules=${rules.join(', ')}`, '--ignore-certificate-errors');
    }
    args.push(...extraArgs); // with -AppleLanguages (xx) Chrome reads (xx) as a URL: about:blank on top of it fails headless
    if (!extraArgs.length) args.push('about:blank');
    child = spawn(chrome, args, { stdio: viaPipe ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'] });
    child.on('exit', markExited);
    child.on('error', (error) => { spawnError ||= error; if (child.pid === undefined) markExited(); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    let wsPath;
    for (let i = 0; i < 150 && !port; i++) {
      if (spawnError) throw new Error(`Chrome failed to start (${chrome}): ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chrome exited ${child.exitCode ?? child.signalCode}: ${stderr}`);
      // Two non-empty lines (port, ws path): a half-written file is never read.
      const lines = existsSync(portFile) ? (await readFile(portFile, 'utf8').catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean) : [];
      if (lines.length >= 2) [port, wsPath] = lines;
      else await sleep(100);
    }
    if (!port) throw new Error(`DevToolsActivePort did not appear within 15 s: ${stderr}`);
    cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`);
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    // Yandex ignores --ignore-certificate-errors; the browser-wide CDP switch reaches only the fixture server too.
    if (fixturePort) await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
    if (viaPipe) await loadOverPipe(child, extensionDir);
  } catch (error) {
    cdp?.close();
    await reap();
    await rm(profile, RM).catch(() => null); // keep the original failure, not a cleanup one
    throw error;
  }
  async function close() {
    try {
      await cdp.send('Browser.close', {}, undefined, 3000).catch(() => null); // reply or socket close; gives up after 3 s
      await within(exited, 5000);
      await reap();
    } finally {
      cdp.close();
      await rm(profile, RM);
    }
  }
  return { cdp, profile, close, stderr: () => stderr };
}

// Extensions.loadUnpacked answers only on the pipe (fd 3 in, fd 4 out, messages end with \0); the socket does the rest.
async function loadOverPipe(child, extensionDir) {
  let buf = '';
  const reply = new Promise((resolve, reject) => {
    child.stdio[4].on('data', (chunk) => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) {
        const message = JSON.parse(buf.slice(0, i));
        if (message.id !== 1) continue;
        if (message.error) reject(new Error(`Extensions.loadUnpacked: ${message.error.message}`));
        else resolve(message.result.id);
      }
    });
  });
  child.stdio[3].write(`${JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extensionDir } })}\0`);
  const id = await within(reply, 10000);
  if (!id) throw new Error('Extensions.loadUnpacked did not answer within 10 s');
  return id;
}

// Fallback (b): explicit CDP download behaviour when Preferences alone do not apply.
export async function allowDownloads(cdp, downloadDir) {
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
}

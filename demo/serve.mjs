// Demo feed for the README GIF and the video: the pictures from demo/works on a page shaped like a Pinterest feed, served under
// the real hostnames through --host-resolver-rules, the same way as extension/test/harness/fixture-server.mjs.
// The extension sees www.pinterest.com and i.pinimg.com; nobody else's pictures are in the frame.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_HOSTS = ['www.pinterest.com', 'i.pinimg.com', 'demo.test'];
export const FEED_URL = 'https://www.pinterest.com/demo/';
export const folderUrl = (board, lang) => `https://demo.test/folder?board=${encodeURIComponent(board)}&lang=${lang}`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', json: 'application/json' };
const typeOf = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';

// works.json: [{ "file": "01.jpg", "title": "…" }]. The pin ids are synthetic: 1000000000000001NN.
export function loadWorks(dir = path.join(here, 'works')) {
  const list = JSON.parse(readFileSync(path.join(dir, 'works.json'), 'utf8'));
  return list.map((w, i) => {
    const file = path.join(dir, w.file);
    if (!existsSync(file)) throw new Error(`demo: ${w.file} is listed in works.json but missing`);
    const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    const [width, height] = ['pixelWidth', 'pixelHeight'].map((k) => Number(new RegExp(`${k}:\\s*(\\d+)`).exec(size)[1]));
    return { ...w, path: file, width, height, pin: `1000000000000001${String(i + 1).padStart(2, '0')}` };
  });
}

function card(w) {
  const base = (size) => `https://i.pinimg.com/${size}/demo/${w.file}`;
  const srcset = `${base('236x')} 1x, ${base('474x')} 2x, ${base('736x')} 3x, ${base('originals')} 4x`;
  return `<div class="item" data-grid-item="true" role="listitem"><div data-test-id="pin" data-test-pin-id="${w.pin}">`
    + `<a href="/pin/${w.pin}/" aria-label="${esc(w.title)}"><img src="${base('236x')}" srcset="${srcset}" `
    + `width="${w.width}" height="${w.height}" alt="${esc(w.title)}"></a></div><p>${esc(w.title)}</p></div>`;
}

const LABELS = {
  en: {
    downloads: 'Downloads', items: (n) => `${n} items`,
    search: 'moodboard · references', tag: 'Demo feed · pictures drawn for the demo',
  },
  ru: {
    downloads: 'Загрузки', items: (n) => `объектов: ${n}`,
    search: 'мудборд · референсы', tag: 'Демо-лента · картинки нарисованы для демо',
  },
};

function folderPage(inboxDir, board, lang) {
  const t = LABELS[lang] ?? LABELS.en;
  const dir = path.join(inboxDir, board);
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.') && !n.endsWith('.crdownload')).sort() : [];
  const tiles = names.map((name) => {
    const src = `/inbox/${encodeURIComponent(board)}/${encodeURIComponent(name)}`;
    const icon = name.endsWith('.json') ? '<div class="doc"><span>JSON</span></div>' : `<img src="${src}" alt="">`;
    return `<figure>${icon}<figcaption>${esc(name)}</figcaption></figure>`;
  }).join('');
  return readFileSync(path.join(here, 'folder.html'), 'utf8')
    .replaceAll('{{lang}}', () => esc(lang)).replaceAll('{{downloads}}', () => esc(t.downloads)).replaceAll('{{board}}', () => esc(board))
    .replace('{{count}}', () => esc(t.items(names.length))).replace('{{tiles}}', () => tiles);
}

// inboxDir: the browser's download folder plus /moodboard-inbox; the folder page lists what the extension really saved.
export async function startDemo({ works = loadWorks(), inboxDir = null, lang = 'en' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbc-demo-'));
  try {
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
      '-days', '2', '-subj', '/CN=demo.test'], { stdio: 'ignore' });
    const t = LABELS[lang] ?? LABELS.en;
    const feed = readFileSync(path.join(here, 'feed.html'), 'utf8')
      .replace('{{lang}}', () => esc(LABELS[lang] ? lang : 'en')).replace('{{search}}', () => esc(t.search))
      .replace('{{tag}}', () => esc(t.tag)).replace('{{cards}}', () => works.map(card).join('\n'));
    const send = (req, res, status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
      try {
        const host = (req.headers.host || '').split(':')[0];
        const url = new URL(req.url, `https://${host}`);
        if (host === 'www.pinterest.com' && url.pathname === '/demo/') return send(req, res, 200, 'text/html; charset=utf-8', Buffer.from(feed));
        const image = host === 'i.pinimg.com' && /^\/(?:236x|474x|736x|originals)\/demo\/([^/]+)$/.exec(url.pathname);
        const work = image && works.find((w) => w.file === decodeURIComponent(image[1]));
        if (work) return send(req, res, 200, typeOf(work.file), readFileSync(work.path));
        if (host === 'demo.test' && url.pathname === '/folder' && inboxDir) {
          const html = folderPage(inboxDir, url.searchParams.get('board') || 'unsorted', url.searchParams.get('lang') || 'en');
          return send(req, res, 200, 'text/html; charset=utf-8', Buffer.from(html));
        }
        const saved = host === 'demo.test' && inboxDir && /^\/inbox\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (saved) {
          const [board, name] = saved.slice(1).map(decodeURIComponent);
          const file = path.join(inboxDir, path.basename(board), path.basename(name));
          if (existsSync(file) && statSync(file).isFile()) return send(req, res, 200, typeOf(name), readFileSync(file));
        }
        send(req, res, 404, 'text/plain', Buffer.from('not found'));
      } catch (error) {
        console.error(`demo handler failed: ${req.method} ${req.url}`, error);
        if (!res.headersSent) send(req, res, 500, 'text/plain', Buffer.from('error'));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    return {
      port: server.address().port,
      works,
      close: () => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
      }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

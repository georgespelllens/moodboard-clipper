// Local HTTPS fixtures served under real hostnames via --host-resolver-rules.
// Images are generated at runtime, so the repository keeps no binary fixtures.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// shown = 236x feed image; original: extension that exists under /originals/, null = none (736x wins).
// closeup: a 1200x copy exists, like the real pin closeup page.
export const PINS = [
  { id: '9001', path: '0a/01/01/pin1', original: 'jpg', headBlocked: true, color: [200, 40, 40] },
  { id: '9002', path: '0a/02/02/pin2', original: 'png', closeup: true, color: [40, 160, 40] },
  // 9003 has no original and no 1200x copy, so the extension's ladder must fall through to 736x.
  { id: '9003', path: '0a/03/03/pin3', original: null, color: [40, 40, 200] },
  { id: '9004', path: '0a/04/04/pin4', original: 'jpg', video: true, color: [200, 160, 40] },
  // 9005: jpg thumbnails, png original named only by the srcset 4x entry, as in real data. HEAD is blocked, and the .jpg
  // under /originals/ does not exist: the extension must take the srcset entry instead of guessing an extension.
  { id: '9005', path: '0a/05/05/pin5', original: 'png', headBlocked: true, color: [200, 90, 150] },
];
// The Cosmos CDN with no query returns the full-size file; this cap stands in for the original's width
// (and is the largest ?w= the fixture honours).
export const COSMOS_MAX_WIDTH = 2000;
// Cosmos CDN shape checked against test/fixtures/markup-notes.md.
// 1001 and 1002 are feed tiles; 1003 appears only on the element page.
export const ELEMENTS = [
  { id: '1001', asset: '7d1c0000-0000-4000-8000-000000000001', color: [120, 40, 160] },
  { id: '1002', asset: '7d1c0000-0000-4000-8000-000000000002', color: [40, 160, 160] },
  { id: '1003', asset: '7d1c0000-0000-4000-8000-000000000003', color: [160, 120, 40] },
];
// type: content-type header (default image/png); null = no content-type header at all.
export const WEB = [
  { name: 'web-1.png', color: [90, 90, 90] },
  { name: 'noext', color: [160, 90, 40] },
  { name: 'noext-octet', color: [160, 90, 40], type: 'application/octet-stream' },
  { name: 'noext-untyped', color: [160, 90, 40], type: null },
];
export const PAGES = {
  'www.pinterest.com/fixture/feed/': 'pinterest-feed.html',
  'www.cosmos.so/fixture/feed': 'cosmos-feed.html',
  'www.cosmos.so/e/1003': 'cosmos-element.html',
  'fixture.test/web.html': 'web.html',
  'fixture.test/overlay.html': 'overlay.html',
  'fixture.test/frames.html': 'frames.html',
  'fixture.test/frame-child.html': 'frame-child.html',
  // Content scripts must fire on mapped real hostnames, not only on fixture.test.
  'www.pinterest.com/fixture/probe/': 'frames.html',
  'www.cosmos.so/fixture/probe': 'frames.html',
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function png(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

function jpeg(dir, width, height, color) {
  const source = path.join(dir, 'tmp.png');
  const target = path.join(dir, 'tmp.jpg');
  writeFileSync(source, png(width, height, color));
  execFileSync('sips', ['-s', 'format', 'jpeg', source, '--out', target], { stdio: 'ignore' });
  return readFileSync(target);
}

const TYPES = { jpg: 'image/jpeg', png: 'image/png' };

export async function startFixtures(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbc-fixtures-'));
  try {
    return await serve(dir, options);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true }); // dir holds key.pem
    throw error;
  }
}

async function serve(dir, { pagesDir, slowSeconds = 45 }) {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '2', '-subj', '/CN=fixture.test'], { stdio: 'ignore' });
  const bodies = new Map(); // "host/path" -> { body, type }
  const image = (key, width, ext, color, type = TYPES[ext]) => {
    const height = Math.round(width * 3 / 4);
    bodies.set(key, { body: ext === 'jpg' ? jpeg(dir, width, height, color) : png(width, height, color), type });
  };
  for (const pin of PINS) {
    image(`i.pinimg.com/236x/${pin.path}.jpg`, 236, 'jpg', pin.color);
    image(`i.pinimg.com/474x/${pin.path}.jpg`, 474, 'jpg', pin.color); // DPR-2 currentSrc
    image(`i.pinimg.com/736x/${pin.path}.jpg`, 736, 'jpg', pin.color);
    if (pin.closeup) image(`i.pinimg.com/1200x/${pin.path}.jpg`, 1200, 'jpg', pin.color);
    if (pin.original) image(`i.pinimg.com/originals/${pin.path}.${pin.original}`, 1200, pin.original, pin.color);
  }
  for (const item of WEB) image(`fixture.test/img/${item.name}`, 640, 'png', item.color, item.type);
  image('fixture.test/slow.png', 600, 'png', [10, 10, 10]);
  const log = [];

  function send(req, res, { body, type }) {
    const headers = { 'cache-control': 'no-store' };
    if (type) headers['content-type'] = type;
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': body.length });
      return res.end();
    }
    if (req.headers.range === 'bytes=0-0') {
      res.writeHead(206, { ...headers, 'content-range': `bytes 0-0/${body.length}`, 'content-length': 1 });
      return res.end(body.subarray(0, 1));
    }
    res.writeHead(200, { ...headers, 'content-length': body.length });
    return res.end(body);
  }

  function route(req, res) {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, `https://${host}`);
    log.push({ method: req.method, host, path: url.pathname, search: url.search, range: req.headers.range || null });
    const key = `${host}${url.pathname}`;
    const page = PAGES[key];
    if (page) {
      const file = path.join(pagesDir, page);
      if (!existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(file));
    }
    const pin = PINS.find((p) => key.startsWith(`i.pinimg.com/originals/${p.path}.`));
    if (pin?.headBlocked && req.method === 'HEAD') { res.writeHead(405); return res.end(); }
    if (key === 'fixture.test/slow.png') {
      const { body, type } = bodies.get(key);
      res.writeHead(200, { 'content-type': type, 'content-length': body.length });
      res.write(body.subarray(0, 100));
      const timer = setTimeout(() => res.end(body.subarray(100)), slowSeconds * 1000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const cosmos = host === 'cdn.cosmos.so' && ELEMENTS.find((e) => url.pathname === `/${e.asset}`);
    if (cosmos) {
      // ?w= must be a positive integer (image() renders it through jpeg() and png(), which throw RangeError otherwise);
      // anything else falls back to the full size.
      const asked = Number(url.searchParams.get('w'));
      const width = Math.min(Number.isInteger(asked) && asked > 0 ? asked : COSMOS_MAX_WIDTH, COSMOS_MAX_WIDTH);
      const cacheKey = `${key}?w=${width}`;
      if (!bodies.has(cacheKey)) image(cacheKey, width, 'jpg', cosmos.color);
      return send(req, res, bodies.get(cacheKey));
    }
    if (bodies.has(key)) return send(req, res, bodies.get(key));
    res.writeHead(404);
    return res.end();
  }

  function handler(req, res) {
    try {
      route(req, res);
    } catch (error) {
      console.error(`fixture handler failed: ${req.method} ${req.url}`, error);
      if (res.headersSent) res.destroy();
      else { res.writeHead(500); res.end(); }
    }
  }

  const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    port: server.address().port,
    log,
    body: (hostAndPath) => bodies.get(hostAndPath)?.body || null,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
    }),
  };
}

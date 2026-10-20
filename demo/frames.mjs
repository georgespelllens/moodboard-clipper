// Frames for the README GIF and the video: screenshots of one page with a drawn cursor, each with its own duration.
// Headless Chrome has no cursor, so an arrow is drawn in the page; pointer-events: none keeps it out of hit testing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluate, hover } from '../extension/test/harness/cdp.mjs';

const ARROW = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30">'
  + '<path d="M1.5 1.5v24l6-6 4 9 4-1.8-4-8.7h8.5z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';

// Re-appended on every move: the extension's button host also hangs on <html>, and the later sibling is drawn on top.
const placeCursor = (x, y) => `(() => {
  let c = document.getElementById('mbc-demo-cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = 'mbc-demo-cursor';
    c.innerHTML = ${JSON.stringify(ARROW)};
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none', zIndex: '2147483647' });
  }
  c.style.transform = 'translate(${x - 1.5}px, ${y - 1.5}px)';
  document.documentElement.append(c);
  return true;
})()`;

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function recorder(cdp, dir) {
  const frames = [];
  let sessionId = null;
  let cursor = null;
  async function shot(ms) {
    if (cursor) await evaluate(cdp, sessionId, placeCursor(cursor.x, cursor.y));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = path.join(dir, `f${String(frames.length + 1).padStart(4, '0')}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, ms, page: sessionId });
  }
  // steps frames of ms each along an eased line; the page gets a real mouseMoved at every step.
  async function moveTo(x, y, steps, ms = 40) {
    const from = cursor ?? { x, y };
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      cursor = { x: from.x + (x - from.x) * t, y: from.y + (y - from.y) * t };
      await hover(cdp, sessionId, cursor.x, cursor.y);
      await shot(ms);
    }
  }
  // Switches to another page; the cursor starts over (null = hidden until the first move).
  function use(page, start = null) { sessionId = page.sessionId; cursor = start; }
  return { frames, shot, moveTo, use, cursor: () => cursor };
}

// Frames with their own durations → a looping GIF at 25 fps. Each frame is repeated for its duration through numbered
// links (the concat demuxer drifts on still pictures). One palette for the whole loop keeps the GIF small. It is built
// from the frames the eye rests on — the first one of each page and every frame held for a second or more. A page after
// the first gets a palette of its own, PAGE_ROWS rows of 16 colours: in one shared palette the few saturated pixels of a
// small window (the red, yellow and green buttons of the folder) are outvoted by the large gradients of the feed.
const PAGE_ROWS = 5;

export function makeGif(frames, out, { width = 960 } = {}) {
  if (!frames.length) throw new Error('makeGif: no frames');
  const dir = path.dirname(frames[0].file);
  const link = (list, name, repeat) => {
    const seq = mkdtempSync(path.join(dir, `${name}-`));
    let n = 0;
    for (const f of list) {
      for (let i = 0; i < repeat(f); i++) {
        n += 1;
        symlinkSync(f.file, path.join(seq, `${String(n).padStart(5, '0')}.png`));
      }
    }
    return path.join(seq, '%05d.png');
  };
  const all = link(frames, 'seq', (f) => Math.max(1, Math.round(f.ms / 40)));
  const pages = [...new Set(frames.map((f) => f.page))];
  const rows = pages.map((_, i) => (i === 0 ? 16 - PAGE_ROWS * (pages.length - 1) : PAGE_ROWS));
  const held = pages.map((page, i) => link(
    frames.filter((f, j) => f.page === page && (f.ms >= 1000 || j === frames.findIndex((g) => g.page === page))),
    `held${i}`,
    () => 1,
  ));
  const palette = path.join(dir, 'palette.png');
  const scale = `scale=${width}:-1:flags=lanczos`;
  const parts = pages.map((_, i) => `[${i}:v]${scale},palettegen=stats_mode=full:max_colors=${rows[i] * 16},crop=16:${rows[i]}:0:0[p${i}]`);
  const join = pages.length > 1 ? `${pages.map((_, i) => `[p${i}]`).join('')}vstack=inputs=${pages.length}` : '[p0]null';
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...held.flatMap((h) => ['-i', h]), '-filter_complex', `${parts.join(';')};${join}`,
    '-update', '1', palette]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '25', '-i', all, '-i', palette, '-lavfi',
    `[0:v]${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', out]);
  return statSync(out).size;
}

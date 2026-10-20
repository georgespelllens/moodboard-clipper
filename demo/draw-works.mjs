#!/usr/bin/env node
// demo/works/NN.jpg and works.json: the ten pictures of the demo feed and of the cover. Nothing is photographed or
// borrowed: abstractions and textures in the brand colours, drawn in code, so they are reproducible and fall under the
// repository's MIT license like everything else here.
// Each picture is an SVG built below, rendered in headless Chrome at its exact size and re-encoded by ffmpeg without
// metadata (no EXIF, GPS or colour profile). There is no Math.random and no clock: a seeded generator makes the variety,
// so a second run gives the same files.
// Run from the repo root: node demo/draw-works.mjs   (MBC_CHROME → Chrome for Testing; its headless shell will do)
// To redraw only some pictures: node demo/draw-works.mjs 3 7   (works.json is always written in full).
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { launch } from '../extension/test/harness/browser.mjs';
import { evaluate, openPage } from '../extension/test/harness/cdp.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'works');

// ---------------------------------------------------------------------------------------------------------------------
// Small tools

// mulberry32: a tiny seeded generator, the only source of "randomness" in this file.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n2 = (v) => Number(v.toFixed(2));
const pts = (list) => list.map(([x, y]) => `${n2(x)},${n2(y)}`).join(' ');
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const hex = (v) => `#${v.map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => { const A = rgb(a); const B = rgb(b); return hex(A.map((x, i) => lerp(x, B[i], t))); };
// ramp([[0, '#...'], [1, '#...']], t): a colour along a list of stops.
function ramp(stops, t) {
  const u = clamp(t);
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (u - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0] || 1));
  }
  return stops[stops.length - 1][1];
}

const stopTags = (stops) => stops.map(([o, c, a = 1]) => `<stop offset="${n2(o)}" stop-color="${c}"${a < 1 ? ` stop-opacity="${n2(a)}"` : ''}/>`).join('');
const lin = (id, x1, y1, x2, y2, stops, units = 'userSpaceOnUse') =>
  `<linearGradient id="${id}" gradientUnits="${units}" x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}">${stopTags(stops)}</linearGradient>`;
const rad = (id, cx, cy, r, stops, units = 'userSpaceOnUse') =>
  `<radialGradient id="${id}" gradientUnits="${units}" cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r)}">${stopTags(stops)}</radialGradient>`;
const blur = (id, sd) => `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
const shadow = (id, dx, dy, sd, color, opacity) =>
  `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${sd}" flood-color="${color}" flood-opacity="${opacity}"/></filter>`;
// Soft structure for big smooth areas: low-frequency noise turned into cloud-like patches of one colour. It breaks up the
// perfect contours of wide gradients, which would otherwise show as rings and bands once the pictures go into a 256-colour
// GIF. Alpha is a*noise + b, so only the stronger parts of the noise show. cloud() gives [filter, layer]; the layer is a rect.
function cloud(id, W, { fx, fy, seed, color, a, b, opacity, octaves = 4, y = 0, h }) {
  const [r, g, bl] = rgb(color).map((v) => n2(v / 255));
  const filter = `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">`
    + `<feTurbulence type="fractalNoise" baseFrequency="${fx} ${fy}" numOctaves="${octaves}" seed="${seed}"/>`
    + `<feColorMatrix type="matrix" values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${bl} ${a} 0 0 0 ${b}"/></filter>`;
  return [filter, `<rect y="${y}" width="${W}" height="${h}" filter="url(#${id})" opacity="${opacity}"/>`];
}
const svg = (w, h, defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;

// Palette: the brand violet family, paper, one warm sand and one deeper blue.
const VIOLET = '#6A50EF';
const VIOLET_DEEP = '#4F37D0';
const LAVENDER = '#A99EFC';
const INK = '#17161C';
const NIGHT = '#14102E';
const SAND = '#E3CDA4';
const BLUE = '#2B3FB5';

// ---------------------------------------------------------------------------------------------------------------------
// A tiny 3D kit: a pinhole camera and convex polygons that can be split by a plane (for exact cast shadows).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => mul(a, 1 / Math.hypot(...a));

// x to the right, y up, z away from the viewer. project(p) gives [px, py, depth]; project.near(poly) trims what is behind the lens.
function camera({ eye, target, focal, cx, cy }) {
  const f = unit(sub(target, eye));
  const r = unit(cross([0, 1, 0], f));
  const u = cross(f, r);
  const project = (p) => {
    const d = sub(p, eye);
    const z = dot(d, f);
    return [cx + (focal * dot(d, r)) / z, cy - (focal * dot(d, u)) / z, z];
  };
  project.near = (poly) => cut(poly, mul(f, -1), -dot(f, eye) - 0.4)[0];
  return project;
}

// Splits a convex polygon by the plane n·P = d: [part with n·P <= d, part with n·P >= d], null when empty.
function cut(poly, n, d) {
  const inside = [];
  const outside = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = dot(n, a) - d;
    const fb = dot(n, b) - d;
    if (fa <= 0) inside.push(a);
    if (fa >= 0) outside.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const p = add(a, mul(sub(b, a), fa / (fa - fb)));
      inside.push(p);
      outside.push(p);
    }
  }
  return [inside.length >= 3 ? inside : null, outside.length >= 3 ? outside : null];
}

// The part of the polygon inside every half-space of `planes` is "shadow"; the rest, cut into convex pieces, is "lit".
function shadowSplit(poly, planes) {
  const lit = [];
  let cur = poly;
  for (const [n, d] of planes) {
    const [inn, out] = cut(cur, n, d);
    if (out) lit.push(out);
    if (!inn) return { shadow: null, lit };
    cur = inn;
  }
  return { shadow: cur, lit };
}

// ---------------------------------------------------------------------------------------------------------------------
// 01  Concrete stair in morning light: a flight of steps between a tall wall and a row of concrete fins, low sun from
//     the left. Faces are exact: back faces are culled and the fins' shadows are cut out of the faces with half-spaces.

function stair() {
  const W = 1280;
  const H = 1600;
  const N = 17; // steps
  const rise = 0.17;
  const run = 0.3;
  const slope = rise / run;
  const Ws = 2.5; // width between the walls
  const T = 0.28; // thickness of a fin
  const Zs = N * run; // end of the flight
  const Zend = Zs + 2.4; // end of the landing
  const HL = 3.9 + rise; // fins, measured above the nosing line as a height at z = 0
  const HR = 7.5 + rise; // the right wall
  const topL = (z) => HL + slope * Math.min(z, Zs);
  const topR = (z) => HR + slope * Math.min(z, Zs);
  const yTop = N * rise; // landing level
  const eye = [1.7, 1.75, -3.4];
  const P = camera({ eye, target: [1.15, 3.2, 4.6], focal: 1180, cx: W / 2, cy: 820 });
  const sun = unit([-0.68, 0.45, -0.58]); // towards the sun
  const kz = sun[2] / sun[0];
  const ky = sun[1] / sun[0];
  // Fins along the flight: a fin occupies [a, b] in z.
  const fins = [];
  for (let a = 0.0; a < Zend; a += 2.0) fins.push([a, Math.min(a + 1.1, Zend)]);
  // A point P (x >= 0) looks at the sun along H = P + t·sun, which meets the plane x = 0 at H. A fin shades P when
  // a <= H.z <= b and H.y is below the fin's top.
  const finShadow = ([a, b]) => [
    [[-1, 0, 0], 0],
    [[kz, 0, -1], -a],
    [[-kz, 0, 1], b],
    [[-ky + slope * kz, 1, -slope], HL],
    [[-ky, 1, 0], HL + slope * Zs],
  ];
  const COL = {
    tread: ['#F8EAC9', '#8D7FBD'],
    riser: ['#E6D2A6', '#7263A8'],
    wallR: ['#EEDBB4', '#8A79BA'],
    finIn: ['#7B6CB0', '#7B6CB0'],
    end: ['#F4E6C4', '#F4E6C4'],
    floor: ['#EBD9B2', '#8D7FBD'],
  };
  const fog = (color, z) => mix(color, '#EFE6F7', clamp((z - 6) / 22) * 0.38);
  const out = [];
  // normal: outward normal of the face, used to cull faces that look away; shaded = whether the fins can shade it.
  const face = (poly, kind, normal, shaded = true) => {
    if (dot(normal, sub(eye, poly[0])) <= 0) return;
    let lit = [poly];
    const shadow = [];
    if (shaded) {
      for (const iv of fins) {
        const next = [];
        for (const piece of lit) {
          const r = shadowSplit(piece, finShadow(iv));
          if (r.shadow) shadow.push(r.shadow);
          next.push(...r.lit);
        }
        lit = next;
      }
    }
    const draw = (pp, k) => {
      const clipped = P.near(pp);
      if (!clipped) return;
      const q = clipped.map(P);
      const z = q.reduce((acc, v) => acc + v[2], 0) / q.length;
      const c = fog(COL[kind][k], z);
      out.push(`<polygon points="${pts(q)}" fill="${c}" stroke="${c}" stroke-width="0.8" stroke-linejoin="round"/>`);
    };
    for (const l of lit) draw(l, 0);
    for (const sh of shadow) draw(sh, 1);
  };
  const line3 = (a, b, stroke, opacity, width) => {
    const qa = P(a);
    const qb = P(b);
    out.push(`<line x1="${n2(qa[0])}" y1="${n2(qa[1])}" x2="${n2(qb[0])}" y2="${n2(qb[1])}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}"/>`);
  };

  // The right wall first, with its board marks, then the fins' inner faces and the floor in front of the flight.
  face([[Ws, 0, 0], [Ws, 0, Zend], [Ws, topR(Zend), Zend], [Ws, topR(0), 0]], 'wallR', [-1, 0, 0]);
  for (let y = 0.9; y < HR + slope * Zs; y += 0.9) {
    const z0 = y > HR ? (y - HR) / slope : 0;
    line3([Ws, y, z0], [Ws, y, Zend], '#6F5E8E', 0.1, 2);
  }
  // Round marks of the tie rods, a regular grid on the wall.
  for (let z = 1.2; z < Zend; z += 1.8) {
    for (let y = 1.5; y < topR(z); y += 1.8) {
      const q = P([Ws, y, z]);
      const r = (0.05 * 1180) / q[2];
      out.push(`<ellipse cx="${n2(q[0])}" cy="${n2(q[1])}" rx="${n2(r * 0.5)}" ry="${n2(r)}" fill="#5B4A86" fill-opacity="0.3"/>`);
    }
  }
  for (const [a, b] of fins) face([[0, 0, a], [0, 0, b], [0, topL(b), b], [0, topL(a), a]], 'finIn', [1, 0, 0], false);
  // The ends of the fins and of the right wall facing the viewer (the sun reaches them); the steps in front cover their feet.
  for (const [a] of fins) face([[-T, 0, a], [0, 0, a], [0, topL(a), a], [-T, topL(a), a]], 'end', [0, 0, -1], false);
  face([[Ws, 0, 0], [Ws + 1.5, 0, 0], [Ws + 1.5, topR(0), 0], [Ws, topR(0), 0]], 'end', [0, 0, -1], false);
  face([[-9, 0, -9], [Ws + 9, 0, -9], [Ws + 9, 0, 0], [-9, 0, 0]], 'floor', [0, 1, 0]);
  face([[0, yTop, Zs], [Ws, yTop, Zs], [Ws, yTop, Zend], [0, yTop, Zend]], 'tread', [0, 1, 0]);
  for (let i = N - 1; i >= 0; i--) {
    const z0 = i * run;
    const z1 = z0 + run;
    const y0 = i * rise;
    const y1 = y0 + rise;
    face([[0, y1, z0], [Ws, y1, z0], [Ws, y1, z1], [0, y1, z1]], 'tread', [0, 1, 0]);
    face([[0, y0, z0], [Ws, y0, z0], [Ws, y1, z0], [0, y1, z0]], 'riser', [0, 0, -1]);
    if (eye[1] > y1) line3([0, y1, z0], [Ws, y1, z0], '#FFF9E8', 0.4, 2);
  }
  // A few wide, pale clouds in the sky (lit patches and cool shaded ones), fading out towards the horizon. They give the
  // big gradients structure, so the sky does not turn into clean rings in a 256-colour GIF.
  const [warmF, warm] = cloud('warm', W, { fx: 0.0030, fy: 0.0058, seed: 11, color: '#F8EEF2', a: 3.0, b: -1.15, opacity: 0.55, octaves: 3, h: 1000 });
  const [coolF, cool] = cloud('cool', W, { fx: 0.0042, fy: 0.0072, seed: 23, color: '#A394E6', a: 3.0, b: -1.2, opacity: 0.3, octaves: 3, h: 1000 });
  const defs = [
    lin('sky', 0, 0, 0, H * 0.7, [[0, '#D3C5F3'], [0.55, '#EDE2F6'], [1, '#FAE9CF']]),
    rad('glow', 300, 640, 700, [[0, '#FFF1D4', 0.6], [1, '#FFF1D4', 0]]),
    rad('vig', W / 2, 800, 1150, [[0.5, '#2A2060', 0], [1, '#2A2060', 0.28]]),
    lin('foot', 0, 1150, 0, H, [[0, '#2A2060', 0], [1, '#2A2060', 0.16]]),
    lin('fade', 0, 0, 0, 1000, [[0, '#FFFFFF'], [0.6, '#FFFFFF'], [1, '#000000']]),
    '<mask id="skymask" maskUnits="userSpaceOnUse" x="0" y="0" width="1280" height="1600"><rect width="1280" height="1000" fill="url(#fade)"/></mask>',
    warmF, coolF,
  ].join('');
  return svg(W, H, defs, `<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#glow)"/><g mask="url(#skymask)">${cool}${warm}</g>${out.join('')}`
    + `<rect width="${W}" height="${H}" fill="url(#foot)"/><rect width="${W}" height="${H}" fill="url(#vig)"/>`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 02  Blue field: rows of a field running to a pale horizon, a low sun on the line, a path of light down the rows.

function blueField() {
  const W = 1280;
  const H = 1600;
  const hy = 960; // horizon
  const vx = 790; // where the rows meet, under the sun
  const rows = [];
  for (let xb = -2600; xb < 3800; xb += 210) rows.push(xb);
  const bend = (y) => 70 * Math.sin((y - hy) / 330 + 0.6) * ((y - hy) / (H - hy)); // the rows sway a little towards the viewer
  const edge = (xb) => {
    const p = [];
    for (let y = hy; y <= H + 20; y += 20) p.push([vx + (xb - vx) * ((y - hy) / (H - hy)) + bend(y), y]);
    return p;
  };
  const hills = (base, a, f, ph) => {
    const p = [];
    for (let x = -20; x <= W + 20; x += 16) p.push([x, base - a * (Math.sin(x * f + ph) + 0.55 * Math.sin(x * f * 2.7 + ph * 2.1) + 0.3 * Math.sin(x * f * 5.3 + ph * 0.7))]);
    return `M${pts(p).replaceAll(' ', 'L')}L${W + 20},${hy + 40}L-20,${hy + 40}Z`;
  };
  // Broad, faint patches of cloud in the sky, so the gradient has structure and does not show as bands in a GIF.
  const [lightF, light] = cloud('cloudlight', W, { fx: 0.0028, fy: 0.0085, seed: 31, color: '#9A90F0', a: 3.0, b: -1.2, opacity: 0.2, octaves: 3, h: hy });
  const [darkF, dark] = cloud('clouddark', W, { fx: 0.003, fy: 0.009, seed: 47, color: '#0F0B3F', a: 3.0, b: -1.3, opacity: 0.14, octaves: 3, h: hy });
  const defs = [
    lightF, darkF,
    lin('sky', 0, 0, 0, hy, [[0, '#120D49'], [0.35, '#2A29A6'], [0.66, '#6E67E8'], [0.88, '#BFB5FA'], [1, '#EEE5FA']]),
    rad('sun', vx, hy, 700, [[0, '#FFF3DE', 0.95], [0.18, '#F6DFCF', 0.6], [0.5, '#CBBFFB', 0.25], [1, '#CBBFFB', 0]]),
    rad('disc', vx, hy - 8, 64, [[0, '#FFFBF1'], [0.8, '#FFF1DA'], [1, '#FFF1DA', 0]]),
    lin('ridge', 0, hy, 0, H, [[0, '#A89FF5'], [0.16, '#6F67E2'], [0.5, '#2D3CB6'], [1, '#0E1457']]),
    lin('furrow', 0, hy, 0, H, [[0, '#8E86EE'], [0.16, '#514FD1'], [0.5, '#1B2790'], [1, '#080B3B']]),
    lin('haze', 0, hy - 30, 0, hy + 300, [[0, '#E6DCFA', 0], [0.12, '#E6DCFA', 0.95], [1, '#E6DCFA', 0]]),
    lin('path', 0, hy, 0, H, [[0, '#F4E9FF', 0.7], [0.55, '#B7ACFB', 0.28], [1, '#B7ACFB', 0]]),
    lin('hillfar', 0, hy - 90, 0, hy + 20, [[0, '#B8AEF8'], [1, '#8B82EA']]),
    lin('hillnear', 0, hy - 40, 0, hy + 20, [[0, '#7F77E6'], [1, '#5C56D6']]),
    rad('vig', W / 2, 900, 1150, [[0.6, '#06041F', 0], [1, '#06041F', 0.5]]),
    blur('b8', 8),
    blur('b30', 30),
    blur('b20', 20),
  ].join('');
  let b = `<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${hy}" fill="url(#sun)"/>${dark}${light}<rect y="${hy}" width="${W}" height="${H - hy}" fill="url(#ridge)"/>`;
  // Thin, long clouds that flatten towards the horizon.
  b += `<g filter="url(#b8)" opacity="0.5"><ellipse cx="420" cy="430" rx="480" ry="8" fill="#CFC6FB"/><ellipse cx="980" cy="560" rx="420" ry="9" fill="#E3DAFB"/>`
    + `<ellipse cx="300" cy="700" rx="460" ry="7" fill="#EDE5FB"/><ellipse cx="1000" cy="820" rx="380" ry="6" fill="#F6EAF2"/></g>`;
  b += `<circle cx="${vx}" cy="${hy - 8}" r="64" fill="url(#disc)"/>`;
  b += `<path d="${hills(hy + 4, 15, 0.0048, 1.1)}" fill="url(#hillfar)"/>`;
  b += `<path d="${hills(hy + 14, 7, 0.0074, 3.2)}" fill="url(#hillnear)"/>`;
  // The rows: alternating ridge and furrow strips, narrowing towards the horizon.
  for (let i = 0; i < rows.length - 1; i++) {
    const l = edge(rows[i]);
    const r = edge(rows[i + 1]).reverse();
    b += `<polygon points="${pts([...l, ...r])}" fill="url(#${i % 2 ? 'furrow' : 'ridge'})" stroke="url(#${i % 2 ? 'furrow' : 'ridge'})" stroke-width="0.6"/>`;
  }
  b += `<polygon points="${pts([[vx - 6, hy], [vx + 6, hy], [vx + 560 + bend(H), H], [vx - 560 + bend(H), H]])}" fill="url(#path)" filter="url(#b20)"/>`;
  b += `<rect y="${hy - 30}" width="${W}" height="330" fill="url(#haze)"/>`;
  b += `<rect width="${W}" height="${H}" fill="url(#vig)"/>`;
  return svg(W, H, defs, b);
}

// ---------------------------------------------------------------------------------------------------------------------
// 03  Studio notes: a gridded sheet on a dark desk with swatches, a pinned print and chips. No text, only marks.

function studioNotes() {
  const W = 1200;
  const H = 1600;
  const sx = 110;
  const sy = 110;
  const sw = 980;
  const sh = 1380;
  const pen = '#2A2358';
  const defs = [
    lin('desk', 0, 0, W, H, [[0, '#2B2362'], [0.55, '#1B1646'], [1, '#110D2E']]),
    rad('lamp', 330, 260, 1050, [[0, '#8C7AF2', 0.34], [1, '#8C7AF2', 0]]),
    lin('paper', sx, sy, sx + sw, sy + sh, [[0, '#FCFAF5'], [1, '#EFEBE1']]),
    blur('b14', 14),
    blur('b3', 3),
    shadow('drop', 0, 5, 5, '#1B1646', 0.3),
    shadow('lift', 6, 12, 10, '#1B1646', 0.34),
    rad('pin', 0, -4, 16, [[0, '#B9AEFF'], [0.55, VIOLET], [1, VIOLET_DEEP]], 'userSpaceOnUse'),
    lin('tape', 0, 0, 0, 1, [[0, '#EBDDBC', 0.92], [1, '#DCC99D', 0.92]], 'objectBoundingBox'),
  ].join('');
  let b = `<rect width="${W}" height="${H}" fill="url(#desk)"/><rect width="${W}" height="${H}" fill="url(#lamp)"/>`;
  // A second, lavender sheet underneath and the main sheet's shadow.
  b += `<g transform="rotate(4.5 600 800)"><rect x="${sx + 40}" y="${sy + 70}" width="${sw - 40}" height="${sh - 70}" rx="6" fill="#0D0A24" opacity="0.4" filter="url(#b14)" transform="translate(10 18)"/>`
    + `<rect x="${sx + 40}" y="${sy + 70}" width="${sw - 40}" height="${sh - 70}" rx="6" fill="#CFC6FA"/></g>`;
  b += `<g transform="rotate(-2.2 600 800)">`;
  b += `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="6" fill="#0D0A24" opacity="0.5" filter="url(#b14)" transform="translate(12 24)"/>`;
  b += `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="6" fill="url(#paper)"/>`;
  // Grid.
  let g = '';
  for (let x = sx + 50; x <= sx + sw - 50; x += 40) g += `M${x},${sy + 50}V${sy + sh - 50}`;
  for (let y = sy + 50; y <= sy + sh - 50; y += 40) g += `M${sx + 50},${y}H${sx + sw - 50}`;
  b += `<path d="${g}" stroke="#DCD6F2" stroke-width="1.6" fill="none"/>`;
  // Five circle swatches, one of them circled with a marker.
  const dots = [VIOLET, LAVENDER, BLUE, SAND, INK];
  dots.forEach((c, i) => { b += `<circle cx="${sx + 140 + i * 160}" cy="${sy + 150}" r="56" fill="${c}" stroke="#FFFFFF" stroke-width="7" filter="url(#drop)"/>`; });
  const lx = sx + 140 + 2 * 160;
  const ly = sy + 150;
  b += `<path d="M${lx - 74},${ly + 8} C${lx - 78},${ly - 56} ${lx + 12},${ly - 86} ${lx + 68},${ly - 44} C${lx + 104},${ly - 6} ${lx + 66},${ly + 68} ${lx - 4},${ly + 76} `
    + `C${lx - 56},${ly + 80} ${lx - 92},${ly + 32} ${lx - 80},${ly - 26} C${lx - 74},${ly - 50} ${lx - 44},${ly - 74} ${lx - 6},${ly - 82}" `
    + `fill="none" stroke="${VIOLET}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  // A tonal ramp of eight chips with a dimension line under it.
  const rampStops = [[0, '#F3F0FF'], [0.3, LAVENDER], [0.55, VIOLET], [0.8, '#2A2060'], [1, NIGHT]];
  for (let i = 0; i < 8; i++) {
    b += `<rect x="${sx + 70 + i * 100}" y="${sy + 290}" width="94" height="190" rx="8" fill="${ramp(rampStops, i / 7)}" stroke="#FFFFFF" stroke-width="4" filter="url(#drop)"/>`;
  }
  b += `<g stroke="${pen}" stroke-width="2.4" fill="none" stroke-linecap="round"><path d="M${sx + 70},${sy + 520}H${sx + 864}M${sx + 70},${sy + 508}V${sy + 532}M${sx + 864},${sy + 508}V${sy + 532}`
    + `M${sx + 70},${sy + 560}H${sx + 400}M${sx + 70},${sy + 592}H${sx + 250}"/></g>`;
  // Pinned print with a small composition on it.
  b += `<g transform="rotate(-3 ${sx + 290} ${sy + 940})" filter="url(#lift)"><rect x="${sx + 70}" y="${sy + 650}" width="440" height="560" fill="#FFFFFF"/>`
    + `<rect x="${sx + 92}" y="${sy + 672}" width="396" height="460" fill="${BLUE}"/>`
    + `<circle cx="${sx + 230}" cy="${sy + 840}" r="128" fill="${SAND}"/>`
    + `<path d="M${sx + 300},${sy + 1132}V${sy + 940}a74,74 0 0 1 148,0V${sy + 1132}Z" fill="${VIOLET}"/>`
    + `<path d="M${sx + 92},${sy + 1010}H${sx + 488}" stroke="#FFFFFF" stroke-width="3" stroke-opacity="0.8"/>`
    + `<circle cx="${sx + 290}" cy="${sy + 666}" r="13" fill="url(#pin)" transform="translate(0 0)"/></g>`;
  // Three chips on the right, each held by a pin.
  const chips = [
    { x: sx + 600, y: sy + 640, w: 250, h: 300, r: 4, c: '#D3CBFB' },
    { x: sx + 650, y: sy + 800, w: 250, h: 300, r: -5, c: VIOLET },
    { x: sx + 610, y: sy + 980, w: 250, h: 250, r: 2, c: SAND },
  ];
  for (const k of chips) {
    const cx = k.x + k.w / 2;
    const cy = k.y + k.h / 2;
    b += `<g transform="rotate(${k.r} ${cx} ${cy})" filter="url(#lift)"><rect x="${k.x}" y="${k.y}" width="${k.w}" height="${k.h}" rx="10" fill="${k.c}"/>`
      + `<rect x="${k.x}" y="${k.y}" width="${k.w}" height="26" rx="10" fill="#FFFFFF" fill-opacity="0.22"/></g>`;
    b += `<g transform="translate(${n2(cx)} ${k.y + 26}) rotate(${k.r})" filter="url(#drop)"><circle r="14" fill="url(#pin)"/><circle cx="-4.5" cy="-5" r="4" fill="#FFFFFF" fill-opacity="0.75"/></g>`;
  }
  // A small plot at the bottom: axes, a curve and its points.
  const px = sx + 70;
  const py = sy + 1290;
  b += `<g fill="none" stroke="${pen}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M${px},${py - 60}V${py + 30}H${px + 470}"/>`
    + `<path d="M${px},${py + 10} C${px + 90},${py - 70} ${px + 170},${py + 20} ${px + 260},${py - 30} S${px + 400},${py - 60} ${px + 460},${py - 10}" stroke="${VIOLET}" stroke-width="4"/>`
    + `<path d="M${px + 90},${py + 30}V${py - 28}M${px + 260},${py + 30}V${py - 30}" stroke-dasharray="6 8" stroke-opacity="0.7"/></g>`;
  for (const [dx, dy] of [[90, -28], [260, -30], [460, -10]]) b += `<circle cx="${px + dx}" cy="${py + dy}" r="7" fill="${VIOLET}" stroke="#FFFFFF" stroke-width="3"/>`;
  // Tape at the top corners.
  b += `<polygon points="${pts([[sx - 46, sy + 32], [sx + 84, sy - 8], [sx + 98, sy + 34], [sx - 30, sy + 74]])}" fill="url(#tape)" filter="url(#drop)"/>`;
  b += `<polygon points="${pts([[sx + sw + 44, sy + 30], [sx + sw - 88, sy - 10], [sx + sw - 100, sy + 32], [sx + sw + 30, sy + 74]])}" fill="url(#tape)" filter="url(#drop)"/>`;
  b += '</g>';
  return svg(W, H, defs, b);
}

// ---------------------------------------------------------------------------------------------------------------------
// 04  Folded paper: a pleated sheet hanging from the top edge, lit from the upper left, its zigzag hem casting a soft shadow.

function foldedPaper() {
  const W = 1067;
  const H = 1600;
  const K = 16; // facets
  const top = -20;
  const hem = 1290;
  const foldX = (i, y) => {
    const t = (y - top) / (hem - top);
    return W / 2 + (i - K / 2) * lerp(104, 86, t) + 5 * t * Math.sin(y / 310 + i * 0.7);
  };
  const hemY = (i) => hem + (i % 2 === 0 ? 38 : -8) + 4 * Math.sin(i * 1.9);
  const path = (k) => {
    const left = [];
    const right = [];
    const yl = hemY(k);
    const yr = hemY(k + 1);
    for (let y = top; y < yl; y += 40) left.push([foldX(k, y), y]);
    left.push([foldX(k, yl), yl]);
    for (let y = top; y < yr; y += 40) right.push([foldX(k + 1, y), y]);
    right.push([foldX(k + 1, yr), yr]);
    return [...left, ...right.reverse()];
  };
  const defs = [
    lin('wall', 0, 0, 0, H, [[0, '#F4F1FD'], [0.7, '#E6E0FB'], [1, '#D9D1F8']]),
    lin('beam', 0, 0, W, H, [[0, '#FFFFFF', 0], [0.4, '#FFFFFF', 0.75], [0.6, '#FFFFFF', 0], [1, '#FFFFFF', 0]]),
    lin('lit', 0, 0, 1, 0, [[0, '#FFFFFF'], [1, '#EAE5FE']], 'objectBoundingBox'),
    lin('shade', 0, 0, 1, 0, [[0, '#CFC6FC'], [1, '#B3A6F8']], 'objectBoundingBox'),
    lin('down', 0, top, 0, hem + 50, [[0, '#4F37D0', 0], [0.5, '#4F37D0', 0.08], [1, '#4F37D0', 0.36]]),
    lin('up', 0, top, 0, 420, [[0, '#FFFFFF', 0.5], [1, '#FFFFFF', 0]]),
    blur('b24', 24),
    blur('b60', 60),
  ].join('');
  let b = `<rect width="${W}" height="${H}" fill="url(#wall)"/><rect width="${W}" height="${H}" fill="url(#beam)" filter="url(#b60)"/>`;
  // Hem shadow on the wall: the zigzag pushed down and to the right, blurred.
  const hemLine = [];
  for (let k = 0; k <= K; k++) hemLine.push([foldX(k, hemY(k)) + 26, hemY(k) + 34]);
  b += `<polygon points="${pts([[W + 100, top], [-100, top], [-100, hemLine[0][1]], ...hemLine, [W + 100, hemLine[K][1]]])}" fill="#4F37D0" opacity="0.3" filter="url(#b24)"/>`;
  b += `<polygon points="${pts([[W + 100, top], [-100, top], [-100, hemLine[0][1] - 24], ...hemLine.map(([x, y]) => [x - 18, y - 24]), [W + 100, hemLine[K][1] - 24]])}" fill="#4F37D0" opacity="0.16" filter="url(#b24)"/>`;
  let marks = '';
  for (let k = 0; k < K; k++) {
    const q = path(k);
    const lit = k % 2 === 0;
    b += `<polygon points="${pts(q)}" fill="url(#${lit ? 'lit' : 'shade'})" stroke="url(#${lit ? 'lit' : 'shade'})" stroke-width="0.6"/>`;
    b += `<polygon points="${pts(q)}" fill="url(#down)"/>`;
    if (lit) b += `<polygon points="${pts(q)}" fill="url(#up)"/>`;
  }
  for (let i = 1; i < K; i++) {
    const line = [];
    for (let y = top; y < hemY(i); y += 40) line.push([foldX(i, y), y]);
    line.push([foldX(i, hemY(i)), hemY(i)]);
    const ridge = i % 2 === 0;
    marks += `<polyline points="${pts(line)}" fill="none" stroke="${ridge ? '#FFFFFF' : '#4A34C9'}" stroke-opacity="${ridge ? 0.95 : 0.3}" stroke-width="${ridge ? 2 : 1.4}" stroke-linejoin="round"/>`;
  }
  b += marks;
  // Paper thickness along the hem: a bright edge on the facets that face the light.
  let edge = '';
  for (let k = 0; k < K; k += 2) edge += `<line x1="${n2(foldX(k, hemY(k)))}" y1="${n2(hemY(k))}" x2="${n2(foldX(k + 1, hemY(k + 1)))}" y2="${n2(hemY(k + 1))}" stroke="#FFFFFF" stroke-width="3"/>`;
  b += edge;
  return svg(W, H, defs, b);
}

// ---------------------------------------------------------------------------------------------------------------------
// 05  Topographic lines: contour lines of a smooth landscape on night ink, one index contour in sand.

function topo() {
  const W = 1280;
  const H = 1600;
  const rnd = seeded(5);
  const hills = [
    [470, 520, 330, 1.0], [830, 930, 280, 0.8], [330, 1180, 300, 0.7], [900, 1380, 340, 0.75], [520, 260, 260, 0.55], [1000, 330, 220, 0.5],
    [190, 760, 200, 0.4],
  ].map(([x, y, s, a]) => [x + (rnd() - 0.5) * 30, y + (rnd() - 0.5) * 30, s, a]);
  const field = (x, y) => {
    let v = 0;
    for (const [hx, hy, s, a] of hills) v += a * Math.exp(-((x - hx) ** 2 + (y - hy) ** 2) / (2 * s * s));
    return v + 0.05 * Math.sin(x * 0.004 + y * 0.003) + 0.04 * Math.sin(y * 0.0057 - x * 0.002 + 1);
  };
  const cell = 8;
  const cols = Math.ceil(W / cell) + 1;
  const rows = Math.ceil(H / cell) + 1;
  const val = new Float64Array(cols * rows);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const v = field(i * cell, j * cell); val[j * cols + i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const levels = 24;
  const step = (hi - lo) / (levels + 1);
  // Marching squares; segments are stitched into polylines by the id of the cell edge they cross.
  const contour = (level) => {
    const edges = new Map(); // edge id -> point
    const links = new Map(); // edge id -> [neighbour edge ids]
    const at = (i, j) => val[j * cols + i];
    const point = (id, x, y) => { if (!edges.has(id)) edges.set(id, [x, y]); return id; };
    const hEdge = (i, j) => { const a = at(i, j); const c = at(i + 1, j); return point(`h${i},${j}`, (i + (level - a) / (c - a)) * cell, j * cell); };
    const vEdge = (i, j) => { const a = at(i, j); const c = at(i, j + 1); return point(`v${i},${j}`, i * cell, (j + (level - a) / (c - a)) * cell); };
    const join = (p, q) => { (links.get(p) ?? links.set(p, []).get(p)).push(q); (links.get(q) ?? links.set(q, []).get(q)).push(p); };
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const c = (at(i, j) > level ? 8 : 0) | (at(i + 1, j) > level ? 4 : 0) | (at(i + 1, j + 1) > level ? 2 : 0) | (at(i, j + 1) > level ? 1 : 0);
        if (c === 0 || c === 15) continue;
        const t = () => hEdge(i, j); const r = () => vEdge(i + 1, j); const bt = () => hEdge(i, j + 1); const l = () => vEdge(i, j);
        const centre = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 > level;
        switch (c) {
          case 1: case 14: join(l(), bt()); break;
          case 2: case 13: join(bt(), r()); break;
          case 3: case 12: join(l(), r()); break;
          case 4: case 11: join(t(), r()); break;
          case 6: case 9: join(t(), bt()); break;
          case 7: case 8: join(l(), t()); break;
          case 5: if (centre) { join(l(), t()); join(bt(), r()); } else { join(l(), bt()); join(t(), r()); } break;
          case 10: if (centre) { join(t(), r()); join(l(), bt()); } else { join(l(), t()); join(bt(), r()); } break;
          default: break;
        }
      }
    }
    const seen = new Set();
    const chains = [];
    const walk = (start) => {
      const chain = [start];
      seen.add(start);
      let cur = start;
      for (;;) {
        const next = links.get(cur).find((q) => !seen.has(q));
        if (!next) break;
        chain.push(next);
        seen.add(next);
        cur = next;
      }
      return chain;
    };
    // Open chains first (they end on the frame), then closed loops.
    for (const [id, nb] of links) if (nb.length === 1 && !seen.has(id)) chains.push(walk(id));
    for (const id of links.keys()) if (!seen.has(id)) { const c = walk(id); c.push(c[0]); chains.push(c); }
    return chains.map((c) => c.map((id, k) => `${k ? 'L' : 'M'}${n2(edges.get(id)[0])},${n2(edges.get(id)[1])}`).join(''));
  };
  const defs = [
    rad('glow', 520, 560, 1100, [[0, '#4A3AB8', 0.8], [0.45, '#241C66', 0.5], [1, '#120E2E', 0]]),
    rad('glow2', 900, 1330, 700, [[0, '#3446C8', 0.35], [1, '#3446C8', 0]]),
    rad('vig', W / 2, H / 2, 1100, [[0.55, '#0A0720', 0], [1, '#0A0720', 0.55]]),
  ].join('');
  let b = `<rect width="${W}" height="${H}" fill="${NIGHT}"/><rect width="${W}" height="${H}" fill="url(#glow)"/><rect width="${W}" height="${H}" fill="url(#glow2)"/>`;
  const sandLevel = 15;
  for (let k = 1; k <= levels; k++) {
    const level = lo + k * step;
    const d = contour(level).join('');
    if (!d) continue;
    const index = k % 6 === 0;
    const t = k / levels;
    let color = mix('#6C60C8', '#C8BEFC', t);
    let w = 2.3;
    if (index) { color = mix('#9E92F2', '#F1EDFF', t); w = 4; }
    if (k === sandLevel) { color = '#EBD3A6'; w = 4.6; }
    b += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  // Survey crosses on a wide grid and a marked summit.
  let crosses = '';
  for (let x = 160; x < W; x += 320) for (let y = 160; y < H; y += 320) crosses += `M${x - 9},${y}H${x + 9}M${x},${y - 9}V${y + 9}`;
  b += `<path d="${crosses}" stroke="#CFC7FF" stroke-opacity="0.5" stroke-width="2" fill="none"/>`;
  let best = 0;
  for (let q = 1; q < val.length; q++) if (val[q] > val[best]) best = q;
  const top = [(best % cols) * cell, Math.floor(best / cols) * cell];
  b += `<circle cx="${n2(top[0])}" cy="${n2(top[1])}" r="15" fill="none" stroke="#EBD3A6" stroke-width="3.4"/><circle cx="${n2(top[0])}" cy="${n2(top[1])}" r="5" fill="#EBD3A6"/>`;
  b += `<rect width="${W}" height="${H}" fill="url(#vig)"/>`;
  return svg(W, H, defs, b);
}

// ---------------------------------------------------------------------------------------------------------------------
// 06  Three arches: a sand wall in raking light from the left, openings with their reveals, a violet dusk beyond.

function arches() {
  const W = 1067;
  const H = 1600;
  const R = 105; // half width of an opening
  const spring = 700;
  const sill = 1230;
  const centres = [185, 533, 881];
  const vp = [533, 980]; // the eye: the far side of each opening is the near side pulled towards this point
  const k = 0.86;
  const toBack = ([x, y]) => [vp[0] + k * (x - vp[0]), vp[1] + k * (y - vp[1])];
  const arch = (cx, back) => {
    const m = back ? toBack : (p) => p;
    const [xl, yb] = m([cx - R, sill]);
    const [, ys] = m([cx, spring]);
    const r = back ? R * k : R;
    return `M${n2(xl)},${n2(yb)}V${n2(ys)}a${n2(r)},${n2(r)} 0 0 1 ${n2(2 * r)},0V${n2(yb)}Z`;
  };
  const backTop = toBack([0, spring - R])[1];
  const backBottom = toBack([0, sill])[1];
  const horizon = (vp[1] - backTop) / (backBottom - backTop);
  const defs = [
    lin('wall', 0, 0, W, 900, [[0, '#F1E2C2'], [0.5, '#DEC9A2'], [1, '#BEA57C']]),
    rad('wallpool', 260, 520, 560, [[0, '#FFF7E2', 0.4], [0.6, '#FFF7E2', 0.12], [1, '#FFF7E2', 0]]),
    lin('eave', 529, 98, 537, 138, [[0, '#7A5030', 0.46], [1, '#7A5030', 0]]),
    lin('dusk', 0, backTop, 0, backBottom, [[0, '#2A1D9A'], [0.3, '#5B45E6'], [0.5, '#A296FA'], [horizon - 0.02, '#DAD1FD'], [horizon + 0.006, '#3A2F8C'], [1, '#14102E']]),
    lin('floor', 0, sill, 0, H, [[0, '#B79D76'], [0.15, '#D3BE97'], [1, '#E8D8B6']]),
    lin('light', 0, sill, 0, H, [[0, '#FFF7E0', 0.9], [1, '#FFF7E0', 0.3]]),
    lin('revShade', 0, spring - R, 0, sill, [[0, '#6E4F3A'], [0.5, '#8C6E4E'], [1, '#A68A64']]),
    lin('revLit', 0, spring - R, 0, sill, [[0, '#E9D3A8'], [1, '#F6E8C8']]),
    blur('b8', 8),
  ];
  centres.forEach((cx, i) => { defs.push(`<clipPath id="a${i}"><path d="${arch(cx, false)}"/></clipPath>`); });
  let b = `<rect width="${W}" height="${H}" fill="url(#wall)"/>`;
  b += `<rect width="${W}" height="${sill}" fill="url(#wallpool)"/>`;
  b += `<polygon points="0,0 ${W},0 ${W},40 0,230" fill="url(#eave)"/>`;
  // The floor and the light that comes through the openings.
  b += `<rect y="${sill}" width="${W}" height="${H - sill}" fill="url(#floor)"/>`;
  b += `<line x1="0" y1="${sill}" x2="${W}" y2="${sill}" stroke="#8D7658" stroke-width="3"/>`;
  centres.forEach((cx) => {
    b += `<polygon points="${pts([[cx - R + 4, sill + 2], [cx + R - 4, sill + 2], [cx + R + 250, H + 20], [cx - R + 150, H + 20]])}" fill="url(#light)" filter="url(#b8)"/>`;
  });
  // Each opening: the reveal in shade, the sunlit jamb or floor strip, then the dusk seen through the far edge.
  centres.forEach((cx, i) => {
    const bl = toBack([cx - R, sill]);
    const br = toBack([cx + R, sill]);
    b += `<g clip-path="url(#a${i})">`;
    b += `<rect x="${cx - R}" y="${spring - R}" width="${2 * R}" height="${sill - spring + R}" fill="url(#revShade)"/>`;
    b += `<path d="${arch(cx, true)}" fill="none" stroke="#6A50EF" stroke-opacity="0.3" stroke-width="30" filter="url(#b8)"/>`; // the dusk lights the reveal near the far edge
    if (cx > vp[0]) b += `<rect x="${n2(br[0])}" y="${spring - R}" width="${n2(cx + R - br[0])}" height="${sill - spring + R}" fill="url(#revLit)"/>`;
    b += `<rect x="${cx - R}" y="${n2(bl[1])}" width="${2 * R}" height="${n2(sill - bl[1])}" fill="url(#revLit)"/>`;
    b += `<path d="${arch(cx, true)}" fill="url(#dusk)"/>`;
    b += '</g>';
  });
  centres.forEach((cx) => { b += `<path d="${arch(cx, false)}" fill="none" stroke="#6E5A4C" stroke-opacity="0.5" stroke-width="2.5"/>`; });
  return svg(W, H, defs.join(''), b);
}

// ---------------------------------------------------------------------------------------------------------------------
// 07  Glass blocks: a wall of lit blocks, brightest in the upper right, dark mortar between them.

function glassBlocks() {
  const W = 1600;
  const H = 1600;
  const rnd = seeded(7);
  const pitch = 262;
  const size = 232;
  const ox = -78;
  const oy = -96;
  const cols = 7;
  const rows = 7;
  const lightAt = (i, j) => clamp(0.16 + 0.84 * Math.exp(-(((i - 4.7) ** 2) / (2 * 2.1 ** 2) + ((j - 1.6) ** 2) / (2 * 2.3 ** 2))) + (rnd() - 0.5) * 0.1);
  const stops = [[0, '#0F0C3E'], [0.3, '#2432A8'], [0.55, VIOLET], [0.78, '#B8ACFB'], [1, '#F2EEFF']];
  const defs = [
    blur('glow', 34),
    blur('b10', 10),
    blur('b4', 4),
    blur('b2', 2),
    rad('back', 1150, 330, 1300, [[0, '#4636B8', 0.7], [0.5, '#1B1560', 0.4], [1, '#0B0824', 0]]),
    rad('vig', W / 2, H / 2, 1200, [[0.6, '#06041A', 0], [1, '#06041A', 0.5]]),
  ];
  let glow = '';
  let blocks = '';
  const warm = new Set(['4,1', '5,1', '5,2']);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ox + i * pitch;
      const y = oy + j * pitch;
      const t = lightAt(i, j);
      const tone = (u) => {
        const c = ramp(stops, clamp(u));
        return warm.has(`${i},${j}`) ? mix(c, '#F4DFB6', 0.62) : c;
      };
      const id = `${i}-${j}`;
      defs.push(lin(`bd${id}`, x, y, x + size, y + size, [[0, tone(t + 0.2)], [0.5, tone(t)], [1, tone(t - 0.18)]]));
      defs.push(rad(`bc${id}`, x + size * 0.42, y + size * 0.4, size * 0.55, [[0, tone(t + 0.34), 0.95], [1, tone(t + 0.1), 0]]));
      defs.push(lin(`br${id}`, x, y, x + size, y + size, [[0, '#FFFFFF', 0.85], [0.35, '#FFFFFF', 0.12], [0.7, '#0B0824', 0.1], [1, '#0B0824', 0.5]]));
      glow += `<rect x="${x - 6}" y="${y - 6}" width="${size + 12}" height="${size + 12}" rx="34" fill="${tone(t)}" opacity="${n2(0.15 + 0.7 * t)}"/>`;
      blocks += `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="28" fill="url(#bd${id})"/>`
        + `<rect x="${x + 30}" y="${y + 30}" width="${size - 60}" height="${size - 60}" rx="18" fill="url(#bc${id})" filter="url(#b10)"/>`
        + `<rect x="${x + 22}" y="${y + 22}" width="86" height="12" rx="6" fill="#FFFFFF" opacity="${n2(0.3 + 0.4 * t)}" filter="url(#b2)"/>`
        + `<rect x="${x + 3}" y="${y + 3}" width="${size - 6}" height="${size - 6}" rx="26" fill="none" stroke="url(#br${id})" stroke-width="5"/>`;
    }
  }
  return svg(W, H, defs.join(''), `<rect width="${W}" height="${H}" fill="#0A0722"/><rect width="${W}" height="${H}" fill="url(#back)"/>`
    + `<g filter="url(#glow)">${glow}</g>${blocks}<rect width="${W}" height="${H}" fill="url(#vig)"/>`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 08  Color swatch fan: eleven cards on one rivet, from night ink through violet to sand.

function swatchFan() {
  const W = 1200;
  const H = 1600;
  const pivot = [566, 1440];
  const colors = ['#1B1555', BLUE, VIOLET_DEEP, VIOLET, '#8873F4', LAVENDER, '#C6BDFA', '#E2DDFD', '#EFE3CC', '#E7D2A8', '#D9BC8A'];
  const length = 1120;
  const width = 178;
  const a0 = -24;
  const step = 5.2;
  const defs = [
    lin('paper', 0, 0, W, H, [[0, '#F6F2EA'], [1, '#E4DED2']]),
    rad('pool', 600, 640, 900, [[0, '#FFFFFF', 0.6], [1, '#FFFFFF', 0]]),
    shadow('cast', 6, 12, 11, '#2A2060', 0.3),
    lin('metal', -16, -16, 16, 16, [[0, '#FBFAFE'], [0.5, '#BDB8D2'], [1, '#6F6A8B']]),
    shadow('rivet', 1, 3, 3, '#17123F', 0.4),
  ];
  let body = `<rect width="${W}" height="${H}" fill="url(#paper)"/><rect width="${W}" height="${H}" fill="url(#pool)"/>`;
  colors.forEach((c, i) => {
    const angle = a0 + i * step;
    defs.push(lin(`c${i}`, 0, -length, 0, 0, [[0, mix(c, '#FFFFFF', 0.12)], [0.6, c], [1, mix(c, '#17123F', 0.18)]]));
    body += `<g filter="url(#cast)"><g transform="translate(${pivot[0]} ${pivot[1]}) rotate(${angle})">`
      + `<rect x="${-width / 2}" y="${-length}" width="${width}" height="${length + 74}" rx="26" fill="url(#c${i})"/>`
      + `<rect x="${-width / 2 + 1.5}" y="${-length + 1.5}" width="${width - 3}" height="${length + 71}" rx="25" fill="none" stroke="#FFFFFF" stroke-opacity="0.38" stroke-width="3"/>`
      + `<circle cx="0" cy="-${length - 62}" r="9" fill="#FFFFFF" fill-opacity="0.28"/></g></g>`;
  });
  body += `<g transform="translate(${pivot[0]} ${pivot[1]})" filter="url(#rivet)"><circle r="26" fill="url(#metal)"/><circle r="26" fill="none" stroke="#FFFFFF" stroke-opacity="0.7" stroke-width="2"/>`
    + `<circle r="9" fill="#5B5675"/></g>`;
  return svg(W, H, defs.join(''), body);
}

// ---------------------------------------------------------------------------------------------------------------------
// 09  Cloud bands at dawn: a soft sky from deep violet to a sand horizon with a low sun and layered clouds.

function cloudBands() {
  const W = 1280;
  const H = 1600;
  const rnd = seeded(9);
  const sky = [[0, '#2C1F86'], [0.2, '#4D39C9'], [0.4, '#8B78F2'], [0.58, '#C4B8F8'], [0.72, '#E6D6EE'], [0.84, '#F5DFC4'], [1, '#F8EAD6']];
  const skyAt = (y) => ramp(sky, y / 1330);
  const sunX = 400;
  const sunY = 1190;
  // Faint patches of cloud behind the bands, for the same reason as in the field picture.
  const [warmF, warm] = cloud('cloudwarm', W, { fx: 0.0025, fy: 0.0075, seed: 61, color: '#FFF1DE', a: 3.0, b: -1.2, opacity: 0.35, octaves: 3, h: 1250 });
  const [coolF, cool] = cloud('cloudcool', W, { fx: 0.003, fy: 0.008, seed: 73, color: '#3A2AA8', a: 3.0, b: -1.2, opacity: 0.22, octaves: 3, h: 1250 });
  const defs = [
    warmF, coolF,
    lin('sky', 0, 0, 0, 1330, sky.map(([o, c]) => [o, c])),
    rad('sun', sunX, sunY, 760, [[0, '#FFF5E0', 0.95], [0.18, '#FCE7CC', 0.7], [0.5, '#EBD3E6', 0.22], [1, '#EBD3E6', 0]]),
    rad('disc', sunX, sunY, 66, [[0, '#FFFDF6'], [0.78, '#FFF5E0'], [1, '#FFF5E0', 0]]),
    lin('sea', 0, 1250, 0, H, [[0, '#F6E4CC'], [0.4, '#CDBFF3'], [1, '#7A67E8']]),
    lin('ray', sunX, sunY, 1100, 300, [[0, '#FFF5E0', 0.35], [1, '#FFF5E0', 0]]),
    blur('b8', 8),
    blur('b14', 14),
    blur('b26', 26),
    blur('b40', 40),
  ];
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#sun)"/>${cool}${warm}`;
  // A few very faint beams from the sun.
  body += `<g filter="url(#b26)"><polygon points="${sunX},${sunY} 1180,200 1280,420" fill="url(#ray)" opacity="0.5"/><polygon points="${sunX},${sunY} 760,120 960,150" fill="url(#ray)" opacity="0.35"/></g>`;
  // Bands: a shaded body and a warm underlit edge, lower bands wider and lighter.
  for (let i = 0; i < 15; i++) {
    const t = i / 14;
    const y = 230 + t * 900 + (rnd() - 0.5) * 40;
    const cx = rnd() * W;
    const rx = 230 + rnd() * 330 + t * 170;
    const ry = 12 + rnd() * 20 + t * 14;
    const base = skyAt(y);
    const shade = mix(base, '#2C1F86', 0.34 - t * 0.12);
    const warm = mix(base, '#FFF0DA', 0.55 + t * 0.2);
    const sd = 8 + ry * 0.55;
    body += `<g filter="url(#b${sd > 20 ? 26 : sd > 11 ? 14 : 8})"><ellipse cx="${n2(cx)}" cy="${n2(y - 5)}" rx="${n2(rx)}" ry="${n2(ry)}" fill="${shade}" opacity="${n2(0.5 - t * 0.12)}"/>`
      + `<ellipse cx="${n2(cx + 40)}" cy="${n2(y + ry * 0.5)}" rx="${n2(rx * 0.86)}" ry="${n2(ry * 0.55)}" fill="${warm}" opacity="${n2(0.58 + t * 0.15)}"/></g>`;
  }
  body += `<circle cx="${sunX}" cy="${sunY}" r="66" fill="url(#disc)"/>`;
  // A sea of cloud below the sun.
  // Its top edge is uneven and soft, with low puffs and a haze across it, so the horizon does not read as a ruled line.
  const edge = [];
  for (let x = -80; x <= W + 80; x += 40) edge.push([x, 1252 + 8 * Math.sin(x / 170 + 1) + 5 * Math.sin(x / 61 + 2)]);
  body += `<path d="M${pts(edge)} ${W + 80},${H + 40} -80,${H + 40}Z" fill="url(#sea)" filter="url(#b8)"/>`;
  body += `<g filter="url(#b14)"><ellipse cx="90" cy="1250" rx="210" ry="20" fill="#F9ECD9" opacity="0.8"/><ellipse cx="780" cy="1262" rx="340" ry="26" fill="#FBF0E0" opacity="0.8"/><ellipse cx="1170" cy="1243" rx="230" ry="19" fill="#F6E3D2" opacity="0.75"/></g>`;
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const y = 1260 + t * 360;
    body += `<g filter="url(#b26)"><ellipse cx="${n2(rnd() * W)}" cy="${n2(y)}" rx="${n2(380 + t * 330)}" ry="${n2(46 + t * 60)}" fill="${mix('#F7E6D3', '#FFFFFF', 0.4)}" opacity="${n2(0.78 - t * 0.2)}"/>`
      + `<ellipse cx="${n2(rnd() * W)}" cy="${n2(y + 30 + t * 30)}" rx="${n2(340 + t * 300)}" ry="${n2(36 + t * 44)}" fill="${mix('#9C8CF0', '#4D39C9', t)}" opacity="${n2(0.34 + t * 0.2)}"/></g>`;
  }
  body += `<g filter="url(#b40)"><ellipse cx="${sunX}" cy="1275" rx="520" ry="40" fill="#FFF3DD" opacity="0.8"/></g>`;
  return svg(W, H, defs.join(''), body);
}

// ---------------------------------------------------------------------------------------------------------------------
// 10  Still life with solids: a sand sphere, a violet cylinder and a blue block on a lavender floor, lit from the left.

function solids() {
  const W = 1280;
  const H = 1600;
  const hz = 1010; // where the wall meets the floor
  const sx = 520; // sphere
  const sr = 255;
  const sBase = 1265;
  const sy = sBase - sr;
  const cx = 985; // cylinder
  const cr = 150;
  const cry = 44;
  const cBase = 1340;
  const cTop = 720;
  const bx = 110; // block: front face at x..x+bw, base at by
  const by = 1425;
  const bw = 250;
  const bh = 210;
  const bdx = 104;
  const bdy = 48;
  const defs = [
    lin('wall', 0, 0, 0, hz, [[0, '#E8E3FA'], [1, '#D8D0F5']]),
    rad('wallglow', 330, 360, 860, [[0, '#FFFFFF', 0.8], [1, '#FFFFFF', 0]]),
    lin('floor', 0, hz, 0, H, [[0, '#C3B8EE'], [0.3, '#DAD2F6'], [1, '#EDE9FB']]),
    lin('beam', 0, 0, 1, 0, [[0, '#FFFFFF', 0], [0.5, '#FFFFFF', 0.55], [1, '#FFFFFF', 0]], 'objectBoundingBox'),
    rad('sphere', sx - 95, sy - 120, 400, [[0, '#FFF7E6'], [0.34, '#EBD7B0'], [0.72, '#C9A976'], [1, '#98774F']]),
    rad('bounce', sx + 20, sy + 330, 240, [[0, '#F6E5C6', 0.55], [0.55, '#F6E5C6', 0.18], [1, '#F6E5C6', 0]]),
    lin('cyl', cx - cr, 0, cx + cr, 0, [[0, '#B2A7FB'], [0.3, '#8069F2'], [0.64, '#5A40D8'], [1, '#2B1D86']]),
    lin('cyltop', cx - cr, cTop, cx + cr, cTop, [[0, '#D4CCFD'], [1, '#A99EFC']]),
    lin('cylfoot', 0, cBase - 120, 0, cBase + cry, [[0, '#17123F', 0], [1, '#17123F', 0.28]]),
    lin('cast', 0, 0, 1, 0, [[0, '#3A2A9A', 0.5], [1, '#3A2A9A', 0.06]], 'objectBoundingBox'),
    lin('blockTop', bx, 0, bx + bw + bdx, 0, [[0, '#7A8BEA'], [1, '#5468DA']]),
    lin('blockFront', bx, by - bh, bx + bw, by, [[0, '#3C52CC'], [1, '#2B3FB5']]),
    lin('blockSide', 0, by, 0, by - bh, [[0, '#18236F'], [1, '#222F96']]),
    blur('b10', 10),
    blur('b16', 16),
    blur('b30', 30),
  ].join('');
  let b = `<rect width="${W}" height="${H}" fill="url(#wall)"/><rect width="${W}" height="${hz}" fill="url(#wallglow)"/>`;
  b += `<polygon points="150,0 560,0 1010,${hz} 600,${hz}" fill="url(#beam)" filter="url(#b30)" opacity="0.8"/>`;
  b += `<rect y="${hz}" width="${W}" height="${H - hz}" fill="url(#floor)"/>`;
  // Shadows on the floor, all thrown to the right.
  b += `<ellipse cx="${sx + 330}" cy="${sBase + 8}" rx="400" ry="62" fill="url(#cast)" filter="url(#b16)"/>`;
  b += `<polygon points="${pts([[cx, cBase - cry], [cx + 1300, cBase - cry + 64], [cx + 1300, cBase + cry + 64], [cx, cBase + cry]])}" fill="url(#cast)" filter="url(#b10)"/>`;
  b += `<ellipse cx="${cx}" cy="${cBase}" rx="${cr + 6}" ry="${cry + 5}" fill="#2A1D86" opacity="0.4" filter="url(#b10)"/>`;
  b += `<polygon points="${pts([[bx + 20, by + 4], [bx + bw + bdx, by - bdy + 6], [bx + bw + bdx + 1000, by - bdy + 66], [bx + bw + 1000, by + 66]])}" fill="url(#cast)" filter="url(#b10)"/>`;
  b += `<ellipse cx="${sx}" cy="${sBase}" rx="190" ry="26" fill="#2A1D86" opacity="0.5" filter="url(#b10)"/>`;
  // The sphere.
  b += `<circle cx="${sx}" cy="${sy}" r="${sr}" fill="url(#sphere)"/><circle cx="${sx}" cy="${sy}" r="${sr}" fill="url(#bounce)"/>`;
  // The cylinder: body, foot shade, top face.
  b += `<path d="M${cx - cr},${cTop}V${cBase}A${cr},${cry} 0 0 0 ${cx + cr},${cBase}V${cTop}Z" fill="url(#cyl)"/>`;
  b += `<path d="M${cx - cr},${cTop}V${cBase}A${cr},${cry} 0 0 0 ${cx + cr},${cBase}V${cTop}Z" fill="url(#cylfoot)"/>`;
  b += `<ellipse cx="${cx}" cy="${cTop}" rx="${cr}" ry="${cry}" fill="url(#cyltop)"/>`;
  b += `<ellipse cx="${cx}" cy="${cTop}" rx="${cr}" ry="${cry}" fill="none" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="2.5"/>`;
  // The block: top, front, shaded side.
  b += `<polygon points="${pts([[bx + bw, by], [bx + bw + bdx, by - bdy], [bx + bw + bdx, by - bh - bdy], [bx + bw, by - bh]])}" fill="url(#blockSide)"/>`;
  b += `<polygon points="${pts([[bx, by], [bx + bw, by], [bx + bw, by - bh], [bx, by - bh]])}" fill="url(#blockFront)"/>`;
  b += `<polygon points="${pts([[bx, by - bh], [bx + bw, by - bh], [bx + bw + bdx, by - bh - bdy], [bx + bdx, by - bh - bdy]])}" fill="url(#blockTop)"/>`;
  b += `<polyline points="${pts([[bx, by - bh], [bx + bw, by - bh], [bx + bw + bdx, by - bh - bdy]])}" fill="none" stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="2.5" stroke-linejoin="round"/>`;
  return svg(W, H, defs, b);
}

const PICTURES = [
  { title: 'Concrete stair in morning light', w: 1280, h: 1600, draw: stair },
  { title: 'Blue field', w: 1280, h: 1600, draw: blueField },
  { title: 'Studio notes', w: 1200, h: 1600, draw: studioNotes },
  { title: 'Folded paper', w: 1067, h: 1600, draw: foldedPaper },
  { title: 'Topographic lines', w: 1280, h: 1600, draw: topo },
  { title: 'Three arches', w: 1067, h: 1600, draw: arches },
  { title: 'Glass blocks', w: 1600, h: 1600, draw: glassBlocks },
  { title: 'Color swatch fan', w: 1200, h: 1600, draw: swatchFan },
  { title: 'Cloud bands at dawn', w: 1280, h: 1600, draw: cloudBands },
  { title: 'Still life with solids', w: 1280, h: 1600, draw: solids },
];

const wanted = process.argv.slice(2).map(Number);
if (wanted.some((n) => !Number.isInteger(n) || n < 1 || n > PICTURES.length)) throw new Error(`usage: node demo/draw-works.mjs [1..${PICTURES.length} ...]`);

const work = await mkdtemp(path.join(tmpdir(), 'mbc-draw-'));
let browser = null;
try {
  await mkdir(outDir, { recursive: true });
  browser = await launch({ downloadDir: work, extraArgs: ['--allow-file-access-from-files', '--hide-scrollbars', '--force-color-profile=srgb'] });
  const { cdp } = browser;
  for (const [index, pic] of PICTURES.entries()) {
    const nn = String(index + 1).padStart(2, '0');
    if (wanted.length && !wanted.includes(index + 1)) continue;
    const html = path.join(work, `${nn}.html`);
    const png = path.join(work, `${nn}.png`);
    const jpg = path.join(outDir, `${nn}.jpg`);
    await writeFile(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}svg{display:block}</style>${pic.draw()}`);
    const page = await openPage(cdp, pathToFileURL(html).href);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: pic.w, height: pic.h, deviceScaleFactor: 1, mobile: false }, page.sessionId);
      await evaluate(cdp, page.sessionId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
      const { data } = await cdp.send('Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: pic.w, height: pic.h, scale: 1 } }, page.sessionId);
      await writeFile(png, Buffer.from(data, 'base64'));
    } finally {
      await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => null);
    }
    // Bitexact drops the encoder tag that ffmpeg would otherwise write into the file.
    await run('ffmpeg', ['-v', 'error', '-y', '-i', png, '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-q:v', '3', jpg]);
    const { size } = await stat(jpg);
    console.log(`DRAW ${nn}.jpg ${pic.w}x${pic.h} ${size} bytes ${pic.title}`);
  }
  const list = PICTURES.map((p, i) => `  { "file": "${String(i + 1).padStart(2, '0')}.jpg", "title": ${JSON.stringify(p.title)} }`);
  await writeFile(path.join(outDir, 'works.json'), `[\n${list.join(',\n')}\n]\n`);
  console.log(`WORKS ${PICTURES.length} in demo/works`);
} finally {
  await browser?.close();
  await rm(work, { recursive: true, force: true });
}

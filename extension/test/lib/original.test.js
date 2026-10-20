const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSrcset, pinterestCandidates, cosmosOriginal, cosmosCandidates, COSMOS_RULE } = require('../../src/lib/original.js');

const urls = (list) => list.map((c) => c.url);
const labels = (list) => list.map((c) => c.label);
const PIN = 'https://i.pinimg.com';

test('parseSrcset reads w descriptors', () => {
  assert.deepEqual(parseSrcset('a.jpg 320w, b.jpg 640w'), [
    { url: 'a.jpg', w: 320, x: null },
    { url: 'b.jpg', w: 640, x: null },
  ]);
});

test('parseSrcset reads x descriptors as density, not width', () => {
  assert.deepEqual(parseSrcset('a.jpg 1x, b.jpg 2x'), [
    { url: 'a.jpg', w: null, x: 1 },
    { url: 'b.jpg', w: null, x: 2 },
  ]);
});

test('parseSrcset keeps commas inside URLs and survives a missing space', () => {
  const [first, second] = parseSrcset('https://c/a,b.jpg 320w,https://c/c.jpg 640w');
  assert.equal(first.url, 'https://c/a,b.jpg');
  assert.equal(second.url, 'https://c/c.jpg');
});

test('parseSrcset ignores junk', () => {
  assert.deepEqual(parseSrcset(''), []);
  assert.deepEqual(parseSrcset(null), []);
  assert.deepEqual(parseSrcset('a.jpg wide, b.jpg 10h, c.jpg 5w extra'), []);
});

test('pinterest: 236x gets the full ladder', () => {
  const list = pinterestCandidates(`${PIN}/236x/ab/cd/ef.jpg`);
  assert.deepEqual(urls(list), [
    `${PIN}/originals/ab/cd/ef.jpg`,
    `${PIN}/originals/ab/cd/ef.png`,
    `${PIN}/originals/ab/cd/ef.webp`,
    `${PIN}/originals/ab/cd/ef.gif`,
    `${PIN}/1200x/ab/cd/ef.jpg`,
    `${PIN}/736x/ab/cd/ef.jpg`,
    `${PIN}/236x/ab/cd/ef.jpg`,
  ]);
  assert.deepEqual(labels(list), [null, 'originals.png', 'originals.webp', 'originals.gif', '1200x', '736x', 'shown']);
});

test('pinterest: a vwebp URL drops the prefix for originals and keeps it for sized copies', () => {
  const list = pinterestCandidates(`${PIN}/vwebp/474x/72/da/83/72da83.webp`);
  assert.deepEqual(urls(list), [
    `${PIN}/originals/72/da/83/72da83.webp`,
    `${PIN}/originals/72/da/83/72da83.png`,
    `${PIN}/originals/72/da/83/72da83.jpg`,
    `${PIN}/originals/72/da/83/72da83.gif`,
    `${PIN}/vwebp/1200x/72/da/83/72da83.webp`,
    `${PIN}/vwebp/736x/72/da/83/72da83.webp`,
    `${PIN}/vwebp/474x/72/da/83/72da83.webp`,
  ]);
  assert.deepEqual(labels(list), [null, 'originals.png', 'originals.jpg', 'originals.gif', '1200x', '736x', 'shown']);
});

test('pinterest: a 1200x image collapses into the 1200x rung', () => {
  const list = pinterestCandidates(`${PIN}/1200x/ab/ef.jpg`);
  assert.deepEqual(labels(list), [null, 'originals.png', 'originals.webp', 'originals.gif', '1200x', '736x']);
  assert.equal(list[4].url, `${PIN}/1200x/ab/ef.jpg`);
});

test('pinterest: 736x collapses the 736x rung into the first match', () => {
  const list = pinterestCandidates(`${PIN}/736x/ab/ef.png`);
  assert.deepEqual(urls(list), [
    `${PIN}/originals/ab/ef.png`,
    `${PIN}/originals/ab/ef.jpg`,
    `${PIN}/originals/ab/ef.webp`,
    `${PIN}/originals/ab/ef.gif`,
    `${PIN}/1200x/ab/ef.png`,
    `${PIN}/736x/ab/ef.png`,
  ]);
  assert.equal(list[5].label, '736x');
});

test('pinterest: an originals URL is not duplicated', () => {
  const list = pinterestCandidates(`${PIN}/originals/ab/ef.webp`);
  assert.equal(list[0].url, `${PIN}/originals/ab/ef.webp`);
  assert.equal(list[0].label, null);
  assert.equal(new Set(urls(list)).size, list.length);
  assert.equal(list.at(-1).url, `${PIN}/736x/ab/ef.webp`);
});

const HASH = 'ab/cd/ef/abcdef0123456789abcdef0123456789';
const feedSrcset = [`236x/${HASH}.jpg 1x`, `474x/${HASH}.jpg 2x`, `736x/${HASH}.jpg 3x`, `originals/${HASH}.png 4x`]
  .map((s) => `${PIN}/${s}`).join(', ');

test('pinterest: the originals entry of a feed srcset goes first, with its own extension', () => {
  const shown = `${PIN}/474x/${HASH}.jpg`;
  const list = pinterestCandidates(shown, feedSrcset);
  assert.deepEqual(urls(list), [
    `${PIN}/originals/${HASH}.png`,
    `${PIN}/originals/${HASH}.jpg`,
    `${PIN}/originals/${HASH}.webp`,
    `${PIN}/originals/${HASH}.gif`,
    `${PIN}/1200x/${HASH}.jpg`,
    `${PIN}/736x/${HASH}.jpg`,
    shown,
  ]);
  assert.deepEqual(labels(list), [null, null, 'originals.webp', 'originals.gif', '1200x', '736x', 'shown']);
  assert.equal(new Set(urls(list)).size, list.length);
  assert.ok(!list.some((c) => c.label === 'originals.png'));
});

test('pinterest: srcset entries off host, off https or for another image are ignored', () => {
  const shown = `${PIN}/474x/${HASH}.jpg`;
  const plain = pinterestCandidates(shown);
  for (const bad of [
    `https://evil.example/originals/${HASH}.png 4x`,
    `http://i.pinimg.com/originals/${HASH}.png 4x`,
    `https://i.pinimg.com.evil.example/originals/${HASH}.png 4x`,
    `${PIN}/originals/d9/5a/37/ffffffffffffffffffffffffffffffff.png 4x`,
    `${PIN}/originals/${HASH}.png.exe 4x`,
    `${PIN}/originals/${HASH}x.png 4x`,
    `${PIN}/736x/${HASH}.png 3x`,
    `/originals/${HASH}.png 4x`,
  ]) assert.deepEqual(pinterestCandidates(shown, bad), plain, bad);
  const mixed = `https://evil.example/originals/${HASH}.webp 3x, ${PIN}/originals/${HASH}.png 4x`;
  assert.deepEqual(urls(pinterestCandidates(shown, mixed)).slice(0, 2), [`${PIN}/originals/${HASH}.png`, `${PIN}/originals/${HASH}.jpg`]);
});

test('pinterest: a pin page srcset without an original changes nothing', () => {
  const shown = `${PIN}/1200x/${HASH}.jpg`;
  const closeup = `${PIN}/736x/${HASH}.jpg 736w, ${PIN}/1200x/${HASH}.jpg 1152w`;
  assert.deepEqual(pinterestCandidates(shown, closeup), pinterestCandidates(shown));
});

test('pinterest: a missing or garbage srcset is the same as none', () => {
  const shown = `${PIN}/474x/${HASH}.jpg`;
  for (const junk of [undefined, null, '', 'garbage', 42, { a: 1 }, ', , ,']) {
    assert.deepEqual(pinterestCandidates(shown, junk), pinterestCandidates(shown));
  }
});

test('pinterest: any other URL is passed through as the shown copy', () => {
  const shown = (url) => [{ url, label: 'shown' }];
  assert.deepEqual(pinterestCandidates('https://example.com/a/b.jpg'), shown('https://example.com/a/b.jpg'));
  assert.deepEqual(pinterestCandidates('not a url'), shown('not a url'));
  assert.deepEqual(pinterestCandidates('http://i.pinimg.com/236x/a/b.jpg'), shown('http://i.pinimg.com/236x/a/b.jpg'));
  const thumb = `${PIN}/videos/thumbnails/originals/ab/cd.0000000.jpg`;
  assert.deepEqual(pinterestCandidates(thumb), shown(thumb));
});

test('cosmos: picks the widest srcset entry', () => {
  const srcset = 'https://cdn.cosmos.so/a.jpg 640w, https://cdn.cosmos.so/b.jpg 1920w, https://cdn.cosmos.so/c.jpg 1280w';
  assert.equal(cosmosOriginal('https://cdn.cosmos.so/shown.jpg', srcset), 'https://cdn.cosmos.so/b.jpg');
});

test('cosmos: picks the densest entry when srcset uses x', () => {
  assert.equal(cosmosOriginal('https://cdn.cosmos.so/s.jpg', 'https://cdn.cosmos.so/a.jpg 1x, https://cdn.cosmos.so/b.jpg 3x, https://cdn.cosmos.so/c.jpg 2x'), 'https://cdn.cosmos.so/b.jpg');
});

test('cosmos: falls back to the shown URL', () => {
  assert.equal(cosmosOriginal('https://cdn.cosmos.so/shown.jpg', ''), 'https://cdn.cosmos.so/shown.jpg');
  assert.equal(cosmosOriginal('https://cdn.cosmos.so/shown.jpg', undefined), 'https://cdn.cosmos.so/shown.jpg');
});

test('cosmos: COSMOS_RULE strips the query by default and rewrites the width param when set', () => {
  const shown = 'https://cdn.cosmos.so/x.jpg?format=webp&w=640';
  assert.deepEqual(COSMOS_RULE, { strip: true, param: null, max: null });
  assert.equal(cosmosOriginal(shown, ''), 'https://cdn.cosmos.so/x.jpg');
  assert.equal(cosmosOriginal('https://cdn.cosmos.so/u?w=320', 'https://cdn.cosmos.so/u?w=640 640w, https://cdn.cosmos.so/u?w=1920 1920w'), 'https://cdn.cosmos.so/u');
  const saved = { ...COSMOS_RULE };
  try {
    Object.assign(COSMOS_RULE, { strip: false, param: 'w', max: 4096 });
    assert.equal(cosmosOriginal(shown, ''), 'https://cdn.cosmos.so/x.jpg?format=webp&w=4096');
    assert.equal(cosmosOriginal('https://cdn.cosmos.so/x.jpg', ''), 'https://cdn.cosmos.so/x.jpg');
  } finally {
    Object.assign(COSMOS_RULE, saved);
  }
});

test('cosmos: a fragment on the shown URL is stripped from the original', () => {
  assert.equal(cosmosOriginal('https://cdn.cosmos.so/x.jpg?w=400#top', ''), 'https://cdn.cosmos.so/x.jpg');
  assert.equal(cosmosOriginal('https://cdn.cosmos.so/x.jpg#top', ''), 'https://cdn.cosmos.so/x.jpg');
});

const COSMOS = 'https://cdn.cosmos.so';

test('cosmosCandidates: on-host URL with a query gives the bare original, then the shown copy', () => {
  const shown = `${COSMOS}/u1?format=webp&w=400`;
  assert.deepEqual(cosmosCandidates(shown, null), [{ url: `${COSMOS}/u1`, label: null }, { url: shown, label: 'shown' }]);
});

test('cosmosCandidates: on-host URL without a query is its own original', () => {
  assert.deepEqual(cosmosCandidates(`${COSMOS}/u1`, null), [{ url: `${COSMOS}/u1`, label: null }]);
});

test('cosmosCandidates: off-host and http URLs are passed through as the shown copy', () => {
  for (const url of ['https://evil.example/u1?w=400', 'http://cdn.cosmos.so/u1?w=400', 'https://cdn.cosmos.so.evil.example/u1', 'not a url']) {
    assert.deepEqual(cosmosCandidates(url, null), [{ url, label: 'shown' }]);
  }
});

test('cosmosCandidates: a srcset whose widest entry is off-host is ignored', () => {
  const shown = `${COSMOS}/u1?w=400`;
  const srcset = `${COSMOS}/a 640w, https://evil.example/b 1920w`;
  assert.deepEqual(cosmosCandidates(shown, srcset), cosmosCandidates(shown, null));
  assert.deepEqual(cosmosCandidates(shown, `http://cdn.cosmos.so/b 1920w`), cosmosCandidates(shown, null));
});

test('cosmosCandidates: an on-host srcset entry wins over the shown URL', () => {
  const shown = `${COSMOS}/u1?w=400`;
  assert.deepEqual(cosmosCandidates(shown, `${COSMOS}/a?w=640 640w, ${COSMOS}/b?w=1920 1920w`),
    [{ url: `${COSMOS}/b`, label: null }, { url: shown, label: 'shown' }]);
});

test('cosmosCandidates: a fragment on the shown URL does not reach the original', () => {
  const shown = `${COSMOS}/u1?w=400#top`;
  const [first] = cosmosCandidates(shown, null);
  assert.deepEqual(first, { url: `${COSMOS}/u1`, label: null });
});

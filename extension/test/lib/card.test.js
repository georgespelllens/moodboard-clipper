const test = require('node:test');
const assert = require('node:assert/strict');
const card = require('../../src/lib/card.js');

const AT = new Date(Date.UTC(2026, 9, 4, 12, 34, 56, 789));
// The id pattern from docs/FORMAT.md.
const ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-(pinterest|cosmos|web)-[A-Za-z0-9-]+$/;

test('cleanText strips controls including U+0085, trims and returns null for empty', () => {
  assert.equal(card.cleanText('  a\u0000b\u0085c\u007fd\n ', 50), 'abcd');
  assert.equal(card.cleanText('\u0085\u0001 ', 50), null);
  assert.equal(card.cleanText('', 50), null);
  assert.equal(card.cleanText(null, 50), null);
  assert.equal(card.cleanText(5, 50), null);
});

test('cleanText truncates by code points and never leaves a lone surrogate', () => {
  assert.equal(card.cleanText('abcdef', 3), 'abc');
  const cut = card.cleanText('😀'.repeat(10), 3);
  assert.equal(Array.from(cut).length, 3);
  assert.equal(cut, '😀😀😀');
  assert.equal(card.cleanText('a\ud800b', 10), 'a�b');
});

test('stripUrl and stripFragment', () => {
  assert.equal(card.stripUrl('https://a.b/c?d=1#e'), 'https://a.b/c');
  assert.equal(card.stripUrl('https://a.b/c#e?f'), 'https://a.b/c');
  assert.equal(card.stripFragment('https://a.b/c?d=1#e'), 'https://a.b/c?d=1');
  assert.equal(card.stripFragment('https://a.b/c'), 'https://a.b/c');
});

test('extFromUrl reads the last path segment only', () => {
  assert.equal(card.extFromUrl('https://a.b/x/y.JPG?z=1'), 'jpg');
  assert.equal(card.extFromUrl('https://a.b/x.png/y'), null);
  assert.equal(card.extFromUrl('https://a.b/y.svg'), null);
  assert.equal(card.extFromUrl('https://a.b/y'), null);
  assert.equal(card.extFromUrl('https://a.b/y.heic#f'), 'heic');
});

test('extFromType ignores parameters and maps the aliases', () => {
  assert.equal(card.extFromType('image/jpeg'), 'jpg');
  assert.equal(card.extFromType('IMAGE/PNG; charset=binary'), 'png');
  assert.equal(card.extFromType('image/heif'), 'heic');
  assert.equal(card.extFromType('image/heic'), 'heic');
  assert.equal(card.extFromType('image/avif'), 'avif');
  assert.equal(card.extFromType('image/svg+xml'), null);
  assert.equal(card.extFromType(undefined), null);
});

test('utcStamp and isoUtc use UTC and drop milliseconds', () => {
  assert.equal(card.utcStamp(AT), '20261004T123456Z');
  assert.equal(card.isoUtc(AT), '2026-10-04T12:34:56Z');
});

test('sanitizeKey replaces everything outside [A-Za-z0-9-]', () => {
  assert.equal(card.sanitizeKey('ab_c.d/é-1'), 'ab-c-d---1');
  assert.equal(card.sanitizeKey(''), '');
  assert.equal(card.sanitizeKey(null), '');
});

test('makeId caps the whole id at 80 characters and keeps the charset', () => {
  const id = card.makeId(AT, 'pinterest', 'k'.repeat(200));
  assert.equal(id.length, 80);
  assert.ok(id.startsWith('20261004T123456Z-pinterest-'));
  assert.equal(card.makeId(AT, 'web', 'abc123'), '20261004T123456Z-web-abc123');
});

test('every makeId result matches the docs/FORMAT.md id pattern and fits 80 characters', () => {
  for (const site of ['pinterest', 'cosmos', 'web']) {
    for (const key of ['1', '123456789012345678', 'a.b_c é', 'x'.repeat(500), '😀', 'ID-with-dash']) {
      const id = card.makeId(AT, site, key);
      assert.match(id, ID_PATTERN);
      assert.ok(id.length <= 80, id);
      assert.equal(ID_PATTERN.exec(id)[1], site);
    }
  }
});

test('sha1hex matches the known vector', async () => {
  assert.equal(await card.sha1hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});

test('keyFor prefers a clean site key and falls back to 10 hex characters', async () => {
  assert.equal(await card.keyFor('pinterest', '123', 'https://x/y'), '123');
  for (const empty of [null, undefined, '']) {
    assert.match(await card.keyFor('web', empty, 'https://x/y?q=1'), /^[0-9a-f]{10}$/);
  }
  assert.equal(await card.keyFor('web', null, 'https://x/y?q=1'), (await card.sha1hex('https://x/y?q=1')).slice(0, 10));
});

test('repeatKey keeps the query for web and drops it for feed sites', () => {
  assert.equal(card.repeatKey('b', 'web', 'https://x/y.jpg?v=2#f'), 'b|https://x/y.jpg?v=2');
  assert.equal(card.repeatKey('b', 'pinterest', 'https://x/y.jpg?v=2#f'), 'b|https://x/y.jpg');
  assert.equal(card.repeatKey('b', 'cosmos', 'https://x/y.jpg?v=2'), 'b|https://x/y.jpg');
  assert.notEqual(card.repeatKey('a', 'web', 'https://x'), card.repeatKey('b', 'web', 'https://x'));
});

const base = {
  id: '20261004T123456Z-pinterest-123', board: 'test', site: 'pinterest', savedFrom: 'feed-button',
  pageUrl: 'https://www.pinterest.com/pin/123/', pageUrlKind: 'pin',
  assetUrl: 'https://i.pinimg.com/originals/ab/cd.jpg', ext: 'jpg', savedAt: AT,
  title: 'Title', alt: 'Alt', author: 'Someone', authorUrl: 'https://www.pinterest.com/someone/',
};

test('buildCard keeps the schema field order and fills the defaults', () => {
  const built = card.buildCard(base);
  assert.deepEqual(Object.keys(built), [
    'schema', 'id', 'board', 'site', 'saved_from', 'page_url', 'page_url_kind', 'asset_url',
    'asset_fallback', 'media', 'file', 'title', 'alt', 'author', 'author_url', 'saved_at',
  ]);
  assert.equal(built.schema, 'moodboard-clip/1');
  assert.equal(built.asset_fallback, null);
  assert.equal(built.media, 'image');
  assert.equal(built.file, `${base.id}.jpg`);
  assert.equal(built.saved_at, '2026-10-04T12:34:56Z');
  assert.equal(built.alt, 'Alt');
  assert.equal(built.page_url_kind, 'pin');
});

test('buildCard: web cards drop query, fragment and alt', () => {
  const built = card.buildCard({
    ...base, site: 'web', pageUrlKind: 'pin', pageUrl: 'https://a.b/page?x=1#top',
    assetUrl: 'https://a.b/i.png?sig=1', ext: 'png',
  });
  assert.equal(built.page_url, 'https://a.b/page');
  assert.equal(built.asset_url, 'https://a.b/i.png');
  assert.equal(built.alt, null);
  assert.equal(built.page_url_kind, 'tab');
});

test('buildCard: author defaults to unknown, bad author_url becomes null', () => {
  for (const author of [undefined, '', '  \u0085 ']) {
    assert.equal(card.buildCard({ ...base, author }).author, 'unknown');
  }
  for (const authorUrl of ['javascript:alert(1)', 'not a url', 'https://x/\u0000y', 'https://' + 'a'.repeat(5000), null, 7]) {
    assert.equal(card.buildCard({ ...base, authorUrl }).author_url, null, String(authorUrl).slice(0, 30));
  }
  assert.equal(card.buildCard({ ...base, authorUrl: 'http://x.y/z' }).author_url, 'http://x.y/z');
});

test('buildCard: text fields are cleaned and limited', () => {
  const built = card.buildCard({ ...base, title: 'a'.repeat(900), alt: '\u0001', author: 'z'.repeat(300) });
  assert.equal(built.title.length, 500);
  assert.equal(built.alt, null);
  assert.equal(built.author.length, 200);
});

test('buildCard keeps the fallback label and video media', () => {
  const built = card.buildCard({ ...base, assetFallback: 'originals.png', media: 'video-poster' });
  assert.equal(built.asset_fallback, 'originals.png');
  assert.equal(built.media, 'video-poster');
});

test('cardDataUrl round-trips the card through JSON', () => {
  const built = card.buildCard({ ...base, title: 'Кот & "пёс" 100%' });
  const url = card.cardDataUrl(built);
  assert.ok(url.startsWith('data:application/json;charset=utf-8,'));
  assert.deepEqual(JSON.parse(decodeURIComponent(url.slice(url.indexOf(',') + 1))), built);
});

test('pinTitle strips the Russian «Страница пина «…»» wrapper', () => {
  assert.equal(card.pinTitle('Страница пина «Красное поле»'), 'Красное поле');
  assert.equal(card.pinTitle('Страница пина «Multi\nline»'), 'Multi\nline');
});

test('pinTitle turns the untitled pin placeholder into null', () => {
  assert.equal(card.pinTitle('Страница пина «Без названия»'), null);
});

test('pinTitle leaves any other label unchanged, null included', () => {
  assert.equal(card.pinTitle('Fixture pin 9001'), 'Fixture pin 9001');
  assert.equal(card.pinTitle('Pin page «Red»'), 'Pin page «Red»');
  assert.equal(card.pinTitle('Страница пина «Открытая'), 'Страница пина «Открытая');
  assert.equal(card.pinTitle('Без названия'), 'Без названия');
  assert.equal(card.pinTitle(''), '');
  assert.equal(card.pinTitle(null), null);
  assert.equal(card.pinTitle(undefined), undefined);
});

test('pinTitle keeps « » quotes inside the title intact', () => {
  assert.equal(card.pinTitle('Страница пина «Дом «Север» и «Юг»»'), 'Дом «Север» и «Юг»');
});

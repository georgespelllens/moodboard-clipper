const test = require('node:test');
const assert = require('node:assert/strict');
const { boardName } = require('../../src/lib/board.js');

test('keeps latin, digits, underscore and dash', () => {
  assert.equal(boardName('Moodboard_2-test'), 'moodboard_2-test');
});

test('keeps Cyrillic including ё', () => {
  assert.equal(boardName('Жижа Ёлка'), 'жижа-ёлка');
});

test('NFD input is composed before filtering', () => {
  const nfd = '\u0435\u0308\u043b\u043a\u0430'; // е + combining diaeresis, then "лка"
  assert.notEqual(nfd, nfd.normalize('NFC'));
  assert.equal(boardName(nfd), '\u0451\u043b\u043a\u0430');
});

test('dots, slashes and spaces become one dash per run', () => {
  assert.equal(boardName('../a.b/c d'), 'a-b-c-d');
});

test('trimmed, runs of dashes collapse, edge dashes go', () => {
  assert.equal(boardName('  Кино 2026! '), 'кино-2026');
  assert.equal(boardName('a - - b'), 'a-b');
  assert.equal(boardName('-a-'), 'a');
  assert.equal(boardName('---'), 'unsorted');
});

test('edge dashes are also dropped after the 40-character cut', () => {
  assert.equal(boardName(`${'a'.repeat(39)} b`), 'a'.repeat(39));
});

test('cut to 40 characters', () => {
  assert.equal(boardName('a'.repeat(41)), 'a'.repeat(40));
  assert.equal(boardName('я'.repeat(60)).length, 40);
});

test('empty and non-string fall back to unsorted', () => {
  assert.equal(boardName(''), 'unsorted');
  assert.equal(boardName(undefined), 'unsorted');
  assert.equal(boardName(42), 'unsorted');
});

test('emoji are replaced by a dash; a lone emoji falls back to unsorted', () => {
  assert.equal(boardName('a😀b'), 'a-b');
  assert.equal(boardName('😀'), 'unsorted');
  assert.equal(boardName('a😀😀b'), 'a-b');
});

test('result always satisfies the board name pattern', () => {
  for (const raw of ['Ё', 'x'.repeat(100), 'a/b', '😀😀', ' ', 'İstanbul', '--a--', `${'a'.repeat(39)}/b`, '../x/..']) {
    const name = boardName(raw);
    assert.match(name, /^[a-z0-9а-яё_-]{1,40}$/u);
    if (name !== 'unsorted') assert.doesNotMatch(name, /^-|-$/);
  }
});

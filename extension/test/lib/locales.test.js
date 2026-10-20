const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const en = JSON.parse(read('_locales/en/messages.json'));
const ru = JSON.parse(read('_locales/ru/messages.json'));
const manifest = JSON.parse(read('manifest.json'));

// Every reason code the extension stores in recent[].reason.
const REASONS = [
  'bad_request', 'unknown_site', 'not_https', 'no_image_url', 'url_too_long', 'foreign_image_host',
  'image_unavailable', 'unknown_format', 'already_saving', 'download_interrupted', 'download_lost',
  'no_page_access', 'many_images_under_link', 'no_image_under_link', 'reload_page',
  'many_images_at_point', 'no_image_at_point', 'no_reply', 'extension_unavailable', 'already_in_board',
  'browser_asks_where_to_save', 'folder_not_connected', 'folder_missing', 'folder_write_failed',
  'site_access_needed', 'save_lost',
];

function sources(dir = 'src') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sources(file) : [file];
  });
}

test('en and ru have the same keys', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
});

test('every message has text and the same placeholders in both locales', () => {
  for (const key of Object.keys(en)) {
    assert.ok(en[key].message, `en ${key}`);
    assert.ok(ru[key].message, `ru ${key}`);
    assert.deepEqual(Object.keys(ru[key].placeholders ?? {}), Object.keys(en[key].placeholders ?? {}), key);
  }
});

test('the manifest names only existing keys', () => {
  const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  assert.ok(keys.length >= 3);
  for (const key of keys) assert.ok(en[key], key);
  assert.equal(manifest.default_locale, 'en');
});

test('the scripts ask only for existing keys', () => {
  const files = sources().filter((file) => file.endsWith('.js'));
  const keys = files.flatMap((file) => [...read(file).matchAll(/(?:getMessage|\bt)\('(\w+)'/g)].map((m) => m[1]));
  assert.ok(keys.length >= 3);
  for (const key of keys) assert.ok(en[key], key);
});

test('every reason code has a message and is used, and no message is left over', () => {
  const code = sources().filter((file) => file.endsWith('.js')).map(read).join('\n');
  for (const reason of REASONS) {
    assert.ok(en[`reason_${reason}`], reason);
    assert.ok(code.includes(`'${reason}'`), `${reason} is not used in src`);
  }
  const extra = Object.keys(en).filter((key) => key.startsWith('reason_') && !REASONS.includes(key.slice(7)));
  assert.deepEqual(extra, []);
});

test('the popup names only existing keys', () => {
  const keys = [...read('src/popup.html').matchAll(/data-i18n(?:-placeholder|-aria-label)?="(\w+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5);
  for (const key of keys) assert.ok(en[key], key);
});

test('no Russian text is left in the scripts and the popup outside the board and card rules', () => {
  const allowed = ['src/lib/board.js', 'src/lib/card.js'];
  const files = sources().filter((file) => /\.(js|html|css)$/.test(file) && !allowed.includes(file));
  const russian = files.filter((file) => /[а-яё]/i.test(read(file)));
  assert.deepEqual(russian, []);
});

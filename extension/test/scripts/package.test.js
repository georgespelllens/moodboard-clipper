const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.join(__dirname, '..', '..', '..');
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-package-'));
const output = execFileSync('bash', [path.join(repo, 'scripts', 'package-extension.sh')], {
  env: { ...process.env, MBC_DIST: dist }, encoding: 'utf8',
});
const ext = path.join(dist, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));

test('the build has every file the manifest names and nothing from development', () => {
  assert.match(output, /^PACKAGED 0\.2\.0 \S+ /m);
  const named = [
    manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((script) => script.js),
    `_locales/${manifest.default_locale}/messages.json`, '_locales/ru/messages.json',
  ];
  for (const file of named) assert.ok(fs.existsSync(path.join(ext, file)), file);
  assert.deepEqual(fs.readdirSync(ext).sort(), ['BUILD.json', '_locales', 'icons', 'manifest.json', 'src']);
});

test('BUILD.json names the version and the commit, one field per line', () => {
  const text = fs.readFileSync(path.join(ext, 'BUILD.json'), 'utf8');
  const build = JSON.parse(text);
  assert.equal(build.schema, 'mbc-build/1');
  assert.equal(build.name, 'Moodboard Clipper');
  assert.equal(build.version, manifest.version);
  assert.match(build.commit, /^([0-9a-f]{40}(\+dirty)?|unknown)$/);
  assert.match(build.built_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 7);
  for (const line of lines.slice(1, -1)) assert.match(line, /^ {2}"\w+": "[^"]*",?$/);
});

const zipPath = path.join(dist, 'moodboard-clipper-extension.zip');
const zipEntries = () => execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');

// Every file under a folder, as paths relative to it with forward slashes.
function filesUnder(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  ));
}

test('the zip holds the contents of the build at its root, with no folder around them', () => {
  const entries = zipEntries();
  const files = entries.filter((entry) => !entry.endsWith('/')).sort();
  assert.deepEqual(files, filesUnder(ext).sort());
  assert.deepEqual([...new Set(entries.map((entry) => entry.split('/')[0]))].sort(), fs.readdirSync(ext).sort());
  for (const entry of ['manifest.json', 'BUILD.json', 'src/background.js', 'icons/128.png', '_locales/en/messages.json']) {
    assert.ok(entries.includes(entry), entry);
  }
  assert.ok(!entries.some((entry) => /(^|\/)(install\.sh|README\.txt|\.DS_Store|__MACOSX)(\/|$)/.test(entry)));
  assert.ok(!entries.some((entry) => entry.startsWith('moodboard-clipper-extension/') || entry.startsWith('extension/') || entry.includes('/test/')));
});

test('unzipping gives a folder with manifest.json directly inside', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-unzip-'));
  try {
    execFileSync('unzip', ['-q', zipPath, '-d', path.join(target, 'moodboard-clipper-extension')]);
    const unpacked = path.join(target, 'moodboard-clipper-extension');
    assert.equal(JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8')).version, manifest.version);
    assert.deepEqual(filesUnder(unpacked).sort(), filesUnder(ext).sort());
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('only the zip and the build folder are written', () => {
  assert.deepEqual(fs.readdirSync(dist).sort(), ['extension', 'moodboard-clipper-extension.zip']);
});

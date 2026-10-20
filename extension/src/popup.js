const { boardName, reasonText, localize, getRoot } = MoodboardClip;
const local = chrome.storage.local;
const $ = (id) => document.getElementById(id);
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
const GLYPH = { ok: '✓', error: '✗', repeat: '↺' };
const LANG = chrome.i18n.getUILanguage();
const WHEN = new Intl.DateTimeFormat(LANG, { dateStyle: 'short', timeStyle: 'short' });

document.documentElement.lang = LANG;
localize(document, t);

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// Titles, ids and reasons come from web pages: they only ever go in as text.
function row(entry) {
  const li = document.createElement('li');
  li.className = entry.status;
  li.append(el('span', 'head', `${GLYPH[entry.status] ?? '?'} ${entry.board} · ${WHEN.format(entry.at)}`));
  li.append(el('span', 'title', entry.title || entry.id || entry.site));
  if (entry.reason) li.append(el('span', 'reason', reasonText(entry.reason, t)));
  if (entry.reason === 'site_access_needed') li.append(allowAllSites());
  return li;
}

// A picture on a site the extension has no access to cannot be fetched into the folder (CORS). One grant covers all sites.
function allowAllSites() {
  const link = el('a', 'action', t('allowAllSites'));
  link.href = '#';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).catch(() => {});
  });
  return link;
}

// --- The folder line ---
// The handle is loaded before any click: requestPermission must run at once inside the click, while it still counts
// as a user action (about 5 s), and the holder page must hold the handle before the grant, or the grant dies with the popup.
let root = null;
let holderReady = Promise.resolve();

async function renderFolder() {
  const { folder } = await local.get('folder');
  root = folder ? await getRoot().catch(() => null) : null;
  const state = root ? await root.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt') : null;
  const connected = state === 'granted';
  $('whereText').textContent = !folder ? t('folderDownloads') : t('folderName', [folder.name]);
  $('pick').textContent = folder ? t('folderChange') : t('folderOwn');
  $('connect').hidden = !folder || connected || !root;
  $('folderHint').hidden = $('connect').hidden && Boolean(root || !folder);
  if (!$('connect').hidden) $('folderHint').textContent = t('connectHint');
  else if (folder && !root) $('folderHint').textContent = reasonText('folder_missing', t);
  return connected;
}

async function prepareFolder() {
  if (!(await renderFolder()) && root) {
    $('connect').disabled = true;
    holderReady = chrome.runtime.sendMessage({ type: 'ensure-holder' }).catch(() => null);
    await holderReady;
    $('connect').disabled = false;
  }
}

$('connect').addEventListener('click', () => {
  if (!root) return;
  root.requestPermission({ mode: 'readwrite' }).catch(() => 'denied').then(async () => {
    // The answer of requestPermission is not trusted: the state is read back.
    if (await root.queryPermission({ mode: 'readwrite' }) === 'granted') {
      await chrome.runtime.sendMessage({ type: 'folder-connected' }).catch(() => {});
      await renderFolder();
    } else {
      $('folderHint').hidden = false;
      $('folderHint').textContent = t('folderDenied');
    }
  });
});

$('pick').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/folder.html') });
  window.close();
});

async function render() {
  const { activeBoard, boards = [], counts = {}, recent = [] } = await local.get(['activeBoard', 'boards', 'counts', 'recent']);
  const active = boardName(activeBoard);
  const names = [...new Set(['unsorted', ...boards, active])];
  $('board').replaceChildren(...names.map((name) => new Option(name, name, false, name === active)));
  $('count').textContent = t('savedCount', [String(counts[active] ?? 0)]);
  $('recent').replaceChildren(...recent.map(row));
}

$('board').addEventListener('change', (event) => local.set({ activeBoard: event.target.value }));

$('name').addEventListener('input', (event) => {
  const typed = event.target.value.trim();
  $('normalized').hidden = !typed;
  $('normalized').textContent = t('willCreate', [boardName(typed)]);
});

$('create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const typed = $('name').value.trim();
  if (!typed) return;
  const name = boardName(typed);
  const { boards = [] } = await local.get('boards');
  await local.set({ boards: [...new Set([...boards, name])], activeBoard: name });
  // With a connected folder the board is a folder at once, not only after the first save.
  if (root && await root.queryPermission({ mode: 'readwrite' }).catch(() => null) === 'granted') {
    root.getDirectoryHandle(name, { create: true }).catch(() => {});
  }
  $('name').value = '';
  $('normalized').hidden = true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  render();
  if (changes.folder) prepareFolder();
});
render();
prepareFolder();

importScripts('lib/board.js', 'lib/original.js', 'lib/card.js', 'lib/overlay.js', 'lib/folder.js');
const {
  boardName, pinterestCandidates, cosmosCandidates, cleanText, extFromUrl, extFromType,
  repeatKey, keyFor, makeId, buildCard, cardDataUrl, findImageUnderLink, getRoot, folderFailure,
} = MoodboardClip;

const ALARM = 'mbc-ui-restore';
const MENU_ID = 'moodboard-clip';
// Behance only: a grid module is covered by an empty element, so a right click there reports the page, not the image.
const MENU_PAGE_ID = 'moodboard-clip-page';
const SITE_HOSTS = { pinterest: 'pinterest.com', cosmos: 'cosmos.so' };
const SEEN_MAX = 5000;
const RECENT_MAX = 10;
const STALE_MS = 10 * 60 * 1000;
const PROBE_MS = 8000;
const KINDS = { pinterest: ['pin', 'tab'], cosmos: ['element', 'tab'], web: ['tab'] };
const IMAGE_HOSTS = { pinterest: 'i.pinimg.com', cosmos: 'cdn.cosmos.so' };
const TEXT_CAPS = { token: 128, key: 512, srcset: 16384, title: 20000, alt: 20000, author: 20000, authorUrl: Infinity };
// The browser is set to ask where to save each file: its Save dialog cannot be turned off from here.
const ASKS = 'browser_asks_where_to_save';
const FOLDER_KEY = 'fsa:';
const OWN = chrome.runtime.getURL('');
const local = chrome.storage.local;
const session = chrome.storage.session;

// Every storage read-modify-write and every download start runs here, one at a time. A fast
// downloads.onChanged therefore cannot run before its pending entry has been stored.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

function siteOf(url) {
  try {
    const host = new URL(url).hostname;
    const hit = Object.entries(SITE_HOSTS).find(([, base]) => host === base || host.endsWith(`.${base}`));
    return hit ? hit[0] : null;
  } catch { return null; }
}

async function setDownloadUi(enabled) {
  try { await chrome.downloads.setUiOptions?.({ enabled }); } catch { /* another extension owns the shelf */ }
}

// The download shelf stays hidden while saves are running. The alarm is the safety net: a timer would not
// survive the worker going to sleep.
async function settleUi() {
  const { pending } = await session.get({ pending: {} });
  if (Object.keys(pending).length) return chrome.alarms.create(ALARM, { delayInMinutes: 1 });
  await setDownloadUi(true);
  await chrome.alarms.clear(ALARM);
}

// setBadgeText returns a Promise in MV3, so a rejection would escape a plain try/catch; an old API may still throw synchronously.
function setBadge(text) {
  try { Promise.resolve(chrome.action.setBadgeText({ text })).catch(() => {}); } catch { /* badge is cosmetic */ }
}

// '!' while the chosen board folder waits for "Connect folder"; a ✓/✗ flash returns to it.
let badgeBase = '';
function setBase(text) {
  badgeBase = text;
  setBadge(text);
}

function flash(text) {
  setBadge(text);
  setTimeout(() => setBadge(badgeBase), 2000);
}

async function notify(entry, status, reason) {
  if (!entry.token || !(Number.isInteger(entry.tabId) && entry.tabId >= 0)) return;
  try {
    await chrome.tabs.sendMessage(entry.tabId, { type: 'clip-result', token: entry.token, status, reason }, { frameId: entry.frameId });
  } catch { /* the tab is gone or navigated away */ }
}

// Must run inside serial().
async function remember(entry, savedKey) {
  const { recent, counts, seen } = await local.get({ recent: [], counts: {}, seen: [] });
  if (savedKey) {
    seen.push(savedKey);
    counts[entry.board] = (counts[entry.board] ?? 0) + 1;
  }
  const next = [{ at: Date.now(), ...entry }, ...recent].slice(0, RECENT_MAX);
  await local.set({ recent: next, counts, seen: seen.slice(-SEEN_MAX) });
}

const note = (entry) => serial(() => remember(entry));

const startDownload = (board, name, url) =>
  chrome.downloads.download({ url, filename: `moodboard-inbox/${board}/${name}`, saveAs: false, conflictAction: 'overwrite' });

// Must run inside serial().
// Storage state first; the UI side effects come last and cannot break it.
async function finish(entry, status, reason = null) {
  const { card } = entry;
  const { inflight } = await session.get({ inflight: [] });
  await session.set({ inflight: inflight.filter((k) => k !== entry.key) });
  await remember(
    { board: card.board, site: card.site, status, reason, id: card.id, title: card.title },
    status === 'ok' ? entry.key : null,
  );
  // Its own guard: a failing settleUi must not skip the notify and the flash below.
  await settleUi().catch((e) => console.warn('mbc finish ui', e));
  notify(entry, status, reason).catch((e) => console.warn('mbc notify', e));
  if (entry.savedFrom === 'context-menu') flash(status === 'error' ? '✗' : '✓');
}

// Whether the image landed in moodboard-inbox/<board>/<id>.…, by the full path the browser reports (`/` on macOS and Linux,
// `\` on Windows). With "ask where to save" on, the Save dialog (saveAs:false does not suppress it) puts the file wherever the
// user chooses. A failed lookup or an empty path believes the save: a legitimate save never gets a false error.
// Chrome renames `<id>.img` to the real extension when the response has an image type, so the card names the file that is
// on disk. Only a plain `<id>.<extension>` is believed; anything else keeps the built name.
async function landed(downloadId, card) {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    const path = String(item?.filename ?? '');
    if (!path) return { file: card.file, inBoard: true };
    const [dir, board, name = ''] = path.split(/[\\/]/).slice(-3);
    const own = name.startsWith(`${card.id}.`);
    const inBoard = own && dir === 'moodboard-inbox' && board?.normalize('NFC') === card.board.normalize('NFC');
    const ext = own ? name.slice(card.id.length + 1) : '';
    return { file: /^[A-Za-z0-9]+$/.test(ext) ? name : card.file, inBoard };
  } catch { return { file: card.file, inBoard: true }; }
}

// Must run inside serial().
async function advance(downloadId, state, error) {
  const { pending } = await session.get({ pending: {} });
  const entry = pending[downloadId];
  if (!entry) return;
  delete pending[downloadId];
  // The shelf is hidden while saving, so a user cancel is almost always the Save dialog.
  let failure = state === 'interrupted' ? (error === 'USER_CANCELED' ? ASKS : error || 'download_interrupted') : null;
  if (!failure && entry.stage === 'image') {
    try {
      const { file, inBoard } = await landed(downloadId, entry.card);
      if (inBoard) {
        entry.card = { ...entry.card, file };
        const next = await startDownload(entry.card.board, `${entry.card.id}.json`, cardDataUrl(entry.card));
        pending[next] = { ...entry, stage: 'card', startedAt: Date.now() };
        await session.set({ pending });
        return;
      }
      failure = ASKS;
    } catch (e) { failure = e.message; }
  }
  await session.set({ pending });
  await finish(entry, failure ? 'error' : 'ok', failure);
}

// --- Saving into the folder the user chose (File System Access) ---
// The browser's own "ask where to save" setting does not apply here: the files never pass through its downloads.

const folderChosen = () => local.get('folder').then(({ folder }) => Boolean(folder));
// Slots of folder writes running in this worker; reconcile closes the others.
const writing = new Set();

async function canReach(url) {
  try { return await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] }); } catch { return false; }
}

async function writeFile(dir, name, body) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  if (body instanceof ReadableStream) return body.pipeTo(writable);
  await writable.write(body);
  await writable.close();
}

// Resolves to null once the picture and then its card (the card last: it marks a complete save) are in
// <folder>/<board>/, or to a reason code.
async function saveToFolder(entry) {
  const root = await getRoot();
  if (!root) return 'folder_missing';
  if (await root.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    setBase('!');
    return 'folder_not_connected';
  }
  let res;
  try {
    res = await fetch(entry.url, { credentials: 'omit', cache: 'no-store' });
  } catch {
    // Without host access a fetch from here obeys CORS, which the browser's downloads never did.
    return entry.card.site === 'web' && !(await canReach(entry.url)) ? 'site_access_needed' : 'image_unavailable';
  }
  if (!res.ok) return 'image_unavailable';
  let { card } = entry;
  if (entry.ext === 'img') {
    const typed = extFromType(res.headers.get('content-type'));
    if (typed) card = { ...card, file: `${card.id}.${typed}` };
  }
  const dir = await root.getDirectoryHandle(card.board, { create: true }).catch((e) => {
    if (folderFailure(e) === 'folder_not_connected') setBase('!');
    throw e;
  });
  try {
    await writeFile(dir, card.file, res.body ?? await res.blob());
    await writeFile(dir, `${card.id}.json`, JSON.stringify(card, null, 2));
  } catch (e) {
    dir.removeEntry(card.file).catch(() => {});
    dir.removeEntry(`${card.id}.json`).catch(() => {});
    if (folderFailure(e) === 'folder_not_connected') setBase('!');
    return folderFailure(e);
  }
  return null;
}

// Must run inside serial().
async function folderDone(slot, failure) {
  const { pending } = await session.get({ pending: {} });
  const entry = pending[slot];
  if (!entry) return;
  delete pending[slot];
  await session.set({ pending });
  await finish(entry, failure ? 'error' : 'ok', failure);
}

// A grant lives only while some page holds the folder handle: the popup closes and this worker sleeps, so an
// offscreen page holds it. It must hold the handle before "Connect folder" is pressed.
let holderLock = Promise.resolve();
function ensureHolder() {
  const run = holderLock.then(async () => {
    if (!chrome.offscreen) return false;
    const root = await getRoot().catch(() => null);
    const open = (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
    if (!root) {
      if (open) await chrome.offscreen.closeDocument().catch(() => {});
      return false;
    }
    if (!open) {
      await chrome.offscreen.createDocument({
        url: 'src/holder.html', reasons: ['BLOBS'], justification: 'Keeps the chosen board folder open so saves can be written into it',
      });
    }
    // Answered once the holder has the handle in hand, also right after it was created.
    return Boolean((await chrome.runtime.sendMessage({ type: 'holder-reload' }).catch(() => null))?.ok);
  });
  holderLock = run.catch(() => {});
  return run;
}

async function checkFolder() {
  const root = (await folderChosen()) ? await getRoot().catch(() => null) : null;
  if (!root) {
    // Downloads mode leaves the badge alone; only a '!' left from the folder mode is cleared (it outlives the worker).
    const shown = await Promise.resolve(chrome.action.getBadgeText?.({})).catch(() => '');
    if (badgeBase || shown === '!') setBase('');
    return ensureHolder();
  }
  setBase(await root.queryPermission({ mode: 'readwrite' }) === 'granted' ? '' : '!');
  await ensureHolder();
}

const FOLDER_MESSAGES = {
  'ensure-holder': () => ensureHolder(),
  'folder-changed': () => checkFolder(),
  'folder-connected': () => checkFolder(),
};

async function probe(url) {
  const get = (extra) => fetch(url, { ...extra, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(PROBE_MS) });
  try {
    let res = await get({ method: 'HEAD' });
    if (res.status === 403 || res.status === 405) {
      res = await get({ headers: { Range: 'bytes=0-0' } });
      res.body?.cancel().catch(() => {});
    }
    const type = res.headers.get('content-type') ?? '';
    return res.ok && type.startsWith('image/') ? type : null;
  } catch { return null; }
}

async function findOriginal(req) {
  if (req.site === 'web') return { url: req.srcUrl, label: null, type: null };
  const candidates = req.site === 'pinterest'
    ? pinterestCandidates(req.shownUrl, req.srcset)
    : cosmosCandidates(req.shownUrl, req.srcset);
  const tried = new Set();
  for (const candidate of candidates) {
    if (tried.has(candidate.url)) continue;
    tried.add(candidate.url);
    const type = await probe(candidate.url);
    if (type) return { ...candidate, type };
  }
  return null;
}

const onHost = (url, host) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === host; } catch { return false; } };

// Messages come from content scripts in pages: check types, enums and sizes before looking at values.
function invalid(req) {
  const BAD = 'bad_request';
  if (typeof req.site !== 'string' || !Object.hasOwn(KINDS, req.site)) return 'unknown_site';
  const asset = req.site === 'web' ? req.srcUrl : req.shownUrl;
  if (typeof req.pageUrl !== 'string' || typeof asset !== 'string') return BAD;
  for (const [field, cap] of Object.entries(TEXT_CAPS)) {
    const value = req[field];
    if (value != null && (typeof value !== 'string' || value.length > cap)) return BAD;
  }
  if (!KINDS[req.site].includes(req.pageUrlKind)) return BAD;
  if (req.media != null && req.media !== 'image' && req.media !== 'video-poster') return BAD;
  if (!/^https:\/\//i.test(req.pageUrl)) return 'not_https';
  if (!/^https?:\/\//i.test(asset)) return 'no_image_url';
  if (asset.length > 4096 || req.pageUrl.length > 4096) return 'url_too_long';
  if (req.site === 'web') return null;
  if (siteOf(req.pageUrl) !== req.site) return 'unknown_site';
  return onHost(asset, IMAGE_HOSTS[req.site]) ? null : 'foreign_image_host';
}

// Resolves to {status: 'pending'} once the image download has started; the final ok/error
// reaches the tab later as a clip-result message. 'repeat' and 'error' are final right here.
async function attempt(req, board) {
  const problem = invalid(req);
  if (problem) return { status: 'error', reason: problem };
  const found = await findOriginal(req);
  if (!found) return { status: 'error', reason: 'image_unavailable' };
  // '.img' stays: Chrome does not flag it, and renames typed files (see landed)
  const ext = extFromUrl(found.url) || extFromType(found.type) || (req.site === 'web' ? 'img' : null);
  if (!ext) return { status: 'error', reason: 'unknown_format' };
  const key = repeatKey(board, req.site, found.url);

  return serial(async () => {
    const { seen } = await local.get({ seen: [] });
    if (seen.includes(key)) return { status: 'repeat' };
    const { inflight, pending } = await session.get({ inflight: [], pending: {} });
    if (inflight.includes(key)) return { status: 'error', reason: 'already_saving' };

    const now = new Date();
    const id = makeId(now, req.site, await keyFor(req.site, req.key, found.url));
    const card = buildCard({
      id, board, site: req.site, savedFrom: req.savedFrom,
      pageUrl: req.pageUrl, pageUrlKind: req.pageUrlKind,
      assetUrl: found.url, assetFallback: found.label,
      media: req.media === 'video-poster' ? 'video-poster' : 'image', ext,
      title: req.title, alt: req.alt, author: req.author, authorUrl: req.authorUrl, savedAt: now,
    });
    const base = { card, ext, tabId: req.tabId, frameId: req.frameId, token: req.token, key, savedFrom: req.savedFrom, startedAt: now.getTime() };
    if (await folderChosen()) {
      const slot = `${FOLDER_KEY}${id}`;
      pending[slot] = { ...base, stage: 'write', url: found.url };
      inflight.push(key);
      writing.add(slot);
      await session.set({ pending, inflight });
      saveToFolder(pending[slot]).catch(folderFailure)
        .then((failure) => serial(() => folderDone(slot, failure)))
        .catch((e) => console.warn('mbc folder', e))
        .finally(() => writing.delete(slot));
      return { status: 'pending', id };
    }
    await setDownloadUi(false);
    chrome.alarms.create(ALARM, { delayInMinutes: 1 });
    try {
      const downloadId = await startDownload(board, `${id}.${ext}`, found.url);
      pending[downloadId] = { ...base, stage: 'image' };
      inflight.push(key);
      await session.set({ pending, inflight });
    } catch (e) {
      await settleUi().catch((err) => console.warn('mbc attempt ui', err));
      return { status: 'error', reason: e.message, id };
    }
    return { status: 'pending', id };
  });
}

async function clip(req) {
  const { activeBoard } = await local.get('activeBoard');
  const board = boardName(activeBoard);
  const result = await attempt(req, board);
  if (result.status !== 'pending') {
    await note({ board, site: req.site, title: cleanText(req.title, 120), id: null, reason: null, ...result });
  }
  return result;
}

async function reconcile() {
  const { pending } = await session.get({ pending: {} });
  const replays = [];
  for (const [key, entry] of Object.entries(pending)) {
    // A folder write lives only as long as the worker that started it.
    if (key.startsWith(FOLDER_KEY)) {
      if (!writing.has(key)) replays.push(serial(() => folderDone(key, 'save_lost')));
      continue;
    }
    const id = Number(key);
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === 'complete' || item?.state === 'interrupted') {
      replays.push(serial(() => advance(id, item.state, item.error)));
    } else if (!item || Date.now() - entry.startedAt > STALE_MS) {
      if (item) chrome.downloads.cancel(id).catch(() => {});
      replays.push(serial(() => advance(id, 'interrupted', 'download_lost')));
    }
  }
  await Promise.all(replays);
  await serial(settleUi);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: chrome.i18n.getMessage('menuSave'), contexts: ['image', 'link'] });
  // The page context shows only where no image or link applies, so this item never doubles the one above.
  chrome.contextMenus.create({ id: MENU_PAGE_ID, title: chrome.i18n.getMessage('menuSave'), contexts: ['page'], documentUrlPatterns: ['https://*.behance.net/*'] });
});

const reconcileSafe = () => reconcile().catch((e) => console.warn('mbc reconcile', e));
const checkFolderSafe = () => checkFolder().catch((e) => console.warn('mbc folder check', e));
chrome.runtime.onStartup.addListener(() => { reconcileSafe(); checkFolderSafe(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) reconcileSafe(); });

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') {
    serial(() => advance(delta.id, state, delta.error?.current)).catch((e) => console.warn('mbc advance', e));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.url?.startsWith(OWN) && Object.hasOwn(FOLDER_MESSAGES, msg?.type)) {
    FOLDER_MESSAGES[msg.type]().then((ok) => respond({ ok: ok !== false }), (e) => respond({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type !== 'clip' || !sender.tab) return false;
  const site = siteOf(sender.url);
  const refusal = !sender.url.startsWith('https://') ? 'not_https' : !site || site !== msg.site ? 'unknown_site' : null;
  if (refusal) {
    respond({ status: 'error', reason: refusal });
    return false;
  }
  const req = { ...msg, tabId: sender.tab.id, frameId: sender.frameId, savedFrom: 'feed-button' };
  clip(req).then(respond, (e) => respond({ status: 'error', reason: e.message }));
  return true;
});

// A site may lay a transparent link over its picture: a right click then hits the link and Chrome reports no image.
// The page is asked which image lies under the clicked link; the answer is {found} or {reason}.
// findImageUnderLink answers {url}, {miss:'none'} or {miss:'many'}; anything else is read as no image.
async function imageUnderLink(info, tab) {
  if (!(Number.isInteger(tab?.id) && tab.id >= 0)) return { reason: 'no_page_access' };
  let found;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] }, func: findImageUnderLink, args: [info.linkUrl],
    });
    found = results?.[0]?.result;
  } catch { return { reason: 'no_page_access' }; }
  if (typeof found?.url === 'string' && found.url) return { found: found.url };
  return { reason: found?.miss === 'many' ? 'many_images_under_link' : 'no_image_under_link' };
}

async function linkFailure(info, tab, reason) {
  const { activeBoard } = await local.get('activeBoard');
  const board = boardName(activeBoard);
  await note({ board, site: siteOf(info.pageUrl) ?? 'web', title: cleanText(tab?.title, 120), id: null, status: 'error', reason });
  flash('✗');
  return { status: 'error', reason };
}

// The page item: the click carries no coordinates, so the Behance content script (which saw the contextmenu event)
// is asked which image lies under the point. Returns { found } or { reason } like imageUnderLink.
async function imageAtPoint(info, tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0) return { reason: 'no_page_access' };
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tab.id, { type: 'image-at-point' }, { frameId: info.frameId ?? 0 });
  } catch {
    return { reason: 'reload_page' }; // no content script there: the tab was opened before the extension was loaded
  }
  if (typeof reply?.url === 'string' && reply.url) return { found: reply.url };
  return { reason: reply?.miss === 'many' ? 'many_images_at_point' : 'no_image_at_point' };
}

async function menuClick(info, tab) {
  if (info.menuItemId !== MENU_ID && info.menuItemId !== MENU_PAGE_ID) return null;
  try {
    // byUrl: the address came from the link heuristic, not from a click on the picture, so the content script
    // has no remembered right-click for it and must look the picture up by its address. The Behance page item needs
    // no flag: behance.net has no probe content script (siteOf is null there), so no probe is sent.
    let byUrl = false;
    if (info.menuItemId === MENU_PAGE_ID) {
      const hit = await imageAtPoint(info, tab);
      if (hit.reason) return await linkFailure(info, tab, hit.reason);
      info = { ...info, srcUrl: hit.found };
    } else if (!info.srcUrl && info.linkUrl) {
      const hit = await imageUnderLink(info, tab);
      if (hit.reason) return await linkFailure(info, tab, hit.reason);
      info = { ...info, srcUrl: hit.found };
      byUrl = true;
    }
    const site = siteOf(info.pageUrl);
    let data = null;
    if (site && tab?.id >= 0) {
      try {
        data = await chrome.tabs.sendMessage(tab.id, { type: 'probe-context', srcUrl: info.srcUrl, ...(byUrl ? { byUrl: true } : {}) }, { frameId: info.frameId });
      } catch { /* no content script in that frame: save as a plain web image */ }
    }
    let req;
    if (data) {
      // The reply is built from page markup: the worker, not the reply, names the tab, frame, token and origin.
      req = { ...data, tabId: tab.id, frameId: info.frameId ?? 0, token: null, savedFrom: 'context-menu', site };
    } else {
      req = {
        site: 'web', srcUrl: info.srcUrl, pageUrl: info.pageUrl, pageUrlKind: 'tab', title: tab?.title, alt: null,
        tabId: tab?.id ?? null, frameId: info.frameId ?? 0, token: null, savedFrom: 'context-menu',
      };
    }
    const result = await clip(req);
    if (result.status !== 'pending') flash(result.status === 'error' ? '✗' : '✓');
    return result;
  } catch (e) {
    console.warn('mbc menu', e);
    flash('✗');
    return { status: 'error', reason: e.message };
  }
}

chrome.contextMenus.onClicked.addListener(menuClick);
// The smoke test calls the menu handler directly: a native context menu cannot be clicked over CDP.
globalThis.mbcMenuClick = menuClick;

reconcileSafe();
checkFolderSafe();

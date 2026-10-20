const { setRoot, clearRoot, localize } = MoodboardClip;
const $ = (id) => document.getElementById(id);
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
const local = chrome.storage.local;

document.documentElement.lang = chrome.i18n.getUILanguage();
localize(document, t);

function say(text) { $('status').textContent = text; }

// The handle goes to IndexedDB first, then the name to storage: the popup and the worker read storage as the switch.
async function choose(handle) {
  try {
    await setRoot(handle);
    await local.set({ folder: { name: handle.name } });
    await chrome.runtime.sendMessage({ type: 'folder-changed' }).catch(() => {});
    say(t('folderChosen', [handle.name]));
  } catch {
    say(t('folderBlocked'));
  }
}

$('choose').addEventListener('click', async () => {
  if (typeof showDirectoryPicker !== 'function') return say(t('folderUnsupported'));
  try {
    await choose(await showDirectoryPicker({ id: 'moodboard-root', mode: 'readwrite', startIn: 'downloads' }));
  } catch (error) {
    if (error?.name !== 'AbortError') say(t('folderBlocked'));
  }
});

const drop = $('drop');
drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  // getAsFileSystemHandle works only while the drop event runs, so it is called before any await.
  const item = [...event.dataTransfer.items].find((entry) => entry.kind === 'file');
  const pending = item?.getAsFileSystemHandle?.();
  if (!pending) return say(t('folderNotDir'));
  pending.then((handle) => (handle?.kind === 'directory' ? choose(handle) : say(t('folderNotDir'))))
    .catch(() => say(t('folderNotDir')));
});

$('reset').addEventListener('click', async (event) => {
  event.preventDefault();
  await local.remove('folder');
  await clearRoot().catch(() => {});
  await chrome.runtime.sendMessage({ type: 'folder-changed' }).catch(() => {});
  say(t('folderResetDone'));
});

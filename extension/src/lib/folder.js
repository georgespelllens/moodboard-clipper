(() => {
  // The folder the user chose for boards. A directory handle cannot go into chrome.storage, only into IndexedDB;
  // chrome.storage.local.folder = { name } mirrors it for quick checks and for the popup.
  const DB = 'moodboard-clipper';
  const STORE = 'folder';
  const KEY = 'root';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function inStore(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  const getRoot = () => inStore('readonly', (store) => store.get(KEY)).then((handle) => handle ?? null);
  const setRoot = (handle) => inStore('readwrite', (store) => store.put(handle, KEY));
  const clearRoot = () => inStore('readwrite', (store) => store.delete(KEY));

  // A File System Access error as a reason code. A grant that lapsed (browser restart, the last extension tab closed)
  // reads as NotAllowedError; a renamed or deleted folder as NotFoundError although the grant still says granted.
  function folderFailure(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'folder_not_connected';
    if (error?.name === 'NotFoundError') return 'folder_missing';
    return 'folder_write_failed';
  }

  const api = { getRoot, setRoot, clearRoot, folderFailure };
  globalThis.MoodboardClip = Object.assign(globalThis.MoodboardClip || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})();

(() => {
  // A board name always matches [a-z0-9а-яё_-]{1,40} after NFC (docs/FORMAT.md).
  function boardName(raw) {
    if (typeof raw !== 'string') return 'unsorted';
    const name = raw.normalize('NFC').trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gu, '-').replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return name || 'unsorted';
  }

  const api = { boardName };
  globalThis.MoodboardClip = Object.assign(globalThis.MoodboardClip || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})();

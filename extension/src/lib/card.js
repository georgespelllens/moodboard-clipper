(() => {
  const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic'];
  const TYPE_EXTS = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heic',
  };

  // Truncates by code points, as docs/FORMAT.md counts them, and drops lone surrogates.
  function cleanText(value, limit) {
    if (typeof value !== 'string') return null;
    const text = Array.from(value.replace(CONTROL, '').trim().toWellFormed()).slice(0, limit).join('');
    return text || null;
  }

  // The aria-label of a pin link in the Russian interface wraps the title: «Страница пина «<title>»»;
  // an untitled pin reads «Без названия». Any other label (or none) is returned as it is.
  function pinTitle(label) {
    const match = /^Страница пина «(.*)»$/s.exec(label ?? '');
    if (!match) return label;
    return match[1] === 'Без названия' ? null : match[1];
  }

  const stripFragment = (u) => u.split('#')[0];
  const stripUrl = (u) => stripFragment(u).split('?')[0];

  function extFromUrl(u) {
    const match = /\.([A-Za-z0-9]+)$/.exec(stripUrl(u).split('/').pop());
    const ext = match && match[1].toLowerCase();
    return IMAGE_EXTS.includes(ext) ? ext : null;
  }

  function extFromType(contentType) {
    if (typeof contentType !== 'string') return null;
    return TYPE_EXTS[contentType.split(';')[0].trim().toLowerCase()] || null;
  }

  const utcStamp = (date) => isoUtc(date).replace(/[-:]/g, '');
  const isoUtc = (date) => date.toISOString().replace(/\.\d+Z$/, 'Z');

  const sanitizeKey = (k) => (typeof k === 'string' ? k.replace(/[^A-Za-z0-9-]/g, '-') : '');

  // Ids are capped at 80 characters (docs/FORMAT.md); only the key part gives way.
  function makeId(date, site, key) {
    const prefix = `${utcStamp(date)}-${site}-`;
    return prefix + sanitizeKey(key).slice(0, 80 - prefix.length);
  }

  async function sha1hex(text) {
    const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Web pages are told apart by their query string, feed sites are not.
  const repeatUrl = (site, url) => (site === 'web' ? stripFragment(url) : stripUrl(url));
  const repeatKey = (board, site, url) => `${board}|${repeatUrl(site, url)}`;

  async function keyFor(site, siteKey, url) {
    return sanitizeKey(siteKey) || (await sha1hex(repeatUrl(site, url))).slice(0, 10);
  }

  function httpUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || value.replace(CONTROL, '') !== value) return null;
    try {
      const { protocol, host } = new URL(value);
      return (protocol === 'http:' || protocol === 'https:') && host ? value : null;
    } catch { return null; }
  }

  function buildCard(c) {
    const web = c.site === 'web';
    const bare = (u) => (web ? stripUrl(u) : u);
    return {
      schema: 'moodboard-clip/1',
      id: c.id,
      board: c.board,
      site: c.site,
      saved_from: c.savedFrom,
      page_url: bare(c.pageUrl),
      page_url_kind: web ? 'tab' : c.pageUrlKind,
      asset_url: bare(c.assetUrl),
      asset_fallback: c.assetFallback ?? null,
      media: c.media ?? 'image',
      file: `${c.id}.${c.ext}`,
      title: cleanText(c.title, 500),
      alt: web ? null : cleanText(c.alt, 500),
      author: cleanText(c.author, 200) || 'unknown',
      author_url: httpUrl(c.authorUrl),
      saved_at: isoUtc(c.savedAt),
    };
  }

  const cardDataUrl = (card) =>
    'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(card, null, 2));

  const api = {
    CONTROL, cleanText, pinTitle, stripUrl, stripFragment, extFromUrl, extFromType, utcStamp, isoUtc,
    sanitizeKey, makeId, sha1hex, repeatUrl, repeatKey, keyFor, buildCard, cardDataUrl,
  };
  globalThis.MoodboardClip = Object.assign(globalThis.MoodboardClip || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})();

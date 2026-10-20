(() => {
  // `640w` and `2x` descriptors; a candidate without one counts as 1x. Junk entries are dropped.
  // Split on ", " or on a comma right after a descriptor, so commas inside URLs survive.
  function parseSrcset(srcset) {
    if (typeof srcset !== 'string') return [];
    const entries = [];
    for (const part of srcset.split(/(?<=\s[\d.]+[wx]),|,\s+/)) {
      const [url, descriptor, extra] = part.trim().split(/\s+/);
      if (!url || extra) continue;
      const match = descriptor === undefined ? [null, '1', 'x'] : /^(\d+(?:\.\d+)?)([wx])$/.exec(descriptor);
      if (!match) continue;
      const value = Number(match[1]);
      entries.push({ url, w: match[2] === 'w' ? value : null, x: match[2] === 'x' ? value : null });
    }
    return entries;
  }

  const widest = (entries) =>
    entries.reduce((best, e) => (!best || (e.w ?? e.x) > (best.w ?? best.x) ? e : best), null);

  // [vwebp/]<size>/<hash path>.<ext>; size is `originals`, `236x`, `1200x`, `75x75_RS` and alike.
  const PIN_PATH = /^\/(vwebp\/+)?(?:originals|\d+x\d*(?:_[A-Za-z]+)?)\/(.+)\.([A-Za-z0-9]+)$/;
  const PIN_RETRY_EXTS = ['png', 'jpg', 'webp', 'gif'];

  // Ordered candidates for the original of a Pinterest image (spec 4.3); label goes to `asset_fallback`.
  // A feed srcset ends with the real `originals/` address (its extension can differ from the thumbnails'
  // and then the same-extension guess is a 403), so that entry goes first when it is the same image on the CDN.
  function pinterestCandidates(shownUrl, srcset) {
    const shown = { url: shownUrl, label: 'shown' };
    let url;
    try { url = new URL(shownUrl); } catch { return [shown]; }
    const match = url.protocol === 'https:' && url.hostname === 'i.pinimg.com' && PIN_PATH.exec(url.pathname);
    if (!match) return [shown];
    const [, vwebp, path, ext] = match;
    const at = (size, name) => `${url.origin}/${size}/${name}`;
    // Sized copies keep the `vwebp/` prefix: that converter serves them as webp, originals sit without it.
    const sized = (size) => ({ url: at(`${vwebp ? 'vwebp/' : ''}${size}`, `${path}.${ext}`), label: size });
    const own = `/originals/${path}.`;
    const fromSrcset = parseSrcset(srcset).flatMap(({ url: raw }) => {
      let u;
      try { u = new URL(raw); } catch { return []; }
      const rest = u.pathname.startsWith(own) ? u.pathname.slice(own.length) : '';
      return u.protocol === 'https:' && u.hostname === url.hostname && /^[A-Za-z0-9]+$/.test(rest)
        ? [{ url: `${u.origin}${u.pathname}`, label: null }] : [];
    });
    const list = [
      ...fromSrcset,
      { url: at('originals', `${path}.${ext}`), label: null },
      ...PIN_RETRY_EXTS.filter((e) => e !== ext.toLowerCase())
        .map((e) => ({ url: at('originals', `${path}.${e}`), label: `originals.${e}` })),
      sized('1200x'),
      sized('736x'),
      shown,
    ];
    return list.filter((c, i) => list.findIndex((o) => o.url === c.url) === i);
  }

  // strip: the CDN address without a query is the original (test/fixtures/markup-notes.md).
  const COSMOS_RULE = { strip: true, param: null, max: null };

  function cosmosOriginal(shownUrl, srcset) {
    const best = widest(parseSrcset(srcset));
    let url;
    try { url = new URL(best ? best.url : shownUrl, shownUrl); } catch { return shownUrl; }
    const { strip, param, max } = COSMOS_RULE;
    url.hash = '';
    if (strip) url.search = '';
    else if (param && url.searchParams.has(param)) url.searchParams.set(param, String(max));
    return url.href;
  }

  const COSMOS_HOST = 'cdn.cosmos.so';
  const onCosmosCdn = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === COSMOS_HOST; } catch { return false; } };

  // Original first, shown copy as the last resort; anything off the CDN is never promoted to an original.
  function cosmosCandidates(shownUrl, srcset) {
    if (!onCosmosCdn(shownUrl)) return [{ url: shownUrl, label: 'shown' }];
    let best = cosmosOriginal(shownUrl, srcset);
    if (!onCosmosCdn(best)) best = cosmosOriginal(shownUrl, null);
    return best === shownUrl ? [{ url: shownUrl, label: null }] : [{ url: best, label: null }, { url: shownUrl, label: 'shown' }];
  }

  const api = { parseSrcset, pinterestCandidates, cosmosOriginal, cosmosCandidates, COSMOS_RULE };
  globalThis.MoodboardClip = Object.assign(globalThis.MoodboardClip || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})();

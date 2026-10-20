(() => {
  // defaults; confirmed or replaced from test/fixtures/markup-notes.md
  const SELECTORS = {
    media: 'img[src*="cdn.cosmos.so"]',
    card: '[data-testid="element-tile"]',
    elementIdAttr: 'data-element-id',
    elementLink: 'a[href*="/e/"]',
    elementId: /\/e\/([A-Za-z0-9-]+)/,
    author: '[data-testid="username"]',
    title: null,
  };

  const mediaAt = (elements) => elements.find((el) => el.matches(SELECTORS.media)) ?? null;

  const textOf = (selector, scope) => (selector ? scope.querySelector(selector)?.textContent ?? null : null);

  function read(media) {
    const card = SELECTORS.card && media.closest(SELECTORS.card);
    const link = media.closest(SELECTORS.elementLink) ?? card?.querySelector(SELECTORS.elementLink) ?? null;
    const attrId = card?.getAttribute(SELECTORS.elementIdAttr);
    // Feed tiles carry no element link; the address bar names an element only when the image is not inside a tile.
    const id = (/^[A-Za-z0-9-]+$/.test(attrId ?? '') ? attrId : null)
      ?? SELECTORS.elementId.exec(link?.href ?? '')?.[1] ?? (card ? null : SELECTORS.elementId.exec(location.pathname)?.[1]) ?? null;
    return {
      shownUrl: media.currentSrc || media.src,
      srcset: media.srcset || null,
      pageUrl: id ? `https://${location.host}/e/${id}` : location.href,
      pageUrlKind: id ? 'element' : 'tab',
      key: id,
      title: textOf(SELECTORS.title, card || document) ?? link?.getAttribute('aria-label') ?? null,
      alt: media.alt || null,
      author: textOf(SELECTORS.author, card || document),
      authorUrl: null,
      media: 'image',
    };
  }

  MoodboardClip.mountClipper({ name: 'cosmos', mediaAt, read });
})();

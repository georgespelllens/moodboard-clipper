(() => {
  // defaults; confirmed or replaced from test/fixtures/markup-notes.md
  const SELECTORS = {
    media: 'img[src*="i.pinimg.com"], video[poster*="i.pinimg.com"]',
    card: '[data-grid-item], [data-test-id="pin"], [data-test-pin-id]',
    pinIdAttr: 'data-test-pin-id',
    pinLink: 'a[href*="/pin/"]',
    pinId: /\/pin\/(\d+)/,
    author: '[data-test-id="creator-profile-name"]',
    title: null,
  };

  const mediaAt = (elements) => elements.find((el) => el.matches(SELECTORS.media)) ?? null;

  const textOf = (selector, scope) => (selector ? scope.querySelector(selector)?.textContent ?? null : null);

  function read(media) {
    const video = media.localName === 'video';
    const card = media.closest(SELECTORS.card);
    const link = media.closest(SELECTORS.pinLink) ?? card?.querySelector(SELECTORS.pinLink) ?? null;
    const attrId = media.closest(`[${SELECTORS.pinIdAttr}]`)?.getAttribute(SELECTORS.pinIdAttr);
    // On a pin closeup the image sits outside any pin link, but the address bar carries the id.
    const id = (/^\d+$/.test(attrId ?? '') ? attrId : null)
      ?? SELECTORS.pinId.exec(link?.href ?? '')?.[1] ?? SELECTORS.pinId.exec(location.pathname)?.[1] ?? null;
    return {
      shownUrl: video ? media.poster : media.currentSrc || media.src,
      srcset: media.srcset || null,
      pageUrl: id ? `https://${location.host}/pin/${id}/` : location.href,
      pageUrlKind: id ? 'pin' : 'tab',
      key: id,
      title: textOf(SELECTORS.title, card ?? document) ?? MoodboardClip.pinTitle(link?.getAttribute('aria-label') ?? null),
      alt: media.alt || null,
      author: textOf(SELECTORS.author, card ?? document),
      authorUrl: null,
      media: video ? 'video-poster' : 'image',
    };
  }

  MoodboardClip.mountClipper({ name: 'pinterest', mediaAt, read });
})();

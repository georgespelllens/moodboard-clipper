(() => {
  // Runs inside the page: chrome.scripting.executeScript serializes this function with toString(), so its body
  // must not reach for anything outside itself (no helper or constant of this file). It only reads the DOM.
  // A site such as Behance lays a transparent <a> over the image as a sibling; a right click then hits the link,
  // Chrome reports no image, and this finds the picture that lies under the clicked link.
  // Answer: { url } for the one image the link leads to, { miss: 'none' } when no image lies under it, and
  // { miss: 'many' } when links with the same address (href="#", javascript:, /cart/add) sit over different images,
  // because then the clicked one cannot be told apart and guessing would save the wrong picture.
  function findImageUnderLink(linkUrl, doc = document, win = window) {
    const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const overlap = (a, b) => area({
      left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
    });
    const view = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
    const onScreen = (node) => overlap(node.getBoundingClientRect(), view) > 0;

    const all = Array.from(doc.querySelectorAll('img'));
    let anchors = Array.from(doc.querySelectorAll('a[href]')).filter((a) => a.href === linkUrl);
    // An anchor is shown when its own box or any image inside it is on screen (display: contents gives a zero box).
    const shown = anchors.filter((a) => onScreen(a) || Array.from(a.querySelectorAll('img')).some(onScreen));
    if (shown.length) anchors = shown;

    const usable = (image) => {
      const rect = image.getBoundingClientRect();
      const url = image.currentSrc || image.src;
      return rect.right - rect.left >= 32 && rect.bottom - rect.top >= 32
        && typeof url === 'string' && /^https?:\/\//i.test(url);
    };

    // Every anchor picks its own best image; the link is unambiguous only when they all agree on one element.
    const winners = new Set();
    for (const anchor of anchors) {
      const box = anchor.getBoundingClientRect();
      let best = null;
      let bestWeight = 0;
      for (const image of all) {
        const rect = image.getBoundingClientRect();
        let weight = 0;
        if (anchor.contains(image)) {
          weight = overlap(rect, view);
        } else {
          const common = overlap(rect, box);
          if (common > 0 && common >= 0.5 * Math.min(area(rect), area(box))) weight = common;
        }
        if (weight <= bestWeight || !usable(image)) continue;
        best = image;
        bestWeight = weight;
      }
      if (best) winners.add(best);
    }

    if (winners.size === 0) return { miss: 'none' };
    if (winners.size > 1) return { miss: 'many' };
    const only = Array.from(winners)[0];
    return { url: only.currentSrc || only.src };
  }

  // Same site family, other layout: a grid module covers its pointer-events:none image with an empty <span>, so the
  // right click has no link and no image to report and findImageUnderLink has nothing to match. The Behance content
  // script calls this at right-click time with the clicked element and point; it walks up from there: the nearest ancestor
  // whose subtree holds an image that contains the point decides.
  // Answer: { url } for one distinct address, { miss: 'many' } for several, { miss: 'none' } for no image.
  function findImageAtPoint(target, x, y) {
    const usable = (image) => {
      const rect = image.getBoundingClientRect();
      const url = image.currentSrc || image.src;
      return rect.right - rect.left >= 32 && rect.bottom - rect.top >= 32
        && typeof url === 'string' && /^https?:\/\//i.test(url);
    };
    const under = (image) => {
      const rect = image.getBoundingClientRect();
      return rect.left <= x && x <= rect.right && rect.top <= y && y <= rect.bottom;
    };

    let node = target;
    for (let level = 0; node && level < 6; level += 1, node = node.parentElement) {
      const candidates = Array.from(node.querySelectorAll('img'));
      if (node.localName === 'img') candidates.unshift(node);
      const urls = new Set(candidates.filter((image) => under(image) && usable(image))
        .map((image) => image.currentSrc || image.src));
      if (urls.size === 1) return { url: Array.from(urls)[0] };
      if (urls.size > 1) return { miss: 'many' };
    }
    return { miss: 'none' };
  }

  const api = { findImageUnderLink, findImageAtPoint };
  globalThis.MoodboardClip = Object.assign(globalThis.MoodboardClip || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})();

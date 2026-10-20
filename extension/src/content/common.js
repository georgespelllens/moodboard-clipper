(() => {
  const { stripFragment, reasonText } = globalThis.MoodboardClip;
  const SIZE = 30;
  const INSET = 8;
  const MIN_MEDIA = 150;
  const RESULT_MS = 120000;
  const GLYPH = { idle: '＋', busy: '⏳', ok: '✓', error: '✗' };
  // Styles go through CSSOM only: inline <style> and style="" are blocked by strict page CSP.
  const HOST_STYLE = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;pointer-events:none';
  const BUTTON_STYLE = `all:initial;box-sizing:border-box;position:fixed;display:none;width:${SIZE}px;height:${SIZE}px;` +
    'border-radius:50%;background:#1b1b1f;color:#fff;font:16px/30px system-ui,sans-serif;text-align:center;' +
    'cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.5)';

  // site: { name, mediaAt(elements), read(media), corner?(media) }, see pinterest.js.
  function mountClipper(site) {
    const host = document.createElement('div');
    host.style.cssText = HOST_STYLE;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', chrome.i18n.getMessage('buttonLabel'));
    button.style.cssText = BUTTON_STYLE;
    host.attachShadow({ mode: 'closed' }).append(button);
    document.documentElement.append(host);

    const saved = new Set();
    const inflight = new Map(); // token → { url, gen, timer }
    let gen = 0; // bumped on a board switch: results of older requests no longer count as saved here
    let media = null;
    let state = 'idle';
    let shownToken = null;
    let lastContext = null;
    let frame = 0;
    let resizeFrame = 0;
    let x = 0;
    let y = 0;

    // getMessage throws once the extension is reloaded under the page; then the raw code is shown.
    const message = (key) => { try { return chrome.i18n.getMessage(key); } catch { return ''; } };

    function setState(next, reason = '') {
      state = next;
      button.textContent = GLYPH[next];
      button.title = reasonText(reason, message);
    }

    const hide = () => { button.style.display = 'none'; };

    function place(el) {
      const r = el.getBoundingClientRect();
      if (r.width < MIN_MEDIA || r.height < MIN_MEDIA) return hide();
      const corner = site.corner?.(el) ?? 'bottom-left';
      const left = corner.endsWith('right') ? r.right - SIZE - INSET : r.left + INSET;
      const top = corner.startsWith('top') ? r.top + INSET : r.bottom - SIZE - INSET;
      const { clientWidth, clientHeight } = document.documentElement;
      button.style.left = `${Math.min(Math.max(left, 0), clientWidth - SIZE)}px`;
      button.style.top = `${Math.min(Math.max(top, 0), clientHeight - SIZE)}px`;
      button.style.display = 'block';
    }

    function track() {
      const stack = document.elementsFromPoint(x, y);
      if (stack.includes(host)) return;
      const found = site.mediaAt(stack);
      if (!found) return hide();
      // A result glyph is dropped on re-entry; a running request keeps its hourglass.
      if (found !== media || (state !== 'busy' && button.style.display === 'none')) {
        media = found;
        shownToken = null;
        setState('idle');
      }
      place(found);
    }

    function settle(token, status, reason) {
      const entry = inflight.get(token);
      if (!entry) return;
      clearTimeout(entry.timer);
      inflight.delete(token);
      if (status !== 'error' && entry.gen === gen) saved.add(entry.url);
      if (shownToken !== token) return;
      if (status === 'error') setState('error', reason);
      else setState('ok', status === 'repeat' ? 'already_in_board' : '');
    }

    async function clip() {
      if (!media?.isConnected) return hide();
      if (state === 'busy') return;
      if (location.protocol !== 'https:') return setState('error', 'not_https');
      const data = site.read(media);
      const url = data.shownUrl;
      if (!url || /^(blob|data):/.test(url)) return setState('error', 'no_image_url');
      if (saved.has(url)) return setState('ok', 'already_in_board');
      const twin = [...inflight].find(([, e]) => e.url === url && e.gen === gen);
      if (twin) { shownToken = twin[0]; return setState('busy'); }
      const token = crypto.randomUUID();
      inflight.set(token, { url, gen, timer: 0 });
      shownToken = token;
      setState('busy');
      try {
        const res = await chrome.runtime.sendMessage({ type: 'clip', token, site: site.name, savedFrom: 'feed-button', ...data });
        if (res?.status === 'pending') {
          // The final clip-result can be lost (tab reloaded, worker restarted): never leave the hourglass forever.
          const entry = inflight.get(token);
          if (entry) entry.timer = setTimeout(() => settle(token, 'error', 'no_reply'), RESULT_MS);
        } else settle(token, res?.status ?? 'error', res?.reason ?? 'no_reply');
      } catch {
        settle(token, 'error', 'extension_unavailable');
      }
    }

    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    button.addEventListener('pointerdown', swallow, true);
    button.addEventListener('mousedown', swallow, true);
    button.addEventListener('click', (e) => { swallow(e); clip(); }, true);

    document.addEventListener('pointermove', (e) => {
      x = e.clientX;
      y = e.clientY;
      frame ||= requestAnimationFrame(() => { frame = 0; track(); });
    }, { capture: true, passive: true });
    document.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', () => {
      resizeFrame ||= requestAnimationFrame(() => {
        resizeFrame = 0;
        if (media?.isConnected && button.style.display !== 'none') place(media);
      });
    }, { passive: true });
    window.addEventListener('popstate', hide);
    document.addEventListener('contextmenu', (e) => {
      const el = site.mediaAt(document.elementsFromPoint(e.clientX, e.clientY));
      lastContext = el && site.read(el);
    }, true);

    // The repeat memory belongs to one board: after a board switch the worker decides again.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.activeBoard) return;
      saved.clear();
      gen += 1;
    });

    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (msg?.type === 'clip-result') settle(msg.token, msg.status, msg.reason);
      else if (msg?.type === 'probe-context') {
        const want = stripFragment(msg.srcUrl ?? '');
        let found = null;
        if (lastContext && stripFragment(lastContext.shownUrl ?? '') === want) {
          found = lastContext;
        } else if (msg.byUrl && want) {
          // byUrl: the worker took the address from a link over or beside the picture (a title link, a transparent overlay),
          // so the right click never landed on the picture and nothing was remembered: read the picture that shows this address.
          // The address chain is the one the worker's finder and read() use (currentSrc, then src; a video shows its poster).
          const shows = (el) => stripFragment(el.currentSrc || el.src || '') === want
            || (el.localName === 'video' && stripFragment(el.poster || '') === want);
          const el = [...document.querySelectorAll('img, video')].find(shows);
          const media = el ? site.mediaAt([el]) : null;
          found = media ? site.read(media) : null;
        }
        respond(found);
      }
    });
  }

  globalThis.MoodboardClip = Object.assign(globalThis.MoodboardClip || {}, { mountClipper });
})();

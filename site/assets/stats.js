// Visit statistics of the landing, kept on our own server and sent to no one else: visits, where people come from,
// what they click, how long they stay on each part of the page and how far they scroll, plus the goals below.
// The server address comes with the page on spelllens.ru (data-endpoint on this script). Without it nothing is sent:
// events go to window.__mcStats and the console, so they can be checked in a browser. What is sent: docs/STATS.md.
(() => {
  const ENDPOINT = document.currentScript && document.currentScript.dataset.endpoint;
  const lang = document.documentElement.lang || 'en';
  const stats = (window.__mcStats = []);

  // A random id for the browser and one for the visit; a visit ends after 30 minutes without the page in use.
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  let fresh = false;
  let vid = rid();
  let sid = rid();
  try {
    const known = localStorage.getItem('sl_vid');
    if (known) vid = known;
    else { fresh = true; localStorage.setItem('sl_vid', vid); }
    if (Date.now() - (+localStorage.getItem('sl_seen') || 0) < 30 * 60e3) sid = localStorage.getItem('sl_sid') || sid;
    localStorage.setItem('sl_sid', sid);
  } catch { /* storage is off: every page view counts as a new visitor */ }
  const seen = () => { try { localStorage.setItem('sl_seen', Date.now()); } catch { /* storage is off */ } };
  const pid = rid();

  function send(e) {
    stats.push(e);
    seen();
    if (!ENDPOINT) return console.info('[stats off]', e);
    const body = JSON.stringify({ pid, vid, sid, e });
    if (!navigator.sendBeacon || !navigator.sendBeacon(ENDPOINT, body)) {
      fetch(ENDPOINT, { method: 'POST', body, keepalive: true, mode: 'no-cors' }).catch(() => {});
    }
  }

  const q = new URLSearchParams(location.search);
  const utm = {};
  for (const k of ['source', 'medium', 'campaign']) if (q.get(`utm_${k}`)) utm[k] = q.get(`utm_${k}`);
  send({
    k: 'view', u: location.origin + location.pathname, lang, ref: document.referrer, utm, new: fresh ? 1 : 0,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, langs: (navigator.languages || []).slice(0, 3).join(','),
    screen: `${screen.width}x${screen.height}`, vp: `${innerWidth}x${innerHeight}`,
    touch: matchMedia('(pointer: coarse)').matches ? 1 : 0, wd: navigator.webdriver ? 1 : 0,
  });

  const sent = new Set();
  function goal(name, params = {}, once = false) {
    if (once && sent.has(name)) return;
    sent.add(name);
    send({ k: 'goal', n: name, p: params });
  }

  // Parts of the page, top to bottom; a click or a second on the page is credited to one of them.
  const PLACES = [['header', 'header'], ['.hero', 'hero'], ['#install', 'install'], ['#features', 'features'],
    ['#privacy', 'privacy'], ['#faq', 'faq'], ['.final', 'final'], ['footer', 'footer']];
  const place = (el) => (PLACES.find(([sel]) => el.closest(sel)) || [, 'other'])[1];
  const round = (x) => Math.round(x * 1000) / 1000;
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(0, 80);

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest('a[href], button, summary, [role="button"], input, select, label');
    const a = el && el.closest('a[href]');
    const t = e.target;
    const name = el ? label(el) || el.tagName.toLowerCase()
      : t.getAttribute('alt') || (t.tagName === 'VIDEO' ? 'video' : t.tagName === 'IMG' ? 'image' : label(t).slice(0, 40).trim() || t.tagName.toLowerCase());
    send({ k: 'click', n: name, p: { place: place(el || t), href: a ? a.getAttribute('href') : undefined, nolink: el ? undefined : 1,
      x: round(e.clientX / innerWidth), y: round(e.pageY / document.documentElement.scrollHeight) } });

    if (a) {
      const href = a.getAttribute('href');
      const where = place(a);
      if (href.endsWith('moodboard-clipper-extension.zip')) goal('download', { place: where });
      else if (href.endsWith('SHA256SUMS.txt')) goal('checksums', { place: where });
      else if (a.hostname === 'github.com') goal('github', { place: where, path: a.pathname });
      else if (a.hasAttribute('hreflang')) goal('lang_switch', { to: a.getAttribute('hreflang') });
      else if (href.startsWith('#')) goal('nav', { to: href.slice(1), place: where });
      return;
    }
    const step = t.closest('.steps__list li button');
    if (step) goal('step_click', { n: [...document.querySelectorAll('.steps__list li')].indexOf(step.closest('li')) + 1 });
  });

  // A question opened in the FAQ.
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && d.open) goal('faq_open', { q: d.querySelector('summary')?.textContent.trim() });
  }, true);

  // Time on the page counts while it is in view and was used (scrolled, pointed, touched, typed) in the last
  // 30 seconds; it goes to the part of the page that crosses the middle line of the screen. The totals and the
  // deepest scroll are sent each time the page goes out of view, and every 30 seconds while it is in view.
  let engaged = 0;
  let deepest = 0;
  let current = 'hero';
  let lastTick = performance.now();
  let lastInput = lastTick;
  const dwell = {};
  for (const t of ['scroll', 'wheel', 'pointermove', 'pointerdown', 'keydown', 'touchstart']) {
    addEventListener(t, () => { lastInput = performance.now(); }, { passive: true, capture: true });
  }
  function tick() {
    const now = performance.now();
    if (document.visibilityState === 'visible' && now - lastInput < 30e3) {
      engaged += now - lastTick;
      dwell[current] = (dwell[current] || 0) + (now - lastTick);
    }
    lastTick = now;
    const h = document.documentElement.scrollHeight;
    deepest = Math.max(deepest, Math.min(100, Math.round(((scrollY + innerHeight) / h) * 100)));
  }
  let reported = '';
  function report() {
    tick();
    const d = {};
    for (const k in dwell) d[k] = Math.round(dwell[k]);
    const e = { k: 'time', engaged: Math.round(engaged), scroll: deepest, dwell: d };
    const key = JSON.stringify([Math.round(engaged / 1000), deepest, Object.keys(d).length]);
    if (key !== reported) { reported = key; send(e); }
  }
  setInterval(tick, 1000);
  setInterval(() => document.visibilityState === 'visible' && report(), 30e3);
  addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? report() : tick()));
  addEventListener('pagehide', report);

  addEventListener('DOMContentLoaded', () => {
    const middle = { rootMargin: '-50% 0px -50% 0px' };
    const parts = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { tick(); current = en.target.dataset.place; }
    }, middle);
    for (const [sel, name] of PLACES) {
      const el = document.querySelector(sel);
      if (el) { el.dataset.place = name; parts.observe(el); }
    }

    // A section counts as seen once it crosses the middle line of the screen, once per page view.
    const seenParts = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { goal(en.target.dataset.goal, {}, true); seenParts.unobserve(en.target); }
    }, middle);
    for (const [sel, name] of [['#install', 'seen_install'], ['#features', 'seen_features'], ['#privacy', 'seen_privacy'],
      ['#faq', 'seen_faq'], ['.final', 'seen_end']]) {
      const el = document.querySelector(sel);
      if (el) { el.dataset.goal = name; seenParts.observe(el); }
    }

    // How far into the install a visitor got. Under the sticky frame (site.js) the open step is the one with
    // is-active while the steps track crosses the middle line; on narrow screens the steps stand one under another,
    // their buttons are disabled, and a step counts once it crosses the middle line itself.
    const items = [...document.querySelectorAll('.steps__list li')];
    const track = document.querySelector('.steps__track');
    if (!items.length || !track) return;
    // Scrolling fast past a step still counts it: reaching a step counts the ones above it too.
    const reach = (li) => { for (let i = 0; i <= items.indexOf(li); i++) goal(`step_${i + 1}`, {}, true); };
    let queued = false;
    addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const r = track.getBoundingClientRect();
        const li = items.find((x) => x.classList.contains('is-active') && x.querySelector('button:not([disabled])'));
        if (li && r.top < innerHeight / 2 && r.bottom > innerHeight / 2) reach(li);
      });
    }, { passive: true });
    const flat = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting && en.target.querySelector('button[disabled]')) reach(en.target);
    }, middle);
    items.forEach((li) => flat.observe(li));
  });
})();

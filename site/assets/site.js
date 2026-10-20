// Scenes are drawn at a fixed size (data-w) and scaled to their frame like a video, so every animation runs in scene pixels.
// A frame plays only while it is on screen. The install steps scroll under a sticky frame on wide screens.
(() => {
  const stages = [...document.querySelectorAll('[data-scene]')].filter((s) => s.querySelector('.scene'));
  // No scenes (scenes.js did not load): fall back to the layout without JavaScript, every step text open.
  if (!stages.length) { document.documentElement.classList.remove('js'); return; }

  for (const stage of stages) {
    const w = Number(stage.querySelector('.scene').dataset.w);
    new ResizeObserver(([e]) => stage.style.setProperty('--k', e.contentRect.width / w)).observe(stage);
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('is-playing', e.isIntersecting && e.intersectionRatio >= 0.2);
  }, { threshold: [0, 0.2] });
  stages.forEach((s) => io.observe(s));

  const track = document.querySelector('.steps__track');
  const sticky = document.querySelector('.steps__sticky');
  const frame = document.querySelector('.steps__frame [data-scene]');
  const items = [...document.querySelectorAll('.steps__list li')];
  if (!track || !sticky || !frame || !items.length) return;
  const scenes = [...frame.querySelectorAll('.scene')];
  const dots = [...document.querySelectorAll('.pager b')];
  const parts = items.map((li) => ({ button: li.querySelector('button'), text: li.querySelector('.d'), stage: li.querySelector('[data-scene]') }));
  // Must match the media query of the sticky layout in site.css.
  const wide = matchMedia('(min-width: 960px) and (min-height: 640px) and (prefers-reduced-motion: no-preference)');
  let active = -1;

  function setActive(i) {
    if (i === active) return;
    active = i;
    items.forEach((li, k) => {
      const on = k === i;
      li.classList.toggle('is-active', on);
      parts[k].button.setAttribute('aria-expanded', String(on));
      parts[k].text.inert = !on;
    });
    dots.forEach((d, k) => d.classList.toggle('is-active', k === i));
    scenes.forEach((s) => s.classList.remove('is-on'));
    void frame.offsetWidth; // the step's scene starts again from its first frame
    scenes[i]?.classList.add('is-on');
    frame.setAttribute('aria-label', parts[i].stage?.getAttribute('aria-label') || '');
  }

  // The sticky block stays put while the track scrolls under it; that run is split evenly between the steps.
  const geometry = () => ({
    top: track.getBoundingClientRect().top,
    stick: parseFloat(getComputedStyle(sticky).top) || 0,
    span: Math.max(track.offsetHeight - sticky.offsetHeight, 1),
  });
  function update() {
    if (!wide.matches) return;
    const g = geometry();
    const p = Math.min(Math.max((g.stick - g.top) / g.span, 0), 0.9999);
    setActive(Math.floor(p * items.length));
  }

  // Narrow or short screens and reduced motion: steps one under another, every text open, each with its own frame.
  function layout() {
    active = -1;
    if (wide.matches) {
      parts.forEach((p) => { p.button.disabled = false; });
      update();
      return;
    }
    items.forEach((li, k) => {
      li.classList.remove('is-active');
      parts[k].button.removeAttribute('aria-expanded');
      parts[k].button.disabled = true;
      parts[k].text.inert = false;
    });
    dots.forEach((d) => d.classList.remove('is-active'));
    scenes.forEach((s) => s.classList.remove('is-on'));
  }

  parts.forEach((p, k) => p.button.addEventListener('click', () => {
    if (!wide.matches) return;
    const g = geometry();
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollTo({ top: scrollY + g.top - g.stick + ((k + 0.5) / items.length) * g.span, behavior: smooth ? 'smooth' : 'auto' });
  }));
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update, { passive: true });
  wide.addEventListener('change', layout);
  layout();
})();

(() => {
  // Behance: the worker's "Save to moodboard" page item cannot tell which grid module was right-clicked (the menu click
  // carries no coordinates and an empty element covers the image), so this looks the picture up at right-click time,
  // before a lazy re-render can detach the clicked element, and hands that answer to the worker once.
  // Loaded with lib/overlay.js only: no card, probe or overlay of its own.
  let last = null;

  // Capture phase: the click is seen before page handlers run (one that stops it at window capture could still hide it).
  window.addEventListener('contextmenu', (event) => {
    try {
      last = MoodboardClip.findImageAtPoint(event.target, event.clientX, event.clientY);
    } catch {
      last = { miss: 'none' };
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type !== 'image-at-point') return false;
    respond(last || { miss: 'none' });
    last = null;
    return false;
  });
})();

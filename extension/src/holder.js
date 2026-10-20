// The write grant for the chosen folder lasts only while some page holds its handle. The popup closes and the
// service worker sleeps, so this offscreen page holds it for them.
let root = null;

async function load() {
  root = await MoodboardClip.getRoot().catch(() => null);
  return Boolean(root);
}

load();
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== 'holder-reload') return false;
  load().then((ok) => respond({ ok }));
  return true;
});

// Raw Chrome DevTools Protocol client over WebSocket (Node 22 global WebSocket).
// Playwright is not used: its download handling renames files to GUIDs.

export async function connect(wsUrl, timeoutMs = 15000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    // A socket that never opens must not stay pending: close() aborts the handshake.
    const timer = setTimeout(() => {
      reject(new Error(`CDP connect timed out after ${timeoutMs} ms: ${wsUrl}`)); // before close(): it fires 'error' synchronously
      ws.close();
    }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${wsUrl}`)); }, { once: true });
  });
  let next = 0;
  let closed = false;
  const calls = new Map();
  const listeners = new Set();
  const closers = new Set();
  const take = (id) => { // removes a pending call and its timer
    const call = calls.get(id);
    if (call) { calls.delete(id); clearTimeout(call.timer); }
    return call;
  };
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && calls.has(msg.id)) {
      const { resolve, reject, method } = take(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of [...listeners]) fn(msg);
    }
  });
  ws.addEventListener('close', () => {
    closed = true;
    for (const id of [...calls.keys()]) { const { reject, method } = take(id); reject(new Error(`${method}: socket closed`)); }
    for (const fn of [...closers]) fn();
  });

  // Default 120 s: some evaluate() calls await downloads that take up to ~45 s inside the page. Pass timeoutMs to override.
  function send(method, params = {}, sessionId, timeoutMs = 120000) {
    const id = ++next;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return reject(new Error(`${method}: socket closed`));
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => { calls.delete(id); reject(new Error(`${method}: no reply within ${timeoutMs} ms`)); }, timeoutMs) : null;
      calls.set(id, { resolve, reject, method, timer });
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        take(id);
        reject(new Error(`${method}: send failed: ${error.message}`));
      }
    });
  }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function waitFor(predicate, timeoutMs = 15000, label = 'event') {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error(`socket closed while waiting for ${label}`));
      const settle = (fn, value) => { clearTimeout(timer); off(); closers.delete(onClose); fn(value); };
      const onClose = () => settle(reject, new Error(`socket closed while waiting for ${label}`));
      const off = on((msg) => {
        try { if (predicate(msg)) settle(resolve, msg); } catch (error) { settle(reject, error); }
      });
      const timer = setTimeout(() => settle(reject, new Error(`timeout waiting for ${label}`)), timeoutMs);
      closers.add(onClose);
    });
  }
  return { send, on, waitFor, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function evaluate(cdp, sessionId, expression, timeoutMs) {
  const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
  if (reply.exceptionDetails) {
    const d = reply.exceptionDetails;
    throw new Error(`evaluate failed: ${d.exception?.description || d.text}`);
  }
  return reply.result.value;
}

export async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

export async function targets(cdp) {
  return (await cdp.send('Target.getTargets')).targetInfos;
}

// Extension service worker target; null when the worker is asleep.
export async function workerTarget(cdp, extensionId) {
  return (await targets(cdp)).find((t) => t.type === 'service_worker'
    && t.url.startsWith(`chrome-extension://${extensionId}/`)) || null;
}

// First extension worker that appears after launch; returns its extension id.
export async function discoverExtension(cdp, workerFile, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = (await targets(cdp)).find((t) => t.type === 'service_worker'
      && t.url.startsWith('chrome-extension://') && t.url.endsWith(`/${workerFile}`));
    if (hit) return new URL(hit.url).host;
    await sleep(200);
  }
  throw new Error(`extension worker ${workerFile} did not start; is --load-extension honoured?`);
}

const closeTarget = (cdp, targetId) => cdp.send('Target.closeTarget', { targetId }).catch(() => null);

// A page that never reaches readyState complete (heavy live pages) is closed by default. With keepOnTimeout the target
// stays open and the error carries it as error.page = { targetId, sessionId }, so the caller can still dump what rendered.
// Any other failure closes the target before rethrowing.
export async function openPage(cdp, url, { keepOnTimeout = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  let sessionId;
  try {
    sessionId = await attach(cdp, targetId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await waitForLoad(cdp, sessionId, 15000, url);
    return { targetId, sessionId };
  } catch (error) {
    if (error.loadTimeout && keepOnTimeout) throw Object.assign(error, { page: { targetId, sessionId } });
    await closeTarget(cdp, targetId);
    throw error;
  }
}

// The initial about:blank of a fresh target is already "complete": wait for the real navigation to commit.
// url is only used in the error message when the navigation ends on Chrome's error page (DNS failure, refused, ...).
export async function waitForLoad(cdp, sessionId, timeoutMs = 15000, url = '') {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // A busy page can stall evaluate(): bound it by the remaining budget instead of the 120 s default.
    const [state, href] = await evaluate(cdp, sessionId, '[document.readyState, location.href]', Math.max(500, until - Date.now())).catch(() => []);
    if (href?.startsWith('chrome-error:')) throw new Error(`page failed to load: ${url || href}`);
    if (state === 'complete' && href !== 'about:blank') return;
    await sleep(100);
  }
  throw Object.assign(new Error('page did not finish loading'), { loadTimeout: true });
}

// Evaluates in the extension worker, waking it through an extension page if it sleeps.
export async function inWorker(cdp, extensionId, expression, wakePage, timeoutMs) {
  let target = await workerTarget(cdp, extensionId);
  if (!target) {
    const page = await openPage(cdp, `chrome-extension://${extensionId}/${wakePage}`);
    try {
      await evaluate(cdp, page.sessionId, 'chrome.runtime.sendMessage({type: "ping"}).catch(() => null)', timeoutMs);
    } finally {
      await closeTarget(cdp, page.targetId);
    }
    for (let i = 0; i < 50 && !target; i++) { await sleep(100); target = await workerTarget(cdp, extensionId); }
    if (!target) throw new Error('worker did not wake');
  }
  // A worker target that just appeared answers from a context where the extension bindings are not installed yet
  // (chrome.runtime and chrome.storage undefined): attach again until chrome.runtime.id is there.
  for (let attempt = 0; ; attempt++) {
    const sessionId = await attach(cdp, target.targetId);
    try {
      const ready = await evaluate(cdp, sessionId, `typeof chrome === 'object' && typeof chrome.runtime?.id === 'string'`, timeoutMs);
      if (ready) return await evaluate(cdp, sessionId, expression, timeoutMs);
      if (attempt >= 50) throw new Error('worker bindings not ready after 50 attempts');
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => null);
    }
    await sleep(100);
  }
}

export async function click(cdp, sessionId, x, y, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }, sessionId);
}

export async function hover(cdp, sessionId, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
}

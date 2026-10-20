(() => {
  const CODE = /^[a-z_]+$/;

  // Reasons are stored as codes and turned into text when shown. Anything else is shown as it is:
  // a 0.1.0 entry in Russian, a Chrome download error such as NETWORK_FAILED, a code without a message.
  function reasonText(reason, getMessage) {
    if (!reason) return '';
    if (!CODE.test(reason)) return reason;
    return getMessage(`reason_${reason}`) || reason;
  }

  // Fills data-i18n (text), data-i18n-placeholder and data-i18n-aria-label from messages.json.
  // An empty message keeps the English default written in the HTML.
  function localize(root, getMessage) {
    const fill = (attribute, apply) => {
      for (const node of root.querySelectorAll(`[${attribute}]`)) {
        const text = getMessage(node.getAttribute(attribute));
        if (text) apply(node, text);
      }
    };
    fill('data-i18n', (node, text) => { node.textContent = text; });
    fill('data-i18n-placeholder', (node, text) => node.setAttribute('placeholder', text));
    fill('data-i18n-aria-label', (node, text) => node.setAttribute('aria-label', text));
  }

  const api = { reasonText, localize };
  globalThis.MoodboardClip = Object.assign(globalThis.MoodboardClip || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})();

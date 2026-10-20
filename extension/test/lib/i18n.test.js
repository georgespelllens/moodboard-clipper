const test = require('node:test');
const assert = require('node:assert/strict');
const { reasonText, localize } = require('../../src/lib/i18n.js');

const messages = { reason_not_https: 'page is not https', boardLabel: 'Board', newBoardPlaceholder: 'New board', newBoardAria: 'New board name' };
const getMessage = (key) => messages[key] ?? '';

test('an empty reason gives an empty text', () => {
  assert.equal(reasonText(undefined, getMessage), '');
  assert.equal(reasonText('', getMessage), '');
});

test('a code is shown as its message', () => {
  const asked = [];
  assert.equal(reasonText('not_https', (key) => { asked.push(key); return getMessage(key); }), 'page is not https');
  assert.deepEqual(asked, ['reason_not_https']);
});

test('a code without a message is shown as the code', () => {
  assert.equal(reasonText('brand_new_code', getMessage), 'brand_new_code');
});

test('a 0.1.0 reason in Russian is shown as it is, without a lookup', () => {
  let asked = false;
  assert.equal(reasonText('страница не https', () => { asked = true; return 'x'; }), 'страница не https');
  assert.equal(asked, false);
});

test('a Chrome download error is shown as it is', () => {
  assert.equal(reasonText('NETWORK_FAILED', getMessage), 'NETWORK_FAILED');
});

function node(attributes, text = '') {
  return {
    attributes: { ...attributes },
    textContent: text,
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}
const root = (nodes) => ({ querySelectorAll: (selector) => nodes.filter((n) => selector.slice(1, -1) in n.attributes) });

test('localize fills text, placeholder and aria-label', () => {
  const label = node({ 'data-i18n': 'boardLabel' }, 'x');
  const input = node({ 'data-i18n-placeholder': 'newBoardPlaceholder', 'data-i18n-aria-label': 'newBoardAria' });
  localize(root([label, input]), getMessage);
  assert.equal(label.textContent, 'Board');
  assert.equal(input.attributes.placeholder, 'New board');
  assert.equal(input.attributes['aria-label'], 'New board name');
});

test('an empty message keeps the default from the HTML', () => {
  const title = node({ 'data-i18n': 'missingKey' }, 'Recent saves');
  localize(root([title]), getMessage);
  assert.equal(title.textContent, 'Recent saves');
});

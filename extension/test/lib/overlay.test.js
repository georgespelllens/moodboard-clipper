const test = require('node:test');
const assert = require('node:assert/strict');
const { findImageUnderLink, findImageAtPoint } = require('../../src/lib/overlay.js');

// A tiny fake DOM: just what findImageUnderLink touches.
const rect = ([left, top, right, bottom]) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const img = (url, box, extra = {}) => ({ localName: 'img', currentSrc: url, src: url, getBoundingClientRect: () => rect(box), ...extra });
function link(href, box, inside = []) {
  return {
    localName: 'a', href, getBoundingClientRect: () => rect(box),
    querySelectorAll: (sel) => (sel === 'img' ? inside : []),
    contains: (node) => inside.includes(node),
  };
}
// `imgs` is the document order of every image, wrapped ones included.
const page = (anchors, imgs) => ({
  querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : sel === 'img' ? imgs : []),
});
const win = { innerWidth: 1000, innerHeight: 800 };
const HREF = 'https://site.test/gallery/1';
const PHOTO = 'https://cdn.test/photo.jpg';
const find = (anchors, imgs, href = HREF) => findImageUnderLink(href, page(anchors, imgs), win);
// The answer is { url } for one image, { miss: 'none' } for no image, { miss: 'many' } when several different images could be meant.
const hit = (url) => ({ url });
const NONE = { miss: 'none' };
const MANY = { miss: 'many' };

test('sibling overlay (Behance shape): the image under a transparent link is found', () => {
  const photo = img(PHOTO, [100, 100, 500, 400]);
  assert.deepEqual(find([link(HREF, [100, 100, 500, 400])], [photo]), hit(PHOTO));
});

test('an image wrapped by the link is found', () => {
  const photo = img(PHOTO, [100, 100, 500, 400]);
  assert.deepEqual(find([link(HREF, [100, 100, 500, 400], [photo])], [photo]), hit(PHOTO));
});

test('a wrapped image counts by its visible area even when the link box is something else', () => {
  const photo = img(PHOTO, [10, 10, 210, 210]);
  assert.deepEqual(find([link(HREF, [0, 0, 5, 5], [photo])], [photo]), hit(PHOTO));
});

test('a text link with no image under it gives null', () => {
  const far = img(PHOTO, [300, 300, 600, 600]);
  assert.deepEqual(find([link(HREF, [10, 10, 90, 30])], [far]), NONE);
  assert.deepEqual(find([link(HREF, [10, 10, 90, 30])], []), NONE);
});

test('links with another address are ignored', () => {
  const photo = img(PHOTO, [100, 100, 500, 400]);
  assert.deepEqual(find([link('https://site.test/other', [100, 100, 500, 400])], [photo]), NONE);
});

test('an image that covers less than half of the smaller box does not count', () => {
  // image 100x100, link 240x100 starting at x=60: overlap 40x100 = 4000 < 0.5 * 10000
  assert.deepEqual(find([link(HREF, [60, 0, 300, 100])], [img(PHOTO, [0, 0, 100, 100])]), NONE);
});

test('exactly half of the smaller box is enough', () => {
  // overlap 50x100 = 5000 = 0.5 * min(10000, 25000)
  assert.deepEqual(find([link(HREF, [50, 0, 300, 100])], [img(PHOTO, [0, 0, 100, 100])]), hit(PHOTO));
});

test('the half rule uses the smaller of the two boxes', () => {
  // a small badge image fully inside a big link: overlap = the whole badge = min(area), so it counts
  const badge = img(PHOTO, [10, 10, 60, 60]);
  assert.deepEqual(find([link(HREF, [0, 0, 400, 400])], [badge]), hit(PHOTO));
});

test('two candidates: the one with the bigger weight wins, not the first', () => {
  const small = img('https://cdn.test/small.jpg', [0, 0, 100, 100]);
  const big = img('https://cdn.test/big.jpg', [0, 0, 300, 300]);
  assert.deepEqual(find([link(HREF, [0, 0, 400, 400])], [small, big]), hit('https://cdn.test/big.jpg'));
});

test('a tie goes to the first image in document order', () => {
  const first = img('https://cdn.test/first.jpg', [0, 0, 200, 200]);
  const second = img('https://cdn.test/second.jpg', [0, 0, 200, 200]);
  assert.deepEqual(find([link(HREF, [0, 0, 200, 200])], [first, second]), hit('https://cdn.test/first.jpg'));
  assert.deepEqual(find([link(HREF, [0, 0, 200, 200])], [second, first]), hit('https://cdn.test/second.jpg'));
});

test('two anchors with the same address over two different images are ambiguous', () => {
  const first = img('https://cdn.test/first.jpg', [0, 0, 200, 200]);
  const second = img('https://cdn.test/second.jpg', [300, 0, 500, 200]);
  const anchors = [link(HREF, [300, 0, 500, 200]), link(HREF, [0, 0, 200, 200])];
  assert.deepEqual(find(anchors, [first, second]), MANY);
});

test('cards that all link to "#" give many, the biggest image under any of them is not picked silently', () => {
  const small = img('https://cdn.test/small.jpg', [0, 0, 100, 100]);
  const big = img('https://cdn.test/big.jpg', [200, 0, 500, 300]);
  const anchors = [link('https://site.test/#', [0, 0, 100, 100]), link('https://site.test/#', [200, 0, 500, 300])];
  assert.deepEqual(find(anchors, [small, big], 'https://site.test/#'), MANY);
});

test('two anchors with the same address that lead to the same image are not ambiguous', () => {
  const photo = img(PHOTO, [100, 100, 500, 400]);
  const anchors = [link(HREF, [100, 100, 500, 400]), link(HREF, [100, 100, 500, 400], [photo])];
  assert.deepEqual(find(anchors, [photo]), hit(PHOTO));
});

test('Behance shape: an overlay link plus a separate title link with the same address still finds the image', () => {
  const photo = img(PHOTO, [100, 100, 500, 400]);
  const overlay = link(HREF, [100, 100, 500, 400]);
  const title = link(HREF, [100, 410, 260, 430]); // a text link under the picture: no image under it
  assert.deepEqual(find([overlay, title], [photo]), hit(PHOTO));
  assert.deepEqual(find([title, overlay], [photo]), hit(PHOTO));
});

test('one anchor with two images gives the bigger one, not many', () => {
  const small = img('https://cdn.test/small.jpg', [10, 10, 110, 110]);
  const big = img('https://cdn.test/big.jpg', [120, 10, 420, 310]);
  assert.deepEqual(find([link(HREF, [0, 0, 500, 400], [small, big])], [small, big]), hit('https://cdn.test/big.jpg'));
  // and the same through the sibling-overlay path
  assert.deepEqual(find([link(HREF, [0, 0, 500, 400])], [small, big]), hit('https://cdn.test/big.jpg'));
});

test('an anchor whose own box is empty still counts as shown when an image inside it is on screen', () => {
  // display: contents or an inline anchor around a block child reports a zero rect
  const near = img('https://cdn.test/near.jpg', [0, 0, 200, 200]);
  const far = img('https://cdn.test/far.jpg', [0, 2000, 800, 2800]);
  const flat = link(HREF, [0, 0, 0, 0], [near]);
  const stray = link(HREF, [0, 2000, 800, 2800], [far]);
  assert.deepEqual(find([stray, flat], [far, near]), hit('https://cdn.test/near.jpg'));
  // an empty anchor with nothing on screen inside it is not shown, so the off-screen copy gives way to the visible one
  const nothing = link(HREF, [0, 0, 0, 0], [far]);
  assert.deepEqual(find([nothing, flat], [far, near]), hit('https://cdn.test/near.jpg'));
});

test('tiny images and non-http addresses are skipped', () => {
  const box = [0, 0, 400, 300];
  assert.deepEqual(find([link(HREF, box)], [img(PHOTO, [0, 0, 1, 1])]), NONE); // tracking pixel
  assert.deepEqual(find([link(HREF, box)], [img(PHOTO, [0, 0, 31, 400])]), NONE); // too narrow
  assert.deepEqual(find([link(HREF, box)], [img(PHOTO, [0, 0, 400, 31])]), NONE); // too short
  assert.deepEqual(find([link(HREF, box)], [img(PHOTO, [0, 0, 32, 32])]), hit(PHOTO)); // exactly 32 passes
  assert.deepEqual(find([link(HREF, box)], [img('data:image/gif;base64,R0lGOD', box)]), NONE);
  assert.deepEqual(find([link(HREF, box)], [img('blob:https://site.test/1', box)]), NONE);
  assert.deepEqual(find([link(HREF, box)], [img('', box)]), NONE);
});

test('a skipped bigger image does not hide a usable smaller one', () => {
  const box = [0, 0, 400, 300];
  const data = img('data:image/png;base64,AAAA', box);
  const real = img(PHOTO, [0, 0, 100, 100]);
  assert.deepEqual(find([link(HREF, box)], [data, real]), hit(PHOTO));
});

test('currentSrc wins over src, src is the fallback, http is accepted', () => {
  const box = [0, 0, 400, 300];
  const both = { ...img('https://cdn.test/src.jpg', box), currentSrc: 'https://cdn.test/current.jpg' };
  assert.deepEqual(find([link(HREF, box)], [both]), hit('https://cdn.test/current.jpg'));
  const bare = { ...img('http://cdn.test/plain.jpg', box), currentSrc: '' };
  assert.deepEqual(find([link(HREF, box)], [bare]), hit('http://cdn.test/plain.jpg'));
});

test('an off-screen duplicate of the link is dropped when an on-screen one exists', () => {
  const near = img('https://cdn.test/near.jpg', [0, 0, 200, 200]);
  const farBig = img('https://cdn.test/far.jpg', [0, 2000, 800, 2800]);
  const anchors = [link(HREF, [0, 2000, 800, 2800]), link(HREF, [0, 0, 200, 200])];
  assert.deepEqual(find(anchors, [farBig, near]), hit('https://cdn.test/near.jpg'));
});

test('with no on-screen copy of the link, off-screen ones stay in play', () => {
  const far = img('https://cdn.test/far.jpg', [0, 2000, 800, 2800]);
  assert.deepEqual(find([link(HREF, [0, 2000, 800, 2800])], [far]), hit('https://cdn.test/far.jpg'));
});

test('a link that only touches the viewport edge is not on-screen', () => {
  const edge = link(HREF, [0, 800, 400, 1000]); // starts exactly at the bottom edge: zero visible area
  const edgeImg = img('https://cdn.test/edge.jpg', [0, 800, 400, 1000]);
  const near = img('https://cdn.test/near.jpg', [0, 0, 200, 200]);
  assert.deepEqual(find([edge, link(HREF, [0, 0, 200, 200])], [edgeImg, near]), hit('https://cdn.test/near.jpg'));
});

test('findImageUnderLink is self-contained: its source runs standalone with the same answers', () => {
  const standalone = new Function(`return (${findImageUnderLink.toString()})`)();
  assert.notEqual(standalone, findImageUnderLink);
  const photo = img(PHOTO, [100, 100, 500, 400]);
  const other = img('https://cdn.test/other.jpg', [600, 100, 900, 400]);
  const cases = [
    [HREF, page([link(HREF, [100, 100, 500, 400])], [photo])],
    ['https://site.test/none', page([link(HREF, [100, 100, 500, 400])], [photo])],
    [HREF, page([link(HREF, [100, 100, 500, 400], [photo])], [photo])],
    [HREF, page([link(HREF, [100, 100, 500, 400]), link(HREF, [600, 100, 900, 400])], [photo, other])],
  ];
  const answers = cases.map(([href, dom]) => findImageUnderLink(href, dom, win));
  assert.deepEqual(answers, [hit(PHOTO), NONE, hit(PHOTO), MANY]);
  assert.deepEqual(cases.map(([href, dom]) => standalone(href, dom, win)), answers);
});

// findImageAtPoint: a tree of fake elements. Parents are linked and querySelectorAll('img') lists the images below, in document order.
function el(localName, children = [], props = {}) {
  const node = { localName, parentElement: null, children, ...props };
  const below = (n) => n.children.flatMap((c) => [c, ...below(c)]);
  node.querySelectorAll = (sel) => (sel === 'img' ? below(node).filter((n) => n.localName === 'img') : []);
  children.forEach((c) => { c.parentElement = node; });
  return node;
}
const pic = (url, box, extra = {}) => el('img', [], { currentSrc: url, src: url, getBoundingClientRect: () => rect(box), ...extra });
// The Behance grid module: the image sits in a <picture>, an empty <span> lies over it as the topmost sibling.
const gridModule = (photo) => {
  const span = el('span');
  return { span, container: el('div', [el('picture', [photo]), span]) };
};
// `depth` empty wrappers around `target`; returns the outermost one.
const wrapped = (target, depth) => { let node = target; for (let i = 0; i < depth; i += 1) node = el('div', [node]); return node; };
const BOX = [100, 100, 500, 400];

test('Behance grid module: the span over a pointer-events:none image finds the image one level up', () => {
  const photo = pic(PHOTO, BOX);
  const { span } = gridModule(photo);
  assert.deepEqual(findImageAtPoint(span, 300, 250), hit(PHOTO));
});

test('a click that lands on the image element itself finds it at level 0', () => {
  const photo = pic(PHOTO, BOX);
  assert.deepEqual(findImageAtPoint(photo, 300, 250), hit(PHOTO));
});

test('a point outside the image rectangle gives none, the edges count as inside', () => {
  const { span } = gridModule(pic(PHOTO, BOX));
  assert.deepEqual(findImageAtPoint(span, 99, 250), NONE);
  assert.deepEqual(findImageAtPoint(span, 501, 250), NONE);
  assert.deepEqual(findImageAtPoint(span, 300, 99), NONE);
  assert.deepEqual(findImageAtPoint(span, 300, 401), NONE);
  assert.deepEqual(findImageAtPoint(span, 100, 100), hit(PHOTO));
  assert.deepEqual(findImageAtPoint(span, 500, 400), hit(PHOTO));
});

test('two different images that both contain the point on the same level are many', () => {
  const first = pic('https://cdn.test/first.jpg', [0, 0, 400, 400]);
  const second = pic('https://cdn.test/second.jpg', [200, 0, 600, 400]);
  const span = el('span');
  el('div', [first, second, span]);
  assert.deepEqual(findImageAtPoint(span, 300, 200), MANY);
  assert.deepEqual(findImageAtPoint(span, 100, 200), hit('https://cdn.test/first.jpg')); // only the first one is under this point
});

test('the same address twice under the point is one image', () => {
  const copyA = pic(PHOTO, BOX);
  const copyB = pic(PHOTO, [150, 120, 480, 390]);
  const span = el('span');
  el('div', [el('picture', [copyA]), el('picture', [copyB]), span]);
  assert.deepEqual(findImageAtPoint(span, 300, 250), hit(PHOTO));
});

test('tiny images and non-http addresses under the point are skipped', () => {
  const at = (image) => findImageAtPoint(gridModule(image).span, 20, 20);
  assert.deepEqual(at(pic(PHOTO, [0, 0, 31, 400])), NONE);
  assert.deepEqual(at(pic(PHOTO, [0, 0, 400, 31])), NONE);
  assert.deepEqual(at(pic(PHOTO, [0, 0, 32, 32])), hit(PHOTO)); // exactly 32 passes
  assert.deepEqual(at(pic('data:image/gif;base64,R0lGOD', [0, 0, 400, 300])), NONE);
  assert.deepEqual(at(pic('blob:https://site.test/1', [0, 0, 400, 300])), NONE);
  assert.deepEqual(at(pic('', [0, 0, 400, 300])), NONE);
});

test('currentSrc wins over src, src is the fallback', () => {
  const both = pic('https://cdn.test/src.jpg', BOX, { currentSrc: 'https://cdn.test/current.jpg' });
  assert.deepEqual(findImageAtPoint(gridModule(both).span, 300, 250), hit('https://cdn.test/current.jpg'));
  const bare = pic('http://cdn.test/plain.jpg', BOX, { currentSrc: '' });
  assert.deepEqual(findImageAtPoint(gridModule(bare).span, 300, 250), hit('http://cdn.test/plain.jpg'));
});

test('the nearest level that has an image under the point wins over a higher one', () => {
  const near = pic('https://cdn.test/near.jpg', BOX);
  const far = pic('https://cdn.test/far.jpg', [0, 0, 1000, 800]); // also under the point, but only reachable from the grandparent
  const { span, container } = gridModule(near);
  el('section', [container, el('div', [far])]);
  assert.deepEqual(findImageAtPoint(span, 300, 250), hit('https://cdn.test/near.jpg'));
});

test('a level whose only images are skipped does not decide: the walk goes on upwards', () => {
  const tiny = pic('https://cdn.test/tiny.jpg', [290, 240, 300, 250]);
  const good = pic('https://cdn.test/good.jpg', BOX);
  const span = el('span');
  const inner = el('div', [tiny, span]);
  el('div', [inner, good]);
  assert.deepEqual(findImageAtPoint(span, 295, 245), hit('https://cdn.test/good.jpg'));
});

test('the walk stops after six levels: the target is level 0, the sixth ancestor is out of reach', () => {
  const photo = pic(PHOTO, BOX);
  const span = el('span');
  // level 5 is the last one looked at: the image sits next to the wrapper that is five parents above the span
  const reachable = wrapped(span, 4); // span (0) < 4 wrappers: the outermost wrapper is level 4
  el('div', [reachable, photo]);      // its parent is level 5
  assert.deepEqual(findImageAtPoint(span, 300, 250), hit(PHOTO));
  const lone = el('span');
  const unreachable = wrapped(lone, 5); // outermost wrapper is level 5
  el('div', [unreachable, pic(PHOTO, BOX)]); // its parent is level 6
  assert.deepEqual(findImageAtPoint(lone, 300, 250), NONE);
});

test('a missing target gives none', () => {
  assert.deepEqual(findImageAtPoint(null, 300, 250), NONE);
  assert.deepEqual(findImageAtPoint(undefined, 300, 250), NONE);
});

test('missing or garbage coordinates never match an image', () => {
  const { span } = gridModule(pic(PHOTO, BOX));
  assert.deepEqual(findImageAtPoint(span, undefined, undefined), NONE);
  assert.deepEqual(findImageAtPoint(span, NaN, 250), NONE);
});

test('findImageAtPoint is self-contained: its source runs standalone with the same answers', () => {
  const standalone = new Function(`return (${findImageAtPoint.toString()})`)();
  assert.notEqual(standalone, findImageAtPoint);
  const first = pic('https://cdn.test/first.jpg', [0, 0, 400, 400]);
  const second = pic('https://cdn.test/second.jpg', [200, 0, 600, 400]);
  const crowd = el('span');
  el('div', [first, second, crowd]);
  const grid = gridModule(pic(PHOTO, BOX)).span;
  const cases = [[grid, 300, 250], [grid, 700, 250], [crowd, 300, 200], [null, 1, 1]];
  const answers = cases.map((c) => findImageAtPoint(...c));
  assert.deepEqual(answers, [hit(PHOTO), NONE, MANY, NONE]);
  assert.deepEqual(cases.map((c) => standalone(...c)), answers);
});

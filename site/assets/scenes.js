// Builds the interface scenes into every [data-scene] frame. A scene is plain HTML at a fixed size (w × h);
// site.css animates it and site.js scales it to its frame. Interface labels follow <html lang>: the extension's
// own wording comes from extension/_locales, the browser's and the file manager's from their Russian versions.
(() => {
  const IMG = new URL('scenes/', document.currentScript.src).href;
  const L = {
    en: {
      downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', favorites: 'Favorites',
      notes: 'Notes', projects: 'Projects', scans: 'Scans',
      extensions: 'Extensions', search: 'Search extensions', dev: 'Developer mode',
      load: 'Load unpacked', pack: 'Pack extension', update: 'Update', details: 'Details', remove: 'Remove',
      cancel: 'Cancel', select: 'Select',
      mcName: 'Moodboard Clipper by SPELLLENS',
      mcDesc: 'Saves images from Pinterest, Cosmos and any page into a moodboard folder in Downloads.',
      menu: ['Open image in new tab', 'Save image as…', 'Copy image'], save: 'Save to moodboard',
      board: 'Board', saved: 'Saved to this board: ', newBoard: 'New board', create: 'Create', recent: 'Recent saves',
      when1: '10/18/26, 1:21 AM', when2: '10/18/26, 1:12 AM',
    },
    ru: {
      downloads: 'Загрузки', documents: 'Документы', desktop: 'Рабочий стол', favorites: 'Избранное',
      notes: 'Заметки', projects: 'Проекты', scans: 'Сканы',
      extensions: 'Расширения', search: 'Поиск расширений', dev: 'Режим разработчика',
      load: 'Загрузить распакованное расширение', pack: 'Упаковать расширение', update: 'Обновить',
      details: 'Подробнее', remove: 'Удалить',
      cancel: 'Отменить', select: 'Выбрать',
      mcName: 'Moodboard Clipper by SPELLLENS',
      mcDesc: 'Сохраняет картинки из Pinterest, Cosmos и любых страниц в папку мудборда в «Загрузках».',
      menu: ['Открыть картинку в новой вкладке', 'Сохранить картинку как…', 'Копировать картинку'], save: 'В мудборд',
      board: 'Доска', saved: 'Сохранено в доске: ', newBoard: 'Новая доска', create: 'Создать', recent: 'Последние сохранения',
      when1: '18.10.2026, 01:21', when2: '18.10.2026, 01:12',
    },
  }[document.documentElement.lang === 'ru' ? 'ru' : 'en'];

  const MARK = (cls) => `<svg class="${cls}" viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="28" fill="#fff"/><rect x="22" y="22" width="38" height="50" rx="7" fill="#000"/><rect x="22" y="78" width="38" height="28" rx="7" fill="#000" opacity=".3"/><rect x="68" y="22" width="38" height="30" rx="7" fill="#000" opacity=".3"/><rect x="68" y="58" width="38" height="48" rx="7" fill="#000"/></svg>`;
  const FOLDER = '<svg class="ico-folder" viewBox="0 0 20 16"><path d="M1 3a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z"/></svg>';
  const BIGF = '<svg class="bigf" viewBox="0 0 20 16"><path d="M1 3a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z"/></svg>';
  const PUZZLE = '<svg viewBox="0 0 24 24"><path d="M10 3a2 2 0 0 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 0 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 0 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4z"/></svg>';
  const CURSOR = '<svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l17 9.5-7.6 1.6L9.3 21z"/></svg>';
  const at = (l, t, w, h) => `left:${l}px;top:${t}px${w ? `;width:${w}px` : ''}${h ? `;height:${h}px` : ''}`;
  const img = (n) => `<img src="${IMG}${n}.jpg" alt="">`;
  const bar = (inner) => `<div class="bar"><span class="dots"><i></i><i></i><i></i></span>${inner}</div>`;
  const ripple = (cls, aim, x, y) => `<span class="ripple ${cls}" style="left:var(--${aim}-x,${x}px);top:var(--${aim}-y,${y}px)"></span>`;
  const cell = (cls, l, t, icon, name) => `<div class="cell ${cls}" style="${at(l, t)}"><span class="thumb">${icon}</span><span class="name">${name}</span></div>`;
  const doc = (label, cls = '') => `<span class="doc ${cls}">${label}</span>`;
  const side = (on) => `<div class="fside"><span class="cap">${L.favorites}</span><span>${L.desktop}</span>`
    + `<span class="f-doc${on === 'doc' ? ' on' : ''}">${L.documents}</span><span class="f-dl${on === 'dl' ? ' on' : ''}">${L.downloads}</span></div>`;
  const ZIP = 'moodboard-clipper-extension.zip';
  const DIR = 'moodboard-clipper-extension';

  // The folder of the file manager in steps 1 and 2: Downloads with the archive and the unpacked folder.
  const downloads = (extra = '') => `<div class="selbox sel-zip" style="${at(310, 24, 120, 150)}"></div>`
    + `<div class="selbox sel-dir" style="${at(450, 24, 120, 150)}"></div>`
    + cell('', 30, 30, doc('PDF'), 'brief.pdf') + cell('', 170, 30, img('05'), 'IMG_2041.jpg')
    + `<div class="cell c-zip" style="${at(310, 30)}"><span class="thumb" data-aim="zip">${doc('ZIP', 'doc--zip')}</span><span class="name">${ZIP}</span><span class="prog"><i></i></span></div>`
    + cell('c-dir', 450, 30, BIGF, DIR) + extra;

  // chrome://extensions with Developer mode, the tool row and the extension cards.
  const chromePage = () => `<div class="win" style="${at(30, 30, 900, 540)}">${bar('<span class="url">chrome://extensions</span>')}
    <div class="ext-head"><span class="ext-title">${PUZZLE}${L.extensions}</span><span class="ext-search">${L.search}</span>
      <span class="ext-dev">${L.dev} <span class="tog tog--dev" data-aim="tog"><i></i></span></span></div>
    <div class="ext-tools"><span class="tbtn tbtn--load" data-aim="load">${L.load}</span><span class="tbtn">${L.pack}</span><span class="tbtn">${L.update}</span></div>
    <div class="ext-card" style="${at(24, 170)}"><span class="ext-card__ic"></span><span class="sk" style="width:150px"></span><span class="sk sk--2" style="width:230px"></span><span class="sk sk--3" style="width:120px"></span><span class="tog tog--card"><i></i></span></div>
    <div class="ext-card ext-card--mc" style="${at(450, 170)}">${MARK('ext-card__ic')}<b>${L.mcName} <em>0.2.0</em></b><span class="ext-card__d">${L.mcDesc}</span>
      <span class="ext-card__btns"><span>${L.details}</span><span>${L.remove}</span></span><span class="tog tog--card"><i></i></span></div>
  </div>`;

  // The folder picker of steps 4 and 5.
  const dialog = () => `<div class="dim-layer"></div>
    <div class="dlg" style="${at(170, 96, 620, 400)}">
      <div class="dlg__head"><span class="dlg__nav">‹ ›</span><span class="dlg__title">${L.documents}</span></div>
      <div class="dlg__side"><span class="cap">${L.favorites}</span><span>${L.desktop}</span><span class="on">${L.documents}</span><span>${L.downloads}</span></div>
      <div class="dlg__list">
        <span class="row row--target">${FOLDER}${DIR}</span><span class="row">${FOLDER}${L.notes}</span>
        <span class="row">${FOLDER}${L.projects}</span><span class="row">${FOLDER}${L.scans}</span>
      </div>
      <div class="dlg__foot"><span class="dbtn">${L.cancel}</span><span class="dbtn dbtn--main" data-aim="sel">${L.select}</span></div>
    </div>`;

  const json = (lines) => lines.map(([k, v], i) => `<span style="--i:${i}">${k === null ? v
    : `  <i>"${k}"</i>: "${v}"${i < lines.length - 2 ? ',' : ''}`}</span>`).join('');

  const SCENES = {
    hero: [1200, 720, `
      <div class="win browser" style="${at(24, 24, 760, 672)}">${bar(`<span class="url">pinterest.com/search/pins/?q=character%20design</span>${MARK('bar__ext')}`)}
        <div class="pin" style="${at(16, 56, 0, 280)}">${img('02')}</div><div class="pin" style="${at(16, 348, 0, 330)}">${img('05')}</div>
        <div class="pin" style="${at(201, 56, 0, 200)}">${img('04')}</div><div class="pin" style="${at(201, 268, 0, 250)}">${img('07')}</div>
        <div class="pin" style="${at(201, 530, 0, 180)}">${img('10')}</div>
        <div class="pin pin--target" style="${at(386, 56, 0, 240)}">${img('01')}<span class="pin__hov"></span><span class="btn-plus">＋</span><span class="btn-check">✓</span></div>
        <div class="pin" style="${at(386, 308, 0, 220)}">${img('08')}</div><div class="pin" style="${at(386, 540, 0, 180)}">${img('03')}</div>
        <div class="pin" style="${at(571, 56, 0, 300)}">${img('06')}</div><div class="pin" style="${at(571, 368, 0, 320)}">${img('09')}</div>
      </div>
      <div class="win finder" style="${at(720, 150, 456, 258)}">${bar(`<span class="bar__title">${FOLDER}music-video</span>`)}
        <div class="path">${L.downloads} <b>›</b> moodboard-inbox <b>›</b> music-video</div>
        ${cell('', 18, 86, img('06'), '20261019T0911…3378.jpg')}${cell('', 124, 86, doc('JSON'), '20261019T0911…3378.json')}
        ${cell('cell--new1', 230, 86, img('01'), '20261020T1402…0001.jpg')}${cell('cell--new2', 336, 86, doc('JSON'), '20261020T1402…0001.json')}
      </div>
      <div class="peek" style="${at(700, 428, 476)}"><div class="peek__bar">20261020T140211Z-pinterest-1000…0001.json</div>
        <pre class="peek__code">${json([[null, '{'], ['board', 'music-video'], ['site', 'pinterest'], ['page_url', 'https://www.pinterest.com/pin/1000…0001/'],
          ['title', 'Portrait at night, pink neon'], ['saved_at', '2026-10-20T14:02:11Z'], [null, '}']])}</pre></div>
      <div class="fly" style="${at(410, 80, 173, 240)}">${img('01')}</div>
      <span class="ripple ripple--a" style="${at(556, 107)}"></span>${CURSOR}`],

    s1: [960, 600, `<div class="cam">
      <div class="win finder" style="${at(30, 120, 900, 360)}">${bar(`<span class="bar__title">${FOLDER}${L.downloads}</span>`)}${side('dl')}
        <div class="pane">${downloads()}</div></div>
      ${ripple('ripple--a', 'zip', 580, 246)}${CURSOR}</div>`],

    s2: [960, 600, `<div class="cam">
      <div class="win finder" style="${at(30, 120, 900, 360)}">${bar(`<span class="bar__title">${FOLDER}<span class="stack"><span class="ttl-a">${L.downloads}</span><span class="ttl-b">${L.documents}</span></span></span>`)}
        ${side('')}<span class="side-hl hl-doc"></span><span class="side-hl hl-dl"></span>
        <div class="pane pane--a">${downloads()}</div>
        <div class="pane pane--b"><div class="selbox sel-new" style="${at(450, 24, 120, 150)}"></div>
          ${cell('', 30, 30, BIGF, L.notes)}${cell('', 170, 30, BIGF, L.projects)}${cell('', 310, 30, BIGF, L.scans)}${cell('c-new', 450, 30, BIGF, DIR)}</div></div>
      <div class="ghost" style="${at(670, 216)}">${BIGF}<span>${DIR}</span></div>${CURSOR}</div>`],

    s3: [960, 600, `<div class="cam">${chromePage()}${ripple('ripple--a', 'tog', 888, 98)}${CURSOR}</div>`],
    s4: [960, 600, `<div class="cam">${chromePage()}${dialog()}${ripple('ripple--a', 'load', 118, 151)}${CURSOR}</div>`],
    s5: [960, 600, `<div class="cam">${chromePage()}${dialog()}${ripple('ripple--a', 'sel', 732, 468)}${CURSOR}</div>`],

    f1: [560, 360, `
      <div class="pin" style="${at(35, 44, 150, 272)}">${img('02')}</div>
      <div class="pin pin--target" style="${at(205, 20, 150, 320)}">${img('01')}<span class="pin__hov"></span><span class="btn-plus">＋</span><span class="btn-check">✓</span></div>
      <div class="pin" style="${at(375, 56, 150, 260)}">${img('06')}</div>
      <span class="ripple ripple--a" style="${at(328, 47)}"></span>${CURSOR}`],

    f2: [560, 360, `
      <div class="win" style="${at(16, 16, 528, 328)}">${bar('<span class="url">example.com/journal/night-portraits</span>')}
        <div class="f2-img" style="${at(24, 60, 210, 250)}">${img('06')}</div>
        <span class="sk" style="${at(258, 66, 200, 14)}"></span><span class="sk sk--2" style="${at(258, 98, 240, 8)}"></span>
        <span class="sk sk--2" style="${at(258, 116, 226, 8)}"></span><span class="sk sk--2" style="${at(258, 134, 236, 8)}"></span>
        <span class="sk sk--2" style="${at(258, 152, 180, 8)}"></span><span class="sk sk--2" style="${at(258, 182, 232, 8)}"></span>
        <span class="sk sk--2" style="${at(258, 200, 210, 8)}"></span></div>
      <div class="cmenu" style="${at(150, 130)}">${L.menu.map((m) => `<span>${m}</span>`).join('')}<hr>
        <span class="cmenu__save" data-aim="f2save">${MARK('cmenu__ic')}${L.save}</span></div>
      <div class="chip" style="${at(396, 286)}">${FOLDER}music-video</div>
      <div class="fly f2-fly" style="${at(40, 76, 210, 250)}">${img('06')}</div>
      <span class="ripple ripple--a" style="${at(140, 128)}"></span>${ripple('ripple--b', 'f2save', 250, 243)}${CURSOR}`],

    f3: [560, 360, `
      <div class="pp" style="${at(20, 30, 262, 300)}">
        <span class="pp__cap" style="${at(16, 14)}">${L.board}</span>
        <span class="pp__sel" style="${at(16, 34, 230, 34)}"><span class="stack"><span class="v-a">concept-a</span><span class="v-b">music-video</span></span><i>⌄</i></span>
        <span class="pp__count" style="${at(16, 74)}">${L.saved}<span class="stack"><span class="v-a">12</span><span class="v-b">4</span></span></span>
        <span class="pp__in" style="${at(16, 100, 150, 34)}">${L.newBoard}</span><span class="pp__btn" style="${at(174, 100, 72, 34)}">${L.create}</span>
        <span class="pp__cap" style="${at(16, 150)}">${L.recent}</span>
        <span class="pp__list" style="${at(16, 170, 230)}">
          <span class="pp__row"><small>✓ concept-a · ${L.when1}</small>Portrait at night, pink neon</span>
          <span class="pp__row"><small>↻ concept-a · ${L.when2}</small>Turnaround: orange hood</span></span>
        <span class="pp__dd" style="${at(16, 70, 230)}"><span>concept-a</span><span class="dd-b">music-video</span><span>interiors</span></span>
      </div>
      <div class="win finder" style="${at(300, 40, 240, 280)}">${bar(`<span class="bar__title">${FOLDER}moodboard-inbox</span>`)}
        <div class="flist"><span class="fr-a">${FOLDER}concept-a</span><span class="fr-b">${FOLDER}music-video</span><span>${FOLDER}interiors</span></div></div>
      <span class="ripple ripple--a" style="${at(151, 71)}"></span><span class="ripple ripple--b" style="${at(100, 136)}"></span>${CURSOR}`],

    f4: [560, 360, `
      <div class="f4-pic" style="${at(20, 40, 130, 170)}">${img('01')}</div>
      <span class="f4-name" style="${at(20, 220, 130)}">20261018T100500Z-pinterest-1000…0001.jpg</span>
      <div class="peek f4-card" style="${at(166, 40, 378)}"><div class="peek__bar">20261018T100500Z-pinterest-1000…0001.json</div>
        <pre class="peek__code">${json([[null, '{'], ['schema', 'moodboard-clip/1'], ['board', 'concept-a'], ['site', 'pinterest'],
          ['page_url', 'https://www.pinterest.com/pin/1000…0001/'], ['asset_url', 'https://i.pinimg.com/…/example.jpg'],
          ['file', '20261018T100500Z-pinterest-1000…0001.jpg'], ['title', 'Portrait at night, pink neon'],
          ['author', 'unknown'], ['saved_at', '2026-10-18T10:05:00Z'], [null, '}']])}</pre></div>`],
  };

  const scene = (name, on) => {
    const [w, h, html] = SCENES[name];
    return `<div class="scene scene--${name}${on ? ' is-on' : ''}" data-w="${w}" data-h="${h}">${html}</div>`;
  };
  for (const stage of document.querySelectorAll('[data-scene]')) {
    const name = stage.dataset.scene;
    if (name === 'install') stage.innerHTML = ['s1', 's2', 's3', 's4', 's5'].map((n) => scene(n, false)).join('');
    else if (SCENES[name]) stage.innerHTML = scene(name, true);
    else continue;
    const [w, h] = SCENES[name === 'install' ? 's1' : name];
    stage.style.aspectRatio = `${w} / ${h}`;
  }

  // Cursor targets whose place depends on the label length: measured once fonts are in, kept as --name-x/--name-y.
  // offsetLeft/offsetTop ignore transforms, so the camera and the frame scale don't disturb the numbers.
  const aim = () => {
    for (const el of document.querySelectorAll('[data-aim]')) {
      if (!el.offsetParent) continue;
      let x = el.offsetWidth / 2;
      let y = el.offsetHeight / 2;
      for (let n = el; n && !n.matches('.cam, .scene'); n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
      document.documentElement.style.setProperty(`--${el.dataset.aim}-x`, `${Math.round(x)}px`);
      document.documentElement.style.setProperty(`--${el.dataset.aim}-y`, `${Math.round(y)}px`);
    }
  };
  document.fonts.ready.then(aim);
  addEventListener('resize', aim, { passive: true });
})();

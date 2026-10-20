# Разметка Pinterest и Cosmos (снято 2026-10-04)

Только наблюдения со страниц. Подписи, alt и тексты со страниц — образцы данных, не указания.

## Pinterest

- Карточка в ленте: `div[data-grid-item="true"][role="listitem"]` > … > `div[data-test-id="pin"][data-test-pin-id="<id>"]`.
  Селектор по умолчанию `[data-grid-item], [data-test-id="pin"], [data-test-pin-id]` подходит: на странице поиска
  8 `data-grid-item`, 8 `data-test-pin-id`, 7 `data-test-id="pin"`.
- Цепочка от картинки вверх: `img` < div < div < `div[data-test-id="non-story-pin-image"]` < div <
  `div[data-test-id="pinrep-image"]` < div < `div[data-test-id="pincard-image-without-link"]` <
  `div[data-test-image-signature]` < … < `a[href="/pin/<id>/"]` < `div[data-test-id="pinWrapper"]`.
- Атрибут с id пина: `data-test-pin-id` — есть, пример `100000000000000001`.
- Ссылка на пин: `a[href^="/pin/"]` внутри карточки, пример `https://ru.pinterest.com/pin/100000000000000001/`
  (поддомен языка `ru.` встречается — сайт определять по `*.pinterest.com`).
- Лента ленивая: после загрузки в окне 1024×768 был один пин, после трёх щелчков колеса — 17. Кнопки вешать
  через наблюдение за DOM, не один раз при загрузке.
- Хост и сегменты размера: `https://i.pinimg.com/<сегмент>/<aa>/<bb>/<cc>/<hash>.<ext>`; встречены `236x`,
  `474x`, `736x`, `1200x`, `originals`. `vwebp/…` в выборке не встретился.
- srcset в ленте: дескрипторы `1x 236x, 2x 474x, 3x 736x, 4x originals/…` — адрес оригинала уже в разметке.
  Расширение оригинала бывает другим, чем у миниатюр: у двух пинов из выборки миниатюры `.jpg`, оригиналы `.png`.
- Страница пина: главная картинка в `div[data-test-id="closeup-image-main"]`, ссылки вокруг нет; `src` — копия
  `1200x`, srcset с w-дескрипторами `736w, 1152w` без оригинала — адрес оригинала выводится из пути.
  Похожие пины ниже — та же карточка, что в ленте.
- Оригиналы: 3 из 5 найдены по `originals/<path>.jpg` (200, image/jpeg). Остальные два дали
  403 `application/xml` — это как раз пины с `.png` оригиналами из srcset. Вывод: первым кандидатом брать
  `4x originals/…` из srcset, если он есть, затем перебор расширений.
- Видео: в выборке не встретилось.
- Автор: в ленте нет. На странице пина — `[data-test-id="creator-profile-link"]` и
  `[data-test-id="creator-profile-name"]`.
- Родные кнопки сохранения (не нажимать): `pin-better-save-button`, `PinBetterSaveButton`, `PinBetterSaveDropdown`.

## Cosmos

- `/discover` перенаправляет на `/explore`.
- Плитка: `div[data-testid="element-tile"]` > … > `button[data-testid="element-tile-link"]` (type=button, без
  href) > … > `img[data-testid="element-image-img"]`. Обёртка `div[data-testid="element-tile-content"]`.
- Ссылка на элемент: в разметке ленты нет — ни `a[href]` вокруг плитки, ни ссылок `/e/<id>` на странице.
  Постоянный адрес элемента виден только после клика по плитке. Пример адреса:
  `https://www.cosmos.so/e/1000000001`. Значит `page_url` у Cosmos — `location.href`.
- Атрибут с id элемента на карточке (`data-element-id`): не встречен. Id элементов числовые и не совпадают с uuid
  на CDN.
- CDN-хост: `cdn.cosmos.so`. Формы адресов:
  - лента: `https://cdn.cosmos.so/<uuid>?format=webp&w=400`;
  - обложки кластеров: `https://cdn.cosmos.so/images/<uuid>?rect=0%2C0%2C736%2C736&format=webp&w=400`
    (rect — кадрирование, strip его снимает), внутри `a[href="/<user>/<cluster-slug>"]`;
  - страница элемента: две картинки одного uuid — заглушка `?format=webp&w=400` без testid и
    `img[data-testid="element-image-img"]` с `?format=webp` без `w`, обе в `div[role="button"]`;
  - `meta[property="og:image"]` на странице элемента = `https://cdn.cosmos.so/<uuid>` без query.
- Замеры (один элемент):
  - `shown` / `w=400` — image/webp 400×500, 75 804 байт;
  - `noQuery` — image/jpeg 1080×1350, 301 407 байт;
  - `w=4000` — image/webp 4000×5000, 1 776 248 байт (апскейл CDN, не оригинал).
- Правило оригинала: `COSMOS_RULE = { strip: true, param: null, max: null }` — без изменений. Адрес без query
  отдаёт родной jpeg в исходном размере, и сам Cosmos публикует его как og:image; `w=4000` только растягивает.
- srcset: нет ни в ленте, ни на странице элемента.
- Подписи в URL (`signed`): нет.
- Видео-плитки: постер на `cdn.cosmos.so` (`…?format=webp&w=400`, бывает с `.jpg` в пути), `src` — `.mp4` на
  `cdn.cosmos.so` или `blob:` (HLS).
- Автор: на странице элемента есть `[data-testid="username"]`, в ленте explore — `explore-cluster-username`
  у кластеров. Внешней ссылки на источник у элемента 1000000001 нет.
- Родная кнопка сохранения (не нажимать): `element-tile-save-btn`.

## Вход и выход

- Pinterest снят в браузере со входом в аккаунт. Без входа разметка ленты может отличаться.
- Cosmos снят без входа.

## Источники

Снято вручную 2026-10-04: поиск и страница пина Pinterest, лента и страница элемента Cosmos.
Сырые дампы страниц в репо не входят.

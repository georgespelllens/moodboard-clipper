# Saved files: `moodboard-clip/1`

Every save puts two files into `<root>/<board>/`. The root is `Downloads/moodboard-inbox` by default, or the folder you chose with **Own folder…** in the extension's window; below the root the layout is the same:

```
20261018T100500Z-pinterest-100000000000000001.jpg    the picture, as the site serves it
20261018T100500Z-pinterest-100000000000000001.json   its card
```

The card is written after the picture has finished downloading. A picture without a card means the save broke off half way; a card always has its picture next to it.

## Board names

A board name is the folder name. It is lowercased after Unicode NFC, every run of characters outside `a-z 0-9 а-я ё _ -` becomes one `-`, repeated dashes collapse into one, dashes at the ends are dropped, the result is cut to 40 characters and a dash left at the end by the cut is dropped. An empty result is `unsorted`, which is also the board when none is chosen.

## Ids

`<UTC time YYYYMMDDTHHMMSSZ>-<site>-<key>`, at most 80 characters; when it is longer, the key is cut.

| Site | Key |
|---|---|
| `pinterest` | the pin id from the page, if there is one |
| `cosmos` | the element id from the page, if there is one |
| any site | otherwise the first 10 hex digits of SHA-1 of the address the repeat check uses (below) |

Characters outside `A-Z a-z 0-9 -` in a key become `-`.

## The card

```json
{
  "schema": "moodboard-clip/1",
  "id": "20261018T100500Z-pinterest-100000000000000001",
  "board": "concept-a",
  "site": "pinterest",
  "saved_from": "feed-button",
  "page_url": "https://www.pinterest.com/pin/100000000000000001/",
  "page_url_kind": "pin",
  "asset_url": "https://i.pinimg.com/originals/00/11/22/example.jpg",
  "asset_fallback": null,
  "media": "image",
  "file": "20261018T100500Z-pinterest-100000000000000001.jpg",
  "title": "Concrete stair in morning light",
  "alt": null,
  "author": "unknown",
  "author_url": null,
  "saved_at": "2026-10-18T10:05:00Z"
}
```

| Field | Values |
|---|---|
| `schema` | always `moodboard-clip/1` |
| `id` | as above; the file names start with it |
| `board` | the board name, as above |
| `site` | `pinterest`, `cosmos` or `web` (any other page, Behance included) |
| `saved_from` | `feed-button` (the ＋ button) or `context-menu` |
| `page_url` | the pin or element page if the extension found one, otherwise the tab. For `web` the query and fragment are removed |
| `page_url_kind` | `pin`, `element` or `tab` |
| `asset_url` | the address the picture was downloaded from. For `web` the query and fragment are removed |
| `asset_fallback` | `null` when the original was saved; otherwise which copy: `originals.<ext>` (the original under another extension), `1200x`, `736x` (Pinterest sizes) or `shown` (the copy on the page) |
| `media` | `image` or `video-poster` (the still frame of a video pin) |
| `file` | the picture's file name as it is on disk. Chrome may replace the `.img` extension with the real one; the card names the file it ended up with |
| `title` | text, at most 500 characters, or `null` |
| `alt` | text, at most 500 characters, or `null`; always `null` for `web` |
| `author` | text, at most 200 characters, or `unknown` |
| `author_url` | an `http(s)` address or `null` |
| `saved_at` | UTC, ISO 8601, to the second |

Lengths are counted in Unicode code points. Control characters are removed from text fields.

## How the original is chosen

- **Pinterest:** the `originals` address from the picture's `srcset`, then the same path under `originals/` with the other common extensions, then the `1200x` and `736x` copies, then the copy on the page. The first address that answers wins.
- **Cosmos:** the CDN address without its query string, then the copy on the page.
- **Any other page:** the picture as the page shows it.

## Repeats

A picture already saved to the same board is not saved again: the ＋ button shows ✓ and the popup shows ↺. The check takes the board and the address the picture was downloaded from, without its query and fragment (for `web`, without the fragment only: there the query can tell two pictures apart). The extension remembers the last 5000 saves.

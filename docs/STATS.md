# Visit statistics on the landing

The landing at [spelllens.ru/moodboard-clipper](https://spelllens.ru/moodboard-clipper/) counts visits on our own server; no counter or script of anyone else is loaded and nothing is passed on. This is about the page only: the extension itself sends nothing anywhere ([PRIVACY.md](PRIVACY.md)).

## Script

The counting lives in `site/assets/stats.js`. The server address comes with the page on spelllens.ru, in `data-endpoint` on the script tag. Without it, as in a local preview or the file on disk, nothing is sent: events go to `window.__mcStats` and to the console as `[stats off]`, so they can be checked in a browser.

## What the page keeps in the browser

In `localStorage`: `sl_vid`, a random id of the browser; `sl_sid`, a random id of the visit; `sl_seen`, the time the page was last used. A visit ends after 30 minutes without the page in use. With storage off, every page view counts as a new visitor.

## What is sent

Every event carries the two ids above and a random id of the page view.

| Event | When | Fields |
|---|---|---|
| `view` | the page opens | address of the page without the query, page language, referrer, `utm_source` / `utm_medium` / `utm_campaign`, whether the browser id is new, time zone, the first three browser languages, screen and window size, whether the screen is touch, whether the browser is driven by automation |
| `click` | any click on the page | label of the clicked link or button (or `image`, `video` or the first words of the text), the part of the page, the link address, click position as fractions of the window width and the page height |
| `time` | the page goes out of view, and every 30 seconds while it is in view | seconds the page was in view and used in the last 30 seconds, the deepest scroll in percent, the same seconds split by part of the page |
| `goal` | see below | see below |

The server also sees the browser's `User-Agent`, from which it keeps the browser, system and device type, and the visitor's address, of which it keeps only a salted hash to limit the number of events from one address.

## Goals

| Name | When | Parameters |
|---|---|---|
| `download` | a click on a link to `moodboard-clipper-extension.zip` | `place`: where on the page the link is |
| `checksums` | a click on the link to `SHA256SUMS.txt` | `place` |
| `github` | a click on any other link to github.com | `place`, `path` |
| `lang_switch` | a click on the EN / RU switch | `to` |
| `nav` | a click on a link to a section of the page | `to`, `place` |
| `step_click` | a click on a step number in the install frame (wide screens) | `n` |
| `faq_open` | a question in the FAQ is opened | `q`: the question |
| `seen_install` | the install section reaches the middle of the screen | |
| `seen_features` | the same for the features | |
| `seen_privacy` | the same for privacy | |
| `seen_faq` | the same for the FAQ | |
| `seen_end` | the same for the last screen with the download button | |
| `step_1` … `step_5` | the visitor got to this install step; reaching a step counts the ones above it too | |

`place` is one of `header`, `hero`, `install`, `features`, `privacy`, `faq`, `final`, `footer`. The `seen_*` and `step_*` goals are sent once per page view.

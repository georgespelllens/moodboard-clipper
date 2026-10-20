# Privacy

Moodboard Clipper has no server and no account. The pictures you save and the list of boards stay on your computer; the only requests it makes are listed below.

## What the extension stores

- In `Downloads/moodboard-inbox/`, or in the folder you chose with **Own folder…**: the pictures you save and their cards ([FORMAT.md](FORMAT.md)). With an own folder the extension writes them into it directly.
- If you chose an own folder: the browser's handle to it, in the extension's own IndexedDB on your computer, and the folder's name in the extension storage. The handle gives no access by itself: after each browser start the browser asks for permission to write there again, and the extension asks for it when you click **Connect folder**. **Save to Downloads again** on the folder page removes both.
- In the browser's extension storage: the list of boards, the chosen board, a count of saves per board, the last 10 saves for the popup (board, title, result) and the addresses of the last 5000 saved pictures for the repeat check. Removing the extension removes this storage; the saved files stay.

## What the extension sends over the network

- The picture itself, downloaded by the browser from the site's image server, as when you open it in a tab. When you save into an own folder, the extension fetches the picture from that server itself, without cookies, and writes it into the folder.
- On Pinterest and Cosmos, before downloading, a few small requests (`HEAD`, or `GET` of the first byte) to the same image server (`i.pinimg.com`, `cdn.cosmos.so`) to find out which size of the picture exists. They go without cookies.

There is no analytics, no error reporting and no update check.

## Why each permission

| Permission | What for |
|---|---|
| `downloads` | Saving the picture and its card into `Downloads/moodboard-inbox/<board>/` (not used for the pictures you save into an own folder) |
| `downloads.ui` | Hiding the browser's download bubble while a save is running, so the page stays in view; it comes back when the save ends |
| `alarms` | Bringing the download bubble back after a minute if the browser put the extension to sleep in the middle of a save |
| `storage` | Boards, the last saves and the repeat check (above) |
| `contextMenus` | The "Save to moodboard" item in the right-click menu |
| `activeTab`, `scripting` | After a right click, finding the picture under a link laid over it. This runs only in the tab you clicked, only at that moment |
| `https://*.pinterest.com/*`, `https://*.cosmos.so/*` | The ＋ button over pictures in the feed and on the pin or element page |
| `https://i.pinimg.com/*`, `https://cdn.cosmos.so/*` | Finding the original size of the picture (the requests above) |
| `https://*.behance.net/*` | The "Save to moodboard" item in the page menu. Behance lays an empty layer over project pictures, so a small script on Behance pages notes which picture is under the cursor at each right click |
| `offscreen` | A hidden page of the extension that keeps the folder you chose open, so that saves can be written into it after the extension's window closes. It exists only while an own folder is chosen, shows nothing and loads no site |
| `https://*/*`, `http://*/*` (optional) | Not granted at install. The browser asks for it only if you click **Allow on all sites**, which appears in the recent saves after a picture from a site other than Pinterest, Cosmos and Behance could not be fetched into your own folder because that site does not give it to the extension. The extension uses it only to fetch the pictures you save, without cookies. Saving into Downloads never needs it |

## The pictures you save

Saving a picture does not give you the right to use it. Check the author's terms before you publish anything from your moodboard.

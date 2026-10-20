# Install

The same on Mac, Windows and Linux. You need Chrome or another Chromium browser, such as Comet, Yandex Browser, Brave, Edge, Arc, Vivaldi or Opera. We have opened the extensions page in Chrome, Comet and Yandex Browser; the others should work the same way.

1. Download [`moodboard-clipper-extension.zip`](https://github.com/georgespelllens/moodboard-clipper/releases/latest/download/moodboard-clipper-extension.zip) and unzip it: double-click it on a Mac; on Windows, right-click it and choose **Extract All**.
2. Move the `moodboard-clipper-extension` folder to where it will stay, for example Documents. The browser loads the extension from this folder every time it starts, so don't delete or rename it.
3. Open `chrome://extensions` (Yandex Browser: `browser://extensions`) and turn on **Developer mode**. Paste the address into the address bar: pages like this don't open from links.
4. Click **Load unpacked**.
5. Choose the `moodboard-clipper-extension` folder.

The Moodboard Clipper card appears. Pin the extension's icon to the toolbar to pick boards.

## Other browsers

The extensions page has its own address in each browser: `chrome://extensions` in Chrome, `browser://extensions` in Yandex Browser, `edge://extensions` in Edge, `brave://extensions` in Brave. In step 3, paste the address of your browser instead of `chrome://extensions`; the rest is the same.

## If the browser asks where to save

When **Ask where to save each file before downloading** is on in the browser's settings, the browser opens a save window on every click in the default mode (saving through the browser's downloads), and the extension cannot turn it off. If you cancel that window or save the picture outside the board folder, the save ends with ✗, and its tooltip and the list of last saves in the extension's window name the ways out:

- Save into your own folder, as described below: the extension then writes the files itself, and the setting no longer matters.
- Or turn the setting off: `chrome://settings/downloads` in Chrome.

## Saving into your own folder

By default the files go to `Downloads/moodboard-inbox/<board>/`. To save into a folder of your own instead:

1. Click the Moodboard Clipper icon. A line at the top of its window says where saves go; click **Own folder…**.
2. A tab opens. Click **Choose folder**, or drag a folder onto the page. Chrome does not let you pick the Downloads folder itself, so pick a folder inside it, for example `Downloads/moodboard-inbox`: the boards already there stay where they were.
3. Close the tab, open the extension's window again and click **Connect folder**.

Each board becomes a subfolder of the chosen folder, and the extension writes the picture and its `.json` card there itself. So **Ask where to save each file before downloading** no longer matters, and ordinary downloads keep asking as before. The card format does not change: [FORMAT.md](FORMAT.md).

After each browser start (and after you close the tab from step 2) the extension needs one click on **Connect folder** in its window. Until then its icon shows `!` and saves end with "folder is not connected".

A picture from a site other than Pinterest, Cosmos and Behance (right-click → Save to moodboard) may need access to that site. The save then ends with ✗, and its row in the recent saves offers **Allow on all sites**: an optional permission that the browser asks for only on that click ([PRIVACY.md](PRIVACY.md)).

To go back to Downloads, click **Change** in the extension's window and then **Save to Downloads again** on the page that opens.

It works in Chromium browsers that have File System Access. Connecting the folder with one click in the extension's window needs Chrome 143 or newer. If the page says the browser cannot save into a chosen folder, saves stay in Downloads.

## Linux

The zip has no folder inside, so unzip it into one:

```bash
unzip moodboard-clipper-extension.zip -d moodboard-clipper-extension
```

Then move that folder as in step 2.

## Checking the download

Put [`SHA256SUMS.txt`](https://github.com/georgespelllens/moodboard-clipper/releases/latest/download/SHA256SUMS.txt) from the same release next to the zip and run the command in that folder.

- Mac: `shasum -a 256 -c SHA256SUMS.txt`
- Linux: `sha256sum -c SHA256SUMS.txt`
- Windows: open PowerShell in the folder with the zip (in File Explorer, type `powershell` in the address bar and press Enter), run `(Get-FileHash moodboard-clipper-extension.zip).Hash.ToLower()` and compare the result with the zip's line in `SHA256SUMS.txt`.

## Updating

A new version is installed over the old one. Unzip the new archive and put its folder in place of the old one, with the same name in the same place (Finder and File Explorer will offer to replace it). Then click the reload arrow on the Moodboard Clipper card and reload open Pinterest, Cosmos and Behance tabs.

If you load the folder from another place, the browser installs the extension as a new one, without the list of boards, the chosen board, the save counts, the last saves and the repeat-check data; the pictures in `Downloads/moodboard-inbox` stay. The extension does not check for updates by itself: new versions appear on the [Releases](https://github.com/georgespelllens/moodboard-clipper/releases) page.

## Removing

Click **Remove** on the Moodboard Clipper card on the extensions page. Then delete the folder if you like. Saved pictures in `Downloads/moodboard-inbox` stay.

## Not in the Chrome Web Store yet

The extension is not in the Chrome Web Store yet, so the browser loads it in developer mode, from a folder you can open and read. Every line of it is in this repository.

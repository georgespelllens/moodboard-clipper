# Demo feed

`record.mjs` records the GIF shown in the README and on the site: the cursor clicks ＋ on a picture in a feed, and the picture and its card appear in the board folder. The extension runs for real in a headless Chrome for Testing. `serve.mjs` serves the feed under the real Pinterest hostnames inside that browser only, and `frames.mjs` draws the cursor and assembles the GIF.

The recorder needs macOS (`sips`, `openssl`), ffmpeg and Chrome for Testing 145 or later.

```bash
scripts/package-extension.sh
MBC_CHROME=<path to Chrome for Testing> node demo/record.mjs dist/extension dist/captures/demo
```

The pictures in `works/` are abstractions drawn by `draw-works.mjs`, and they are under the MIT license of this repository. To redraw them, run this from the repository root (the drawing needs ffmpeg and Chrome for Testing, and a second run gives the same files):

```bash
MBC_CHROME=<path to Chrome for Testing> node demo/draw-works.mjs
```

`works/works.json` lists the pictures in feed order as `[{ "file": "01.jpg", "title": "…" }]`. The feed shows the titles, and the first four pictures also go on the cover (`brand/cover.html`).

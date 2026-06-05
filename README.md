# Snapchat Video Text

A browser-based tool to add Snapchat-style caption bars to vertical videos. Upload a video, style your text, preview in real time, and export — all locally in the browser with no upload to any server.

## Features

- **Live preview** — canvas-based overlay updates instantly as you type or adjust settings
- **Text styling** — bold, italic, font size, bar position, opacity, and padding
- **Inter variable font** — loaded locally for accurate canvas rendering and FFmpeg export
- **Fast export** — powered by FFmpeg.wasm (multi-threaded) with H.264 encoding
- **Export modal** — circular progress indicator, download button, and cancel support

## Getting started

### Requirements

- Node.js 18+
- The Inter variable font files placed in `public/font/`:
  - `Inter-VariableFont_opsz,wght.ttf`
  - `Inter-Italic-VariableFont_opsz,wght.ttf`

### Install and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Build for production

```bash
npm run build
npm start
```

## How it works

1. **Preview** — a hidden `<video>` element feeds frames into a `<canvas>` via a `requestAnimationFrame` loop. The canvas draws the dark bar and text on top of each frame using the Canvas 2D API.

2. **Export** — FFmpeg.wasm processes the original video file entirely in the browser. The bar position and height computed by the canvas are passed as pixel values to FFmpeg's `drawbox` and `drawtext` filters. The Inter font is written into FFmpeg's virtual filesystem before processing.

3. **No server** — everything runs client-side. Videos never leave the browser.

## Notes

- The `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers required by FFmpeg.wasm (for `SharedArrayBuffer`) are set in `next.config.ts`.
- FFmpeg.wasm loads ~30MB on the first export. Subsequent exports in the same session reuse the loaded instance.
- Export quality uses H.264 at CRF 23 with the `fast` preset — a good balance of speed and file size.

# Vendored third-party code

This directory holds unmodified third-party libraries, committed directly
into the repo rather than loaded from a CDN — so the Viewer Link QR code
keeps working even if an event's venue network can't reach an external CDN,
and nothing here needs a `connect-src`/`script-src` CSP exception. Files in
here are excluded from this repo's own lint/format checks and from
Tailwind's class scanner (see `eslint.config.js`, `.prettierignore`,
`tailwind.config.js`) since they aren't this project's code.

## qrcode.js

- Source: [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator) v2.0.4 on npm
- File: `dist/qrcode.js` from the published package, byte-for-byte
- License: MIT (c) 2009 Kazuhiko Arase — see the file's own header
- Used by: `generateViewerLinkQr()` in `js/app.js`, loaded via a plain
  `<script>` tag in `index.html` (defines the `qrcode` global)

To update: `npm pack qrcode-generator@<version>`, extract, and replace this
file with the new `dist/qrcode.js` unmodified.

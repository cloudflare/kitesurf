# TTY CSS Preview

This package loads the terminal UA stylesheet into Chrome. It applies CSS changes without a page reload.

The server reads these files for each request:

- `packages/engine/src/tty/stylesheet.css`
- `packages/engine/src/tty/stylesheet-level2.css`

## Start The Server

Run this command from the repository root:

```bash
pnpm dev:tty-css
```

The server listens on `127.0.0.1:8765`. It does not accept remote connections.
It serves `/health` and `/tty.css?level=1|2` for `GET`, `HEAD`, and `OPTIONS`
requests with no-store and CORS headers.

## Load The Extension

1. Open `chrome://extensions` in an unmanaged Chrome profile.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `packages/tty-css-preview/extension`.
5. Open a web page.
6. Use the extension menu to select level 1 or level 2.
7. Select **Show cell grid** to show the terminal cell boundaries.

The content script polls again 500 ms after each response and applies CSS
changes when that poll completes. It runs on HTTP(S) pages in all frames,
including `about:blank` and origin-fallback frames.

If the server is offline, the extension uses its bundled stylesheet without
hot reload. The bundled copy must match the engine stylesheet; the package
tests enforce this.

While a preview level is active, the extension collects real wheel events for 33 ms. Horizontal movement uses whole terminal columns. Vertical movement uses whole terminal rows. The extension does not create synthetic wheel events.

The optional grid is a visual overlay. It does not change page layout or pointer input.

The preview rounds computed margins, padding, flex and grid gaps, and image, video, canvas, and SVG dimensions to the nearest cell. It snaps each border-plus-padding inset as one value, so a retained pixel border does not add another offset after padding is rounded. It restores original inline declarations when you turn off the preview. Kitesurf rounds general block dimensions during its layout pass because independent CSS sizes can cause overlaps.

For inset snapping, the extension reads computed values for the whole subtree
before it writes overrides. Otherwise snapping a parent can change the computed
values that later child reads use.

Elements keep top and bottom borders as horizontal terminal rules. Their left and right borders are removed because the terminal renderer does not draw sub-column vertical lines.

Chrome shows a broad site-access warning because the extension previews CSS on arbitrary sites. The extension only contacts the loopback server.

If you reload the extension, reload each test tab. Chrome does not restart old content scripts after an extension reload.

The extension's fallback stylesheets are checked against the engine's terminal
stylesheets. Keep their CSS values in sync, including each preview level, when
changing how cells are drawn; the preview scripts and server do not own the
engine's rendering rules.

The styles keep effects ANSI text can show (weight, style, decoration, alignment), replace
outlines and shadows with fills or text markers, and size spacing in `lh` rows and `ch` columns.

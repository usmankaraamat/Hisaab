# Visual harness

Renders a real view against a real export in headless Chrome, so a layout bug is
found by looking rather than by shipping. Two CSS collisions were caught this
way — a class name that matched the capture screen's Save button and stretched
an SVG bar across the chart, and `.card button` out-specifying every content
button inside a card.

```sh
npm run dev                     # port 5173 by default

chrome --headless --disable-gpu --hide-scrollbars \
  --window-size=400,1400 --screenshot=shot.png \
  --virtual-time-budget=9000 \
  "http://localhost:5173/tools/preview.html?view=add&fixture=preview-demo&pending=1"
```

| param | |
| --- | --- |
| `view` | `overview` (default), `add`, `spending`, `history`, `ledger` |
| `fixture` | a JSON file in this directory, without the extension |
| `pending` / `skip` | trim the inbox, so the one-waiting case (which opens itself) and the several-waiting case both come from one fixture |
| everything else | passed through to the view — `?m=2026-08&w=2` drills Overview |

Two fixtures: `preview-demo.json` is invented and committed, which is why it can
be; `preview-rows.json` is your own export and is gitignored. A fixture is either
a bare array of rows or `{ rows, pending, meta }`.

Headless Chrome pins its layout viewport regardless of `--window-size`, so the
harness constrains `#app` to 360px itself; that is the width the screenshot
shows. Add `--blink-settings=preferredColorScheme=1` for light mode.

`src/db/local.js` reads `window.__rows` / `window.__pending` / `window.__meta`
when they are set, behind `import.meta.env.DEV` — headless Chrome starves
IndexedDB under virtual time. The branch is dropped from production builds.

That check is a function, not a const. As a const it was evaluated when the
module was imported, which is before the harness's own module body has run, so
it was always false and every preview rendered an empty screen.

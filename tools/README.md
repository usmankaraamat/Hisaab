# Visual harness

Renders a real view against a real export in headless Chrome, so a layout bug is
found by looking rather than by shipping. Two CSS collisions were caught this
way — a class name that matched the capture screen's Save button and stretched
an SVG bar across the chart, and `.card button` out-specifying every content
button inside a card.

```sh
npm run dev                     # port 5173 by default
# fixtures are real financial data and are gitignored:
#   tools/preview-rows.json  <- an array of transaction rows
node -e "…"                     # or export from Supabase / IndexedDB

chrome --headless --disable-gpu --hide-scrollbars \
  --window-size=400,1000 --screenshot=shot.png \
  --virtual-time-budget=8000 \
  "http://localhost:5173/tools/preview.html?m=2026-08"
```

Headless Chrome pins its layout viewport regardless of `--window-size`, so the
harness constrains `#app` to 360px itself; that is the width the screenshot
shows. Add `--blink-settings=preferredColorScheme=1` for light mode.

`src/db/local.js` reads `window.__rows` / `window.__meta` when they are set,
behind `import.meta.env.DEV` — headless Chrome starves IndexedDB under virtual
time. The branch is dropped from production builds.

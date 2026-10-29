// A phone's safe area in the built UI (T-170): the page reaches under a notch
// and the home indicator (viewport-fit=cover), and the app pads itself by the
// insets, so only its background is there. What that does on a screen with
// insets is checked in Chromium by tools/safe-area-check.mjs; this keeps the
// two parts in the build.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const css = (await Promise.all((await readdir(new URL("assets/", distUrl)))
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFile(new URL(`assets/${name}`, distUrl), "utf8")))).join("\n");

test("the page reaches the screen's edges, keeping its other viewport settings", () => {
  const viewport = index.match(/<meta\s+name="viewport"\s+content="([^"]*)"/)?.[1];
  assert.ok(viewport, "a viewport meta");
  const parts = viewport.split(",").map((part) => part.trim());
  assert.ok(parts.includes("viewport-fit=cover"), viewport);
  for (const kept of ["width=device-width", "initial-scale=1.0", "interactive-widget=resizes-content"])
    assert.ok(parts.includes(kept), `${kept} in ${viewport}`);
});

test("the app is padded by the safe-area insets, which are zero elsewhere", () => {
  for (const side of ["top", "right", "bottom", "left"])
    assert.match(css, new RegExp(`--safe-${side}:\\s*env\\(safe-area-inset-${side},\\s*0(px)?\\)`), side);
  // The rule for .app itself, not one for .app under another selector (the Portal's, T-5).
  const app = css.match(/(?:^|[{}])\.app\{[^}]*\}/)?.[0] ?? "";
  assert.match(app, /padding:\s*var\(--safe-top\)\s+var\(--safe-right\)\s+var\(--safe-bottom\)\s+var\(--safe-left\)/, app);
});

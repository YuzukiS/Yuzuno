// YN-44: the app's one tooltip is Tip (web/src/Tip.tsx), drawn as the Work
// dock's CI card and timed the same everywhere. A native `title=` on an
// element shows the browser's own tooltip instead: another look, another
// delay, nothing on keyboard focus. So no element in web/src has one.
//
// Kept: an <iframe>'s title, which names the frame for assistive technology
// and shows no tooltip of its own. Today three: a Home card's page
// (home/CardPage.tsx) and the Portal's snapshot and service frames
// (portal/Portal.tsx).
//
// A component's own `title` prop (a card's heading, a dialog's name) is not
// an element's attribute and is not looked at here.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const KEPT = new Set(["iframe"]);

async function sources(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sources(full));
    else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/** Every `title=` on a lowercase JSX element, as file:line <tag>. */
async function nativeTitles() {
  const found = [];
  for (const file of await sources(src)) {
    const text = await readFile(file, "utf8");
    if (!text.includes("title")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        if (/^[a-z]/.test(tag))
          for (const attribute of node.attributes.properties)
            if (ts.isJsxAttribute(attribute) && attribute.name.getText(sf) === "title") {
              const { line } = sf.getLineAndCharacterOfPosition(attribute.getStart(sf));
              found.push({ at: `${path.relative(src, file)}:${line + 1}`, tag });
            }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test("no element in web/src has a native title, but an iframe's; a tip says it (Tip)", async () => {
  const found = await nativeTitles();
  const native = found.filter((t) => !KEPT.has(t.tag)).map((t) => `${t.at} <${t.tag}>`);
  assert.deepEqual(native, [], `use Tip (web/src/Tip.tsx) instead of title= on:\n${native.join("\n")}`);
  // The kept ones are the frames, named for assistive technology.
  assert.ok(found.every((t) => KEPT.has(t.tag)));
  assert.ok(found.length > 0, "the scan found the iframes' titles, so it reads the source");
});

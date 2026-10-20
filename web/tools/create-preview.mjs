import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve(process.env.YUZUNO_UI_DIST || "dist");
const assets = resolve(dist, "assets");
const names = await readdir(assets);
const index = await readFile(resolve(dist, "index.html"), "utf8");
const entry = (extension) => {
  const name = index.match(new RegExp(`/assets/([^" ]+\\.${extension})`))?.[1];
  if (!name) throw new Error(`Missing ${extension} entry in index.html`);
  return resolve(assets, name);
};
let js = await readFile(
  entry("js"),
  "utf8",
);
let css = await readFile(
  entry("css"),
  "utf8",
);
for (const font of names.filter((n) => n.endsWith(".woff2"))) {
  const data = await readFile(resolve(assets, font));
  css = css.replaceAll(
    `/assets/${font}`,
    `data:font/woff2;base64,${data.toString("base64")}`,
  );
}
// Imported character art must also work in the standalone file:// specimen.
for (const name of names.filter((n) => n.endsWith(".png"))) {
  const data = await readFile(resolve(assets, name));
  js = js.replaceAll(`/assets/${name}`, `data:image/png;base64,${data.toString("base64")}`);
}
const html = `<!doctype html><html lang="en" data-visual-preview="true"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yuzuno · read-only design preview</title><style>${css}</style></head><body><div id="root"></div><script type="module">${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await writeFile(resolve(dist, "design-preview.html"), html);
console.log(
  `Created standalone, explicitly labelled design preview: ${dist}/design-preview.html`,
);

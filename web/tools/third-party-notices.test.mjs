// The bundles' third-party notices (T-90): which package a bundled file came
// from, and what the built UI ships.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bundledFiles, bundledPackages, noticesText, packageDir } from "./third-party-notices.mjs";

const dist = process.env.YUZUNO_UI_DIST
  ? resolve(process.env.YUZUNO_UI_DIST)
  : fileURLToPath(new URL("../dist/", import.meta.url));

test("a bundled file belongs to the deepest package above it; the project's own files to none", () => {
  assert.equal(packageDir("/w/node_modules/react/index.js"), "/w/node_modules/react");
  assert.equal(packageDir("/w/node_modules/@radix-ui/react-id/dist/index.mjs"), "/w/node_modules/@radix-ui/react-id");
  assert.equal(packageDir("/w/node_modules/a/node_modules/b/lib/x.js?commonjs-proxy"), "/w/node_modules/a/node_modules/b");
  assert.equal(packageDir("\0/w/node_modules/react/index.js?commonjs-exports"), "/w/node_modules/react");
  assert.equal(packageDir("/w/src/App.tsx"), null);
  assert.equal(packageDir("\0vite/preload-helper.js"), null);
});

test("only rendered modules and the sources of emitted assets count", () => {
  const files = bundledFiles({
    "index.js": { type: "chunk", modules: { "/w/node_modules/a/i.js": { renderedLength: 10 }, "/w/node_modules/b/i.js": { renderedLength: 0 } } },
    "font.woff2": { type: "asset", originalFileNames: ["node_modules/katex/dist/fonts/f.woff2"] },
    "licenses/LICENSE": { type: "asset" },
  }, "/w");
  assert.deepEqual(files, ["/w/node_modules/a/i.js", "/w/node_modules/katex/dist/fonts/f.woff2"]);
});

test("a package reached through a symlinked node_modules is listed once, with the texts it ships", async () => {
  const root = await mkdtemp(join(tmpdir(), "notices-"));
  try {
    const real = join(root, "web/node_modules/pkg");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "package.json"), JSON.stringify({ name: "pkg", version: "1.2.3", license: "(MIT OR Apache-2.0)", repository: { url: "git+https://example.invalid/pkg.git" } }));
    await writeFile(join(real, "LICENSE"), "pkg license text");
    await writeFile(join(real, "README.md"), "not a license");
    const bare = join(root, "web/node_modules/bare");
    await mkdir(bare);
    await writeFile(join(bare, "package.json"), JSON.stringify({ name: "bare", version: "0.1.0", license: "MIT" }));
    await mkdir(join(root, "lab"));
    await symlink(join(root, "web/node_modules"), join(root, "lab/node_modules"));
    const packages = bundledPackages([join(real, "a.js"), join(root, "lab/node_modules/pkg/b.js"), join(bare, "c.js")]);
    assert.deepEqual(packages.map((p) => [p.name, p.version, p.license, p.texts.map((t) => t.name)]),
      [["bare", "0.1.0", "MIT", []], ["pkg", "1.2.3", "(MIT OR Apache-2.0)", ["LICENSE"]]]);
    const text = noticesText("Title", ["Intro."], packages);
    assert.match(text, /pkg 1\.2\.3\n {2}License \(as declared\): \(MIT OR Apache-2\.0\)\n {2}Repository: git\+https:\/\/example\.invalid\/pkg\.git\n {2}License texts: \[1\] LICENSE\n/);
    assert.match(text, /bare 0\.1\.0\n {2}License \(as declared\): MIT\n {2}Repository: not declared\n {2}License texts: none shipped in the package\n/);
    assert.match(text, /These packages ship no license text; only their declared license is listed above:\n {2}bare 0\.1\.0 \(MIT\)\n/);
    assert.match(text, /\[1\] from:\n {2}pkg 1\.2\.3 LICENSE\n\npkg license text\n/);
    assert.doesNotMatch(text, /not a license/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Reviewed: these bundled packages ship no license text of their own. A new
// one fails here so that it is looked at before it ships.
const WITHOUT_TEXT = ["react-remove-scroll-bar", "victory-vendor"];

test("the built UI carries the project license, the font license and its third-party notices", async () => {
  for (const name of ["LICENSE", "LICENSE-NotoSansSC.txt", "THIRD_PARTY_NOTICES.txt"])
    assert.ok(existsSync(join(dist, "licenses", name)), `licenses/${name} is in the build`);
  const notices = await readFile(join(dist, "licenses/THIRD_PARTY_NOTICES.txt"), "utf8");
  const listed = [...notices.matchAll(/^(\S+) (\S+)\n {2}License \(as declared\): (.*)\n {2}Repository: .*\n {2}License texts: (.*)$/gm)]
    .map(([, name, version, license, texts]) => ({ name, version, license, texts }));
  const count = Number(notices.match(/^Packages \((\d+)\)$/m)?.[1]);
  assert.equal(listed.length, count, "every listed package has its four lines");
  for (const name of ["react", "react-dom", "scheduler", "zod", "katex", "dompurify", "marked", "recharts"])
    assert.ok(listed.some((p) => p.name === name), `${name} is listed`);
  for (const name of ["vite", "typescript", "jsdom", "playwright-core", "rolldown", "@vitejs/plugin-react"])
    assert.ok(!listed.some((p) => p.name === name), `${name} is a build or test tool, not bundled`);
  assert.deepEqual(listed.filter((p) => p.texts === "none shipped in the package").map((p) => p.name), WITHOUT_TEXT);
  // The texts are those the packages ship, e.g. React's own MIT notice.
  assert.match(notices, /from:\n(?: {2}.*\n)* {2}react \S+ LICENSE\n(?: {2}.*\n)*\nMIT License\n\nCopyright \(c\) Meta Platforms, Inc\. and affiliates\./);
});

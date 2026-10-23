import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { bundledFiles, bundledPackages, noticesText } from "./tools/third-party-notices.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The repository's LICENSE, found upward from this config so that lab copies
// of web/ inside the checkout (scripts/slice-lab.py) find it too. A build
// with no LICENSE above it fails rather than ship without one.
function projectLicense(): string {
  for (let dir = here; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "LICENSE"))) return join(dir, "LICENSE");
    if (dirname(dir) === dir) throw new Error(`No LICENSE above ${here}: the built UI must carry the project license`);
  }
}

// The built UI is what Core release bundles ship as web/, so it carries the
// project's license, the bundled font's SIL OFL 1.1, which must travel with
// every copy of the font, and the notices of the npm packages whose code or
// assets this build bundled.
const licenses: Plugin = {
  name: "yuzuno-licenses",
  apply: "build",
  generateBundle(_, bundle) {
    const notices = noticesText("Third-party software in the Yuzuno web UI", [
      "This build contains code and assets from the npm packages below. They are",
      "the packages of the modules and assets this build bundled (web/vite.config.ts,",
      "web/tools/third-party-notices.mjs); packages that are only used to develop,",
      "build or test the UI are not listed. Each package keeps its own license.",
      "Where a package offers a choice of licenses, every text it ships is",
      "reproduced and no choice is made here.",
      "",
      "The project's own license is LICENSE, and the bundled Noto Sans SC subset",
      "is under LICENSE-NotoSansSC.txt (SIL OFL 1.1), both next to this file.",
    ], bundledPackages(bundledFiles(bundle, here)));
    for (const [fileName, source] of [
      ["licenses/LICENSE", readFileSync(projectLicense())],
      ["licenses/LICENSE-NotoSansSC.txt", readFileSync(join(here, "src/assets/fonts/LICENSE-NotoSansSC.txt"))],
      ["licenses/THIRD_PARTY_NOTICES.txt", notices],
    ] as const) {
      this.emitFile({ type: "asset", fileName, source });
    }
  },
};

// The Home Screen entry (T-170): a web app manifest and an apple-touch-icon,
// both at the root, made at build time from the character art the UI already
// shows (src/assets/yuzu-character.png, copied unchanged; see
// desktop/icons/README.md). Paths only, never an origin, so one build serves
// every address Core is reached at. No service worker.
const characterArt = join(here, "src/assets/yuzu-character.png");

/** A PNG's width and height from its IHDR chunk; anything else fails the build. */
function pngSize(png: Buffer): [number, number] {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.toString("latin1", 12, 16) !== "IHDR")
    throw new Error(`${characterArt} is not a PNG`);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

const homeScreen: Plugin = {
  name: "yuzuno-home-screen",
  apply: "build",
  transformIndexHtml: () => [
    { tag: "link", attrs: { rel: "manifest", href: "/manifest.webmanifest" }, injectTo: "head" },
    { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }, injectTo: "head" },
  ],
  generateBundle() {
    const icon = readFileSync(characterArt);
    const [width, height] = pngSize(icon);
    const manifest = {
      id: "/",
      name: "Yuzuno",
      short_name: "Yuzuno",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f5f4ee",
      theme_color: "#f5f4ee",
      icons: [{ src: "/apple-touch-icon.png", sizes: `${width}x${height}`, type: "image/png" }],
    };
    this.emitFile({ type: "asset", fileName: "apple-touch-icon.png", source: icon });
    this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: `${JSON.stringify(manifest, null, 2)}\n` });
  },
};

export default defineConfig({
  plugins: [react(), licenses, homeScreen],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
  clearScreen: false,
  build: { target: "es2022" },
});

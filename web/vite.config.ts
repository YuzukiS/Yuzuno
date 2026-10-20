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

export default defineConfig({
  plugins: [react(), licenses],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
  clearScreen: false,
  build: { target: "es2022" },
});

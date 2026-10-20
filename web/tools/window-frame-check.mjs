// The toolbar as a title bar (Windows desktop without a system frame), in a
// real browser with a stand-in for the desktop window API. Production bundle,
// no Core: the workspace API is answered here.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/window-frame");
await mkdir(output, { recursive: true });
const agent = {
  id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
};
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const results = [];
try {
  for (const theme of ["light", "dark"])
    for (const width of [1440, 940]) {
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      await page.addInitScript((theme) => {
        localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
        window.EventSource = class { close() {} };
        window.frameCalls = [];
        const record = (name) => async () => { window.frameCalls.push(name); };
        // As the system's move loop, a drag takes the press's mouseup and click.
        const drag = async () => {
          window.frameCalls.push("startDragging");
          const take = (event) => { event.stopPropagation(); event.preventDefault(); };
          for (const type of ["mouseup", "click"]) window.addEventListener(type, take, { capture: true, once: true });
        };
        window.__TAURI__ = { window: { getCurrentWindow: () => ({
          isDecorated: async () => false,
          isMaximized: async () => false,
          minimize: record("minimize"),
          toggleMaximize: record("toggleMaximize"),
          close: record("close"),
          startDragging: drag,
        }) } };
      }, theme);
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        assert.equal(route.request().method(), "GET", `no writes: ${url.pathname}`);
        if (url.pathname === "/api/workspace")
          return route.fulfill({ json: { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" } });
        if (url.pathname === "/api/agents/a")
          return route.fulfill({ json: { agent, pending: [], turns: [], artifacts: [], messageReceipts: [] } });
        if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
        const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
        return route.fulfill({
          body: await readFile(file),
          contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" }[extname(file)],
        });
      });
      await page.goto("https://yuzuno-window-frame.test/?shell=desktop");
      const controls = page.getByRole("group", { name: "Window" });
      await controls.waitFor();
      const layout = await page.evaluate(() => {
        const bar = document.querySelector(".toolbar");
        const group = document.querySelector(".window-controls").getBoundingClientRect();
        return {
          fits: bar.scrollWidth <= bar.clientWidth + 1,
          atRightEdge: Math.round(innerWidth - group.right),
          buttons: [...document.querySelectorAll(".window-control")].map((b) => b.getAttribute("aria-label")),
        };
      });
      assert.ok(layout.fits, `${theme} ${width}: ${JSON.stringify(layout)}`);
      assert.ok(layout.atRightEdge < 24, `${theme} ${width}: ${JSON.stringify(layout)}`);
      assert.deepEqual(layout.buttons, ["Minimize", "Maximize", "Close window"]);
      // Empty bar moves the window; a double press maximizes; buttons click.
      const box = await page.locator(".workspace-name").boundingBox();
      await page.mouse.click(box.x + 4, box.y + box.height / 2);
      await page.mouse.dblclick(box.x + 4, box.y + box.height / 2);
      await page.getByRole("button", { name: "Settings and updates" }).click();
      await page.keyboard.press("Escape");
      // A panel opened from the bar keeps its presses: one inside it moves
      // nothing, and one outside closes it, as for panels opened elsewhere.
      const moved = (await page.evaluate(() => window.frameCalls)).length;
      await page.getByRole("button", { name: "Jobs", exact: true }).click();
      const jobs = page.getByRole("dialog");
      await jobs.waitFor();
      const panel = await jobs.boundingBox();
      const title = await jobs.getByRole("heading", { name: "Jobs", exact: true }).boundingBox();
      await page.mouse.click(title.x + 4, title.y + title.height / 2);
      assert.equal(await jobs.count(), 1, `${theme} ${width}: a press inside Jobs keeps it open`);
      await page.mouse.click(Math.max(3, panel.x / 2), panel.y + panel.height / 2);
      await jobs.waitFor({ state: "detached", timeout: 3000 });
      assert.deepEqual((await page.evaluate(() => window.frameCalls)).slice(moved), [], `${theme} ${width}: Jobs moves no window`);
      await page.getByRole("button", { name: "Close window" }).hover();
      const calls = await page.evaluate(() => window.frameCalls);
      assert.deepEqual(calls.filter((c) => c !== "startDragging"), ["toggleMaximize"]);
      assert.ok(calls.includes("startDragging"));
      const closeHover = await page.getByRole("button", { name: "Close window" }).evaluate((el) => getComputedStyle(el).color);
      await page.locator(".toolbar").screenshot({ path: `${output}/toolbar-${theme}-${width}.png` });
      results.push({ theme, width, ...layout, closeHover });
      await page.close();
    }
  console.log(JSON.stringify({ passed: true, results }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ passed: false, results, failure: String(error?.stack || error) }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
}

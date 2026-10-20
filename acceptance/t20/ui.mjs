// One headless Chromium against the lab Core from live.py (4483). Read-only:
// it opens the lab Agent and reads its turns, never sends one.
//   node acceptance/t20/ui.mjs
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:4483";
const evidence = join(here, "evidence");
await mkdir(evidence, { recursive: true });
const state = JSON.parse(await readFile(join(here, "lab/state.json"), "utf8"));
const detail = await (await fetch(`${base}/api/agents/${state.agent}`)).json();
const own = detail.turns.filter((turn) => turn._yuzunoSource === "native");
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const errors = [];
const writes = [];
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
    await context.addInitScript((appearance) => localStorage.setItem("yuzuno.appearance", JSON.stringify(appearance)),
      { theme, fontSize: 16, palette: "garden" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      // The open conversation's own read receipt is the UI's normal behaviour.
      if (request.method() !== "GET" && !/\/api\/agents\/[^/]+\/review$/.test(request.url()))
        writes.push(`${request.method()} ${request.url()}`);
    });
    await page.goto(base);
    // The lab also keeps the Agent first run on the old bridge (same name).
    await page.click(`.agent-row[data-agent-id="${state.agent}"] .agent-select`);
    await page.waitForSelector(".native-turn-notice", { state: "attached" });
    const turns = await page.$$eval("article.turn", (nodes) => nodes.map((node) => ({
      id: node.dataset.turnId,
      notice: node.querySelector(".native-turn-notice")?.textContent ?? null,
      you: [...node.querySelectorAll(".user-message .message-label")].filter((label) => /You/.test(label.textContent)).length,
      text: node.querySelector(".agent-message")?.textContent.slice(0, 400) ?? "",
    })));
    const shown = turns.filter((turn) => turn.notice !== null);
    check(`${theme}: each turn of Claude's own is labelled, and only those`,
      shown.length === own.length && shown.every((turn) => turn.id.startsWith("native-")), { shown, own: own.map((t) => t.id) });
    // A turn recorded before the origin was kept under a client-visible name
    // (the first fixed run) has only the general label.
    const label = (id) => {
      const turn = own.find((candidate) => candidate.id === id);
      if (turn?._yuzunoUnmatched) return "Claude output not matched to a message";
      return turn?._yuzunoOrigin === "task-notification"
        ? "Claude continued after a background task finished" : "Claude continued on its own";
    };
    check(`${theme}: the label says what started it, with no message of yours`,
      shown.every((turn) => turn.notice === label(turn.id) && turn.you === 0)
        && shown.some((turn) => turn.notice === "Claude continued after a background task finished"), shown);
    check(`${theme}: a prompt's turn shows only its own reply`,
      turns.filter((turn) => !turn.id.startsWith("native-")).every((turn) => !/Task completed with exit code/.test(turn.text)), turns);
    const last = page.locator(`article.turn[data-turn-id="${shown.at(-1)?.id}"]`);
    await last.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await last.screenshot({ path: join(evidence, `native-turn-${theme}.png`) });
    await context.close();
  }
  check("no page errors", errors.length === 0, errors);
  check("no writes besides the read receipt", writes.length === 0, writes);
} finally {
  await browser.close();
}
await writeFile(join(evidence, "ui.json"), JSON.stringify({ checks, errors, writes }, null, 2));
if (checks.some((c) => !c.ok)) process.exit(1);

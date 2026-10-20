// One headless Chromium against the lab Core from live.py (4414). Read-only:
// it selects agents and changes local appearance, never sends a turn.
//   node acceptance/conversation-time/live-ui.mjs [suffix]
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:4414";
const suffix = process.argv[2] ? `-${process.argv[2]}` : "";
const shots = join(here, "screenshots");
await mkdir(shots, { recursive: true });
const state = JSON.parse(await readFile(join(here, "live-state.json"), "utf8"));
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const errors = [];
const writes = [];

async function open({ theme = "light", fontSize = 16, width = 1440, height = 960 }) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
  await context.addInitScript((appearance) => {
    localStorage.setItem("yuzuno.appearance", JSON.stringify(appearance));
  }, { theme, fontSize, palette: "garden" });
  // Copies are captured instead of reaching the system clipboard.
  await context.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.__copied.push(text); } },
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    // The open conversation's own read receipt is the UI's normal behaviour.
    if (request.method() !== "GET" && !/\/api\/agents\/[^/]+\/review$/.test(request.url()))
      writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto(base);
  return { context, page };
}

async function select(page, name) {
  await page.click(`.agent-row:has-text("${name}") .agent-select`);
  await page.waitForSelector(".turn .final-message");
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const log = document.querySelector(".conversation-body")?.closest("[class*=scroll]") || document.scrollingElement;
    for (const node of document.querySelectorAll("*"))
      if (node.scrollHeight > node.clientHeight + 4 && getComputedStyle(node).overflowY !== "visible") node.scrollTop = node.scrollHeight;
    log.scrollTop = log.scrollHeight;
  });
  await page.waitForTimeout(250);
}

/** Visible facts: minute labels in order, footers, and reply-line geometry. */
const facts = (page) => page.evaluate(() => ({
  times: [...document.querySelectorAll(".turn .message-time")].map((node) => ({
    item: node.closest("[data-item-id]")?.dataset.itemId, text: node.textContent, title: node.title,
    fontSize: parseFloat(getComputedStyle(node).fontSize), color: getComputedStyle(node).color,
  })),
  footers: [...document.querySelectorAll(".turn .turn-footer")].map((node) => {
    const copy = node.closest(".reply-actions")?.querySelector(".copy-button")?.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      turn: node.closest("article").dataset.turnId, text: node.textContent,
      sameLine: !!copy && box.top < copy.bottom && box.bottom > copy.top,
      // A turn without a reply has no Copy reply; its footer stands alone.
      standalone: !!node.closest(".turn-footer-standalone"),
      right: Math.round(box.right), viewport: innerWidth, top: Math.round(box.top),
      lines: Math.round(box.height / parseFloat(getComputedStyle(node).lineHeight)),
      fontSize: parseFloat(getComputedStyle(node).fontSize),
    };
  }),
  overflow: document.documentElement.scrollWidth > innerWidth + 1,
}));

async function variant(harness, name, options) {
  const { context, page } = await open(options);
  try {
    await select(page, `T-14 ${harness}`);
    const seen = await facts(page);
    await page.screenshot({ path: join(shots, `${harness}-${name}${suffix}.png`) });
    return { page, context, seen };
  } catch (error) {
    await context.close();
    throw error;
  }
}

const api = (path, init) => fetch(base + path, { ...init, headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" } }).then((r) => r.json());
const times = (seen) => seen.times.map(({ item, text, title }) => ({ item, text, title }));

/** A reply streamed into the open page, the event stream dropped and
 * resumed, and a trimmed output expanded and copied in full. */
async function streaming() {
  const agent = state.agents.codex;
  const { context, page } = await open({});
  try {
    await select(page, "T-14 codex");
    const reads = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === `/api/agents/${agent}`) reads.push(request.url());
    });
    const before = (await api(`/api/agents/${agent}`)).turns.length;
    await api(`/api/agents/${agent}/turns`, { method: "POST", body: JSON.stringify({
      text: "T-14 acceptance. Write twelve short numbered lines about rivers, one per line. Do not use any tool." }) });
    let d;
    for (let i = 0; i < 300; i++) {
      d = await api(`/api/agents/${agent}`);
      if (d.turns.length > before && /completed|failed|interrupted/.test(d.turns.at(-1).status)) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
    const turnId = d.turns.at(-1).id;
    const reply = d.turns.at(-1).items.filter((i) => i.type === "agentMessage").at(-1);
    const live = await facts(page);
    const shown = await page.evaluate((id) => document.querySelector(`[data-item-id="${id}"] .final-message, [data-item-id="${id}"]`)?.textContent ?? "", reply.id);
    check("codex: a reply streamed into the open page reads the detail only a few times", reads.length <= 8 && shown.includes(reply.text.slice(-20)), { reads: reads.length });
    check("codex: the streamed turn ends with its footer on the Copy reply line",
      live.footers.some((f) => f.turn === turnId && f.sameLine && /^Cooked for/.test(f.text)), live.footers.filter((f) => f.turn === turnId));
    await page.screenshot({ path: join(shots, `codex-streamed${suffix}.png`) });
    await context.setOffline(true);
    await page.waitForTimeout(3000);
    await context.setOffline(false);
    await page.waitForTimeout(5000);
    const resumed = await facts(page);
    check("codex: marks and footers are unchanged after the event stream reconnects",
      JSON.stringify(times(live)) === JSON.stringify(times(resumed))
        && JSON.stringify(live.footers.map((f) => f.text)) === JSON.stringify(resumed.footers.map((f) => f.text)),
      { live: times(live), resumed: times(resumed) });

    const large = JSON.parse(await readFile(join(here, "evidence/codex-large.json"), "utf8"));
    const shell = large.shell[0];
    const expanded = await page.evaluate(async ({ turnId, itemId }) => {
      const row = document.querySelector(`[id="turn-${turnId}"] [id="item-${itemId}"]`);
      const show = row && [...row.querySelectorAll("button")].find((b) => /^Show full output/.test(b.textContent));
      if (!show) return { ok: false, reason: "no Show full output button" };
      show.click();
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const text = row.querySelector("pre")?.textContent ?? "";
        if (text.startsWith("1\n2\n3\n")) return { ok: true, length: text.length, notice: !!row.querySelector(".truncation-notice") };
      }
      return { ok: false, start: row.querySelector("pre")?.textContent.slice(0, 40) };
    }, { turnId: large.turnId, itemId: shell.id });
    check("codex: a trimmed output still expands to its full text on request", expanded.ok && expanded.length >= 18_000 && !expanded.notice, expanded);
    const copied = await page.evaluate(async (turnId) => {
      const copy = [...document.querySelector(`[id="turn-${turnId}"] .turn-divider`).querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Copy turn");
      copy.click();
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (window.__copied.length) return window.__copied.at(-1);
      }
      return "";
    }, large.turnId);
    check("codex: Copy turn copies the trimmed output in full", copied.includes("\n1\n2\n3\n") && copied.includes("\n4000"), { length: copied.length });
    const largeFooter = (await facts(page)).footers.find((f) => f.turn === large.turnId);
    check("codex: the large-output turn keeps its footer on the Copy reply line", largeFooter?.sameLine, largeFooter);
    await page.screenshot({ path: join(shots, `codex-large-expanded${suffix}.png`) });
    return { reads: reads.length, live, resumed, expanded, copiedLength: copied.length };
  } finally {
    await context.close();
  }
}

const result = {};
try {
  if (process.env.T14_STREAM !== "0") result.streaming = await streaming();
  for (const harness of ["codex", "claude"]) {
    const light = await variant(harness, "light", {});
    const reloadBefore = light.seen.times.map(({ item, text, title }) => ({ item, text, title }));
    await light.page.reload();
    await select(light.page, `T-14 ${harness}`);
    const reloadAfter = (await facts(light.page)).times.map(({ item, text, title }) => ({ item, text, title }));
    await light.context.close();
    check(`${harness}: minute labels are identical after a full reload`,
      JSON.stringify(reloadBefore) === JSON.stringify(reloadAfter) && reloadBefore.length > 0, { reloadBefore, reloadAfter });
    const footers = light.seen.footers;
    check(`${harness}: every finished turn has its footer on the Copy reply line, or alone without a reply`,
      footers.length >= 1 && footers.every((f) => f.sameLine || f.standalone), footers);
    check(`${harness}: only the latest turn mentions shells`,
      footers.slice(0, -1).every((f) => !/shell/.test(f.text)), footers.map((f) => f.text));
    check(`${harness}: no footer says done unless the turn completed`,
      footers.every((f) => !/done/.test(f.text) || /^Cooked for|^done/.test(f.text)), footers.map((f) => f.text));

    const dark = await variant(harness, "dark", { theme: "dark" });
    await dark.context.close();
    check(`${harness}: dark mode uses the quiet theme colour, not the light grey`,
      dark.seen.times.every((t) => t.color !== light.seen.times[0].color), dark.seen.times.map((t) => t.color));

    const large = await variant(harness, "font20", { fontSize: 20 });
    await large.context.close();
    check(`${harness}: at the 20px setting times stay at least 15px`,
      large.seen.times.every((t) => t.fontSize >= 15) && large.seen.footers.every((f) => f.fontSize >= 15),
      { times: large.seen.times.map((t) => t.fontSize), footers: large.seen.footers.map((f) => f.fontSize) });

    const narrow = await variant(harness, "narrow", { width: 1440, height: 900 });
    await narrow.page.setViewportSize({ width: 520, height: 900 });
    await narrow.page.waitForTimeout(400);
    await select(narrow.page, `T-14 ${harness}`).catch(() => {});
    const small = await facts(narrow.page);
    await narrow.page.screenshot({ path: join(shots, `${harness}-narrow${suffix}.png`) });
    await narrow.context.close();
    check(`${harness}: on a narrow window footers wrap inside the viewport`,
      !small.overflow && small.footers.every((f) => f.right <= f.viewport), small.footers);
    result[harness] = { light: light.seen, dark: dark.seen, large: large.seen, narrow: small };
  }
  check("no page errors", errors.length === 0, errors);
  check("no writes besides the open conversation's read receipt", writes.length === 0, writes);
} finally {
  await browser.close();
  await writeFile(join(here, `live-ui-result${suffix}.json`), JSON.stringify({ checks, result }, null, 2));
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

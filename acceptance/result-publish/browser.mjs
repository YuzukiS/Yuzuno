// T-37: one headless Chromium against the lab Core from live.py (4494), on
// the real Turns live.py recorded in evidence/. Read-only: it selects
// conversations and reads them, never sends a Turn.
//   node acceptance/result-publish/browser.mjs
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:4494";
const shots = join(here, "screenshots");
await mkdir(shots, { recursive: true });
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
};

// Every recorded Turn, by the lab Agent it belongs to.
const state = JSON.parse(await readFile(join(here, "live-state.json"), "utf8"));
const names = Object.fromEntries(Object.entries(state.agents).map(([key, id]) => [id, state.keys?.[key]?.name ?? `T-37 ${key}`]));
const byAgent = {};
for (const file of (await readdir(join(here, "evidence"))).filter((f) => /^(codex|claude)[\w-]*-\d+\.json$/.test(f)).sort()) {
  const facts = JSON.parse(await readFile(join(here, "evidence", file), "utf8"));
  if (facts.turnId && facts.agent) (byAgent[facts.agent] ??= []).push({ ...facts, file });
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
const writes = [];
const resultReads = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (/\/api\/agents\/[^/]+\/results\//.test(request.url())) resultReads.push(request.url());
  // The open conversation's own read receipt is the UI's normal behaviour.
  if (request.method() !== "GET" && !/\/api\/agents\/[^/]+\/review$/.test(request.url()))
    writes.push(`${request.method()} ${request.url()}`);
});
await page.goto(base);

async function open(name) {
  const row = page.locator(".agent-row").filter({ has: page.locator(".agent-name", { hasText: new RegExp(`^${name}$`) }) });
  await row.locator(".agent-select").click();
  await page.waitForSelector(".turn .final-message");
  await page.waitForTimeout(600);
}

async function turn(facts, shot) {
  const article = page.locator(`article[data-turn-id="${facts.turnId}"]`);
  await article.scrollIntoViewIfNeeded();
  const shown = article.locator(".turn-results .interactive-result");
  if (facts.shown.length) await shown.first().waitFor({ timeout: 10_000 });
  else await page.waitForTimeout(300);
  const seen = await article.evaluate((node) => ({
    results: [...node.querySelectorAll(".turn-results .interactive-result")].map((r) => ({
      id: r.dataset.resultId, rows: r.querySelectorAll("tbody tr").length,
      text: r.querySelector(".result-disclosure")?.textContent.slice(0, 200),
    })),
    notes: [...node.querySelectorAll(".turn-results [data-result-state]")].map((n) => n.dataset.resultState),
    replyBeforeResult: (() => {
      const reply = [...node.querySelectorAll(".final-message, .commentary")].pop();
      const result = node.querySelector(".turn-results");
      return !reply || !result || !!(reply.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
  }));
  if (shot) {
    const target = facts.shown.length ? shown.first() : article;
    await target.scrollIntoViewIfNeeded();
    await article.screenshot({ path: join(shots, `${shot}.png`) });
  }
  return seen;
}

for (const [agent, turns] of Object.entries(byAgent)) {
  await open(names[agent]);
  for (const facts of turns) {
    const label = facts.file.replace(/\.json$/, "");
    const seen = await turn(facts, label);
    const expected = facts.shown.map((s) => s.id);
    check(`${label}: the Turn shows exactly the accepted results`,
      JSON.stringify(seen.results.map((r) => r.id)) === JSON.stringify(expected) && !seen.notes.length, { seen, expected });
    if (expected.length) {
      check(`${label}: the result draws its table or chart, below the reply`,
        seen.results.every((r) => r.rows > 0) && seen.replyBeforeResult, seen);
      const title = facts.shown[0].title;
      check(`${label}: titled as published`, seen.results[0].text?.includes(title), { title, text: seen.results[0].text });
    }
  }
}
check("no page errors", errors.length === 0, errors);
check("reading results sends nothing but the read receipt", writes.length === 0, writes);
check("each result version is read at most once", new Set(resultReads).size === resultReads.length, resultReads);
await browser.close();
const report = { at: new Date().toISOString(), checks, passed: checks.every((c) => c.ok) };
await writeFile(join(here, "evidence", "browser.json"), JSON.stringify(report, null, 2));
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);

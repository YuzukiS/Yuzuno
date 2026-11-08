import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { hoverTip } from "./tip-dom.mjs";

// T-85: a Brief section body drawn by Home's renderer. The real
// BriefSectionBody in JSDOM, with bodies first accepted by the real brief
// contract; Core is a fetch stub. No Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "brief-render-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {BriefSectionBody} from ${JSON.stringify(path.join(root, "src/home/brief/BriefSectionBody.tsx"))};
import {CardFoldWorkspace} from ${JSON.stringify(path.join(root, "src/home/card-fold.tsx"))};
import {BRIEF_EXAMPLES, checkBriefSection} from ${JSON.stringify(path.join(root, "src/intelligent-ui/brief-contract.ts"))};
import {PointFixOpen} from ${JSON.stringify(path.join(root, "src/point-fix.ts"))};
import {BriefDensity} from ${JSON.stringify(path.join(root, "src/home/home-density.ts"))};
import {saveLanguagePreferences} from ${JSON.stringify(path.join(root, "src/i18n.ts"))};
import {SummaryCard} from ${JSON.stringify(path.join(root, "src/home/SummaryCard.tsx"))};
import {ReportOpen} from ${JSON.stringify(path.join(root, "src/home/report/report-open.ts"))};
import {sectionMarkdown} from ${JSON.stringify(path.join(root, "src/home/brief/brief-copy.ts"))};
window.sectionMarkdown=sectionMarkdown;
const root=createRoot(document.getElementById('root'));
window.chooseLanguage=(language)=>saveLanguagePreferences({language});
window.examples=BRIEF_EXAMPLES;
window.checkBriefSection=checkBriefSection;
// With a density, as Home draws its cards (T-9); without one, as anywhere else.
window.renderSection=(section,projectId,extra={},workspaceId='',density)=>{const body=<CardFoldWorkspace.Provider value={workspaceId}><PointFixOpen.Provider value={window.pointFixOpen||null}><BriefSectionBody section={section} projectId={projectId} {...extra}/></PointFixOpen.Provider></CardFoldWorkspace.Provider>;flushSync(()=>root.render(density?<BriefDensity.Provider value={density}>{body}</BriefDensity.Provider>:body));};
window.unmountSection=()=>flushSync(()=>root.render(null));
// A report as its summary card on Home (T-18), read only: its figure in its frame; on the deck (extra.deck), at its size.
// With window.reportOpens an array, the card's way to its report page records each opening (YN-16).
const opener=()=>window.reportOpens?(projectId,section)=>window.reportOpens.push(section.key):null;
window.renderCard=(section,projectId,extra={})=>flushSync(()=>root.render(<ReportOpen.Provider value={opener()}><SummaryCard section={section} projectId={projectId} workspaceId="ws" agents={[]} readOnly={true} onSeen={async()=>{}} {...extra}/></ReportOpen.Provider>));
// A card and, beside it, the same section drawn whole, as a report page beside Home (YN-16): two places.
window.renderCardAndBody=(section,projectId)=>flushSync(()=>root.render(<ReportOpen.Provider value={opener()}><SummaryCard section={section} projectId={projectId} workspaceId="ws" agents={[]} readOnly={true} onSeen={async()=>{}} deck/><BriefSectionBody section={section} projectId={projectId}/></ReportOpen.Provider>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "BriefRender", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const PROJECT = "proj-1";
const KEY = "round-12/review";
const base = `/api/projects/${PROJECT}/brief`;
const encodedKey = encodeURIComponent(KEY);
const log = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const csv = 'step,train_loss,note\n1,2.5,"warm, up"\n2,2.1,ok\n3,1.9,"said ""fine"""\n';

function mount(respond) {
  const errors = [];
  const requests = [];
  const events = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // dagre (YN-16 S3) clones with structuredClone, which every browser Yuzuno supports has and a jsdom window lacks.
  window.structuredClone ??= (value) => structuredClone(value);
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", headers: init.headers || {} });
    const { status = 200, body = {}, text } = (await respond?.(String(url))) ?? {};
    const raw = text ?? JSON.stringify(body);
    return { ok: status < 400, status, json: async () => body, text: async () => raw, blob: async () => new window.Blob([raw], { type: "image/png" }) };
  };
  for (const name of ["yuzuno:open-job", "yuzuno:open-task-review"])
    window.addEventListener(name, (event) => events.push({ name, detail: JSON.parse(JSON.stringify(event.detail)) }));
  window.eval(bundle);
  const document = window.document;
  return { window, document, errors, requests, events, close: () => window.close() };
}

/** A put change, checked by the brief contract, as Core would return it. */
function readSection(page, put, read = {}) {
  const normalized = page.window.checkBriefSection(put);
  return {
    key: normalized.key,
    kind: normalized.kind,
    title: normalized.title,
    version: 3,
    owner: { agentId: "agent-a", name: "Researcher", state: "active" },
    updatedAt: "2026-10-17T08:00:00Z",
    updatedTurnId: "turn-1",
    body: normalized.body,
    ...(normalized.status ? { status: { ...normalized.status, stale: false } } : {}),
    ...(normalized.time ? { time: normalized.time } : {}),
    ...(normalized.ask ? { ask: { ...normalized.ask, state: "open" } } : {}),
    attachments: [],
    seen: null,
    history: false,
    ...read,
  };
}

const at = "2026-10-17T07:58:00Z";
const attachment = (name, kind, mime, extra = {}) => ({
  name, kind, mime, size: 2048, snapshot: true, mayChange: false, takenAt: at, ...extra,
});
const everything = {
  op: "put",
  key: KEY,
  kind: "report",
  title: "Round 12",
  attachments: [
    { name: "grid.png", path: "/runs/12/grid.png" },
    { name: "loss.csv", path: "/runs/12/loss.csv" },
    { name: "test.log", path: "/runs/12/test.log" },
    { name: "paper.pdf", path: "/runs/12/paper.pdf" },
    { name: "docs", url: "https://example.com/docs" },
    { name: "huge.jsonl", path: "/runs/12/huge.jsonl" },
  ],
  body: {
    root: "body",
    elements: {
      body: {
        type: "BriefBody",
        props: {},
        children: ["intro", "checks", "plan", "findings", "metrics", "table", "line", "bars", "scatter", "loss", "refs", "files", "sources"],
      },
      intro: { type: "Group", props: { title: "Summary" }, children: ["prose", "inlineMath", "displayMath"] },
      prose: {
        type: "Markdown",
        props: {
          text:
            "Round 12 passes **213 of 214** tests. ![tracker](https://evil.example/pixel.png)\n\n" +
            "```rust\nfn main() {}\n```\n\n```log\nFAIL brief limits\n```\n\n[Docs](https://example.com/guide)",
        },
      },
      inlineMath: { type: "Math", props: { tex: "e^{i\\pi} + 1 = 0" } },
      displayMath: { type: "Math", props: { tex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}", display: true } },
      checks: {
        type: "Checklist",
        props: { title: "Checks", items: [{ id: "c1", text: "Lint", done: true }, { id: "c2", text: "Bench", done: false }] },
      },
      plan: {
        type: "Plan",
        props: {
          title: "Next",
          steps: [
            { id: "p1", text: "Fix restart", state: "doing" },
            { id: "p2", text: "Rerun", state: "blocked" },
            { id: "p3", text: "Ship", state: "todo" },
          ],
        },
      },
      findings: {
        type: "Findings",
        props: {
          items: [{ id: "f1", source: "core/src/project_brief/mod.rs:120", severity: "medium", text: "A stale version is accepted." }],
        },
      },
      metrics: {
        type: "Metrics",
        props: {
          items: [
            { label: "Validation loss", value: 0.412, previous: 0.437 },
            { label: "Throughput", value: 1830, unit: "samples/s", previous: 1795 },
            { label: "Step", value: "18k of 40k", previous: "12k of 40k" },
          ],
        },
      },
      table: {
        type: "Table",
        props: {
          id: "runs",
          columns: [{ key: "run", label: "Run" }, { key: "score", label: "Score" }],
          rows: [{ id: "r11", cells: { run: "11", score: 0.71 } }, { id: "r12", cells: { run: "12", score: 0.74 } }],
        },
      },
      line: {
        type: "LineChart",
        props: { id: "acc", title: "Accuracy", x: { label: "Epoch" }, y: { label: "Accuracy", unit: "%" }, series: [{ name: "Val", points: [[1, 60], [2, 70]] }] },
      },
      bars: {
        type: "BarChart",
        props: { id: "cost", title: "Cost", x: { label: "Run" }, y: { label: "Cost", unit: "USD" }, series: [{ name: "A", points: [["r11", 4], ["r12", 5]] }, { name: "B", points: [["r11", 3], ["r12", 2]] }] },
      },
      scatter: {
        type: "ScatterChart",
        props: { id: "spread", title: "Spread", x: { label: "Size" }, y: { label: "Time" }, series: [{ name: "Runs", points: [[1, 2], [3, 4]] }] },
      },
      loss: {
        type: "LineChart",
        props: {
          id: "loss",
          title: "Loss",
          x: { label: "Step" },
          y: { label: "Loss" },
          data: { attachment: "loss.csv", x: "step", series: [{ name: "Train", column: "train_loss" }] },
        },
      },
      refs: {
        type: "LiveRefs",
        props: {
          items: [
            { kind: "task", id: "T-85", label: "Home V1" },
            { kind: "job", id: "job-7" },
            { kind: "pr", id: "owner/repo#12" },
            { kind: "ci", id: "https://github.com/owner/repo/actions/runs/99" },
            { kind: "agent", id: "agent-b", label: "Coder" },
            { kind: "machine", id: "lab_host" },
            { kind: "review", id: "rev-3" },
            { kind: "job", id: "job-gone" },
          ],
        },
      },
      files: {
        type: "Attachments",
        props: {
          items: [
            { name: "grid.png", caption: "Sample grid" },
            { name: "loss.csv" },
            { name: "test.log" },
            { name: "paper.pdf" },
            { name: "docs" },
            { name: "huge.jsonl" },
          ],
        },
      },
      sources: { type: "Sources", props: { items: [{ id: "s1", label: "Paper", href: "https://example.com/paper" }] } },
    },
  },
};
const everythingAttachments = [
  attachment("grid.png", "image", "image/png"),
  attachment("loss.csv", "data", "text/csv"),
  attachment("test.log", "text", "text/plain"),
  attachment("paper.pdf", "pdf", "application/pdf"),
  attachment("docs", "link", "text/html", { size: 0, snapshot: false, url: "https://example.com/docs" }),
  attachment("huge.jsonl", "data", "application/jsonl", {
    size: 80 * 1024 * 1024, snapshot: false, mayChange: true, path: "/home/me/experiments/round-12/outputs/sweep/huge.jsonl",
  }),
];
const respond = (url) => {
  if (url === `${base}/chart/${encodedKey}/loss?version=3`)
    return { body: { series: [{ name: "Train", points: [[1, 2.5], [2, 2.1], [3, 1.9]] }], x: { label: "Step" }, y: { label: "Loss" }, downsampled: true, sourcePoints: 48000 } };
  if (url === `${base}/attachments/${encodedKey}/loss.csv?version=3`) return { text: csv };
  if (url === `${base}/attachments/${encodedKey}/test.log?version=3`) return { text: log };
  return { status: 404, body: { error: "not found" } };
};

test("a section using every component renders each part from this Core only", async (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document } = page;
  const section = readSection(page, everything, { attachments: everythingAttachments });
  page.window.renderSection(section, PROJECT);
  const body = document.querySelector(".brief-body");
  assert.ok(body, "the body renders");
  assert.equal(document.querySelector(".result-part-error"), null, "no part failed");
  // Before its data arrives, the attachment chart already has every line it
  // will have: the points note and the data table's summary.
  const waiting = document.querySelectorAll(".brief-chart")[3];
  assert.match(waiting.querySelector(".brief-chart-state").textContent, /Loading chart data/);
  assert.equal(waiting.querySelector(".brief-chart-points").textContent, " ");
  assert.equal(waiting.querySelector("details.brief-chart-data > summary").textContent, "Data table");

  // Markdown: emphasis, fenced code and a log block; never an image.
  assert.equal(document.querySelector(".brief-markdown strong").textContent, "213 of 214");
  assert.equal(document.querySelector(".brief-markdown pre code.language-rust").textContent.trim(), "fn main() {}");
  assert.equal(document.querySelector(".brief-markdown pre code.language-log").textContent.trim(), "FAIL brief limits");
  assert.equal(document.querySelector(".brief-group > h4").textContent, "Summary");

  // KaTeX, inline and display.
  assert.ok(document.querySelector(".brief-math.is-inline .katex"), "inline KaTeX output");
  assert.ok(document.querySelector(".brief-math.is-display .katex-display .katex"), "display KaTeX output");
  assert.ok(document.querySelector(".brief-math .katex-mathml math"), "MathML for assistive technology");

  // Checklist, plan and findings.
  assert.match(document.querySelector(".brief-list header span").textContent, /1 of 2 done/);
  const chips = [...document.querySelectorAll(".brief-chip")].map((chip) => chip.textContent);
  for (const label of ["Doing", "Blocked", "To do", "Medium"]) assert.ok(chips.includes(label), `${label} chip`);
  assert.match(document.querySelector(".brief-findings").textContent, /core\/src\/project_brief\/mod\.rs:120/);

  // Metrics: the signed change when both values are numbers, else the old value.
  const deltas = [...document.querySelectorAll(".brief-delta")].map((delta) => delta.textContent);
  assert.match(deltas[0], /^−0\.025/);
  assert.match(deltas[1], /^\+35 samples\/s/);
  assert.equal(deltas[2], "Previously 12k of 40k");
  assert.deepEqual(await hoverTip(page.window, document.querySelector('.brief-delta[data-sign="-1"]')), ["Previously 0.437"]);

  // The table, from interactive results, without selection.
  assert.equal(document.querySelectorAll(".result-table-scroll tbody tr").length, 2);
  assert.equal(document.querySelector(".result-table-scroll input[type=checkbox]"), null);
  assert.ok(document.querySelector(".result-source-list a[href='https://example.com/paper']"));

  // Charts: inline ones need no request; the attachment one asks Core and says it was downsampled.
  const titles = [...document.querySelectorAll(".brief-chart h4")].map((h) => h.textContent);
  assert.deepEqual(titles, ["Accuracy", "Cost", "Spread", "Loss"]);
  assert.deepEqual([...document.querySelectorAll(".brief-chart")[1].querySelectorAll(".brief-legend li")].map((li) => li.textContent), ["A", "B"]);
  await until(() => /Downsampled from 48[^\d]?000 points/.test(body.textContent), "the downsampled note");
  const loss = document.querySelectorAll(".brief-chart")[3];
  assert.match(loss.querySelector(".brief-chart-foot").textContent, /Data: loss\.csv · snapshot/);
  for (const plot of document.querySelectorAll(".brief-chart-plot"))
    assert.equal(plot.querySelector(".brief-chart-state"), null, "no chart is left loading or failed");
  const chartRequests = page.requests.filter((r) => r.url.includes("/chart/"));
  assert.deepEqual(chartRequests.map((r) => r.url), [`${base}/chart/round-12%2Freview/loss?version=3`]);
  // Each chart has a data table, closed and empty until it is opened.
  const costTable = document.querySelectorAll(".brief-chart")[1].querySelector("details.brief-chart-data");
  assert.ok(!costTable.open && !costTable.querySelector("table"));
  costTable.open = true;
  await until(() => costTable.querySelector("tbody tr"), "the opened data table");
  assert.deepEqual(
    [...costTable.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => c.textContent)),
    [["Run", "A", "B"], ["r11", "4", "3"], ["r12", "5", "2"]],
  );

  // Attachments: our API only; image, data preview, log tail, PDF link, external link, reference.
  const imageUrl = `${base}/attachments/round-12%2Freview/grid.png?version=3`;
  const images = [...document.querySelectorAll("img")];
  assert.deepEqual(images.map((img) => img.getAttribute("src")), [imageUrl]);
  assert.ok(images.every((img) => img.getAttribute("src").startsWith("/api/")), "no image outside /api/");
  assert.equal(images[0].getAttribute("alt"), "Sample grid");
  await until(() => document.querySelector(".brief-attachment .brief-preview-scroll tbody tr"), "the CSV preview");
  const preview = [...document.querySelectorAll(".brief-attachment .brief-preview-scroll tr")].map((tr) => [...tr.children].map((c) => c.textContent));
  assert.deepEqual(preview, [["step", "train_loss", "note"], ["1", "2.5", "warm, up"], ["2", "2.1", "ok"], ["3", "1.9", 'said "fine"']]);
  await until(() => document.querySelector(".brief-tail"), "the log tail");
  const tail = document.querySelector(".brief-tail").textContent.split("\n");
  assert.equal(tail.length, 200);
  assert.equal(tail[0], "line 51");
  assert.equal(tail.at(-1), "line 250");
  assert.match(document.querySelector(".brief-tail").parentElement.textContent, /Last 200 lines/);
  const tailRequest = page.requests.find((r) => r.url.endsWith("/test.log?version=3"));
  assert.match(tailRequest.headers.Range, /^bytes=-\d+$/);
  const pdf = document.querySelector('.brief-attachment[data-kind="pdf"] a.brief-attachment-open');
  assert.equal(pdf.getAttribute("href"), `${base}/attachments/round-12%2Freview/paper.pdf?version=3`);
  assert.equal(pdf.target, "_blank");
  assert.equal(document.querySelector("iframe, embed, object"), null, "nothing is embedded");
  assert.equal(document.querySelector('.brief-attachment[data-kind="link"] a.brief-attachment-link').getAttribute("href"), "https://example.com/docs");
  const huge = [...document.querySelectorAll(".brief-attachment")].find((a) => a.textContent.includes("huge.jsonl"));
  assert.match(huge.textContent, /May have changed/);
  assert.match(huge.textContent, /Referenced/);
  const where = huge.querySelector("code.brief-path");
  // Its tip shows the whole path once the directory is cut (YN-44: a box narrower than its text).
  const dir = where.querySelector(".brief-path-dir");
  Object.defineProperty(dir, "clientWidth", { configurable: true, get: () => 80 });
  Object.defineProperty(dir, "scrollWidth", { configurable: true, get: () => 240 });
  assert.deepEqual(await hoverTip(page.window, where), ["/home/me/experiments/round-12/outputs/sweep/huge.jsonl"], "the full path on hover");
  // CSS cuts the directory short; the file name is its own, unclipped part.
  assert.equal(where.querySelector(".brief-path-dir").textContent, "/home/me/experiments/round-12/outputs/sweep/");
  assert.equal(where.querySelector(".brief-path-name").textContent, "huge.jsonl");
  assert.ok(!page.requests.some((r) => r.url.includes("huge.jsonl")), "a reference is never read");

  // Every request was a read of this Core.
  assert.ok(page.requests.every((r) => r.method === "GET" && r.url.startsWith(`${base}/`)), JSON.stringify(page.requests));
  assert.deepEqual(page.errors, []);
});

test("a Brief image opens in the app's preview, not a browser tab; without Point & Fix there is no Mark up (T-177)", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const put = {
    op: "put", key: "shots", kind: "report", title: "Screens",
    attachments: [{ name: "shot.png", path: "/runs/shot.png" }, { name: "paper.pdf", path: "/runs/paper.pdf" }],
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["files"] },
      files: { type: "Attachments", props: { items: [{ name: "shot.png", caption: "Login screen" }, { name: "paper.pdf" }] } },
    } },
  };
  const attachments = [attachment("shot.png", "image", "image/png"), attachment("paper.pdf", "pdf", "application/pdf")];
  window.renderSection(readSection(page, put, { attachments }), PROJECT);
  const shot = document.querySelector('.brief-attachment[data-kind="image"]');
  assert.ok(!shot.querySelector("a"), "no link to a browser tab");
  const picture = shot.querySelector("button.brief-image");
  assert.equal(picture.getAttribute("aria-label"), "Open image shot.png");
  assert.equal(shot.querySelector("button.brief-attachment-open").textContent, "Open");
  const pdf = document.querySelector('.brief-attachment[data-kind="pdf"] a.brief-attachment-open');
  assert.equal(pdf.target, "_blank", "other attachments open as before");
  const dialog = () => document.querySelector('[role="dialog"]');
  picture.focus();
  picture.click();
  await until(dialog, "the preview opens");
  // What it shows first: its caption is the title, its file after (T-20).
  assert.equal(dialog().querySelector("h2").textContent, "Login screen");
  assert.match(dialog().textContent, /shot\.png · Snapshot /);
  assert.equal(dialog().querySelector(".input-image-dialog img").getAttribute("src"), `${base}/attachments/shots/shot.png?version=3`);
  assert.ok(![...dialog().querySelectorAll("button")].some((b) => b.textContent.includes("Mark up")), "no Mark up without Point & Fix");
  dialog().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !dialog(), "Escape closes it");
  assert.ok(document.activeElement === picture, "focus returns to the image");
  // Its Open opens the same preview; an image that cannot be read says so.
  shot.querySelector("button.brief-attachment-open").click();
  await until(dialog, "Open opens the preview");
  dialog().querySelector(".input-image-dialog img").dispatchEvent(new window.Event("error"));
  await until(() => dialog().querySelector('[role="alert"]'), "the failure is shown");
  assert.match(dialog().querySelector('[role="alert"]').textContent, /can't be read from this Core/);
  assert.ok(page.requests.every((r) => r.method === "GET"), "a preview writes nothing");
  assert.deepEqual(page.errors, []);
});

test("T-9 a Home picture leads with itself and its caption; its file details fold under Image info; one that fails to load says so", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const put = {
    op: "put", key: "shots", kind: "report", title: "Screens",
    attachments: [{ name: "shot.png", path: "/runs/shot.png" }, { name: "plain.png", path: "/runs/plain.png" }],
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["files"] },
      files: { type: "Attachments", props: { items: [{ name: "shot.png", caption: "Login screen" }, { name: "plain.png" }] } },
    } },
  };
  const attachments = [attachment("shot.png", "image", "image/png"), attachment("plain.png", "image", "image/png")];
  window.renderSection(readSection(page, put, { attachments }), PROJECT);
  const [shot, plain] = document.querySelectorAll('.brief-attachment[data-picture]');
  // The picture, then what it shows; the file's name, size and snapshot wait, folded.
  assert.deepEqual([...shot.children].map((el) => el.className.split(" ")[0] || el.tagName.toLowerCase()).slice(0, 3),
    ["brief-image", "brief-attachment-caption", "brief-image-info"]);
  assert.equal(shot.querySelector(".brief-attachment-caption").textContent, "Login screen");
  assert.ok(shot.querySelector("button.brief-image .brief-image-zoom"), "the picture says it opens larger");
  const info = shot.querySelector("details.brief-image-info");
  assert.equal(info.open, false);
  assert.equal(info.querySelector("summary").textContent, "Image info");
  assert.deepEqual([...info.querySelectorAll("dt")].map((dt) => dt.textContent), ["File", "Size", "Snapshot"]);
  assert.equal(info.querySelector("dd").textContent, "shot.png");
  assert.ok(info.querySelector("button.brief-attachment-open"), "Open is one of the details");
  // Without a caption, the file name stands in.
  assert.equal(plain.querySelector(".brief-attachment-caption.brief-image-name").textContent, "plain.png");
  // A picture this Core can't read says so, in words, where it would be.
  shot.querySelector("button.brief-image img").dispatchEvent(new window.Event("error"));
  await until(() => shot.querySelector(".brief-image-failed"), "the failure is shown");
  assert.equal(shot.querySelector(".brief-image-failed").getAttribute("role"), "status");
  assert.equal(shot.querySelector(".brief-image-failed").textContent, "This image couldn't be loaded from this Core.");
  assert.equal(shot.querySelector("button.brief-image"), null, "no broken picture to open");
  assert.ok(shot.querySelector("details.brief-image-info"), "its details stay");
  assert.ok(plain.querySelector("button.brief-image img"), "the other picture is unaffected");
  assert.deepEqual(page.errors, []);
});

test("T-19 HM:B14 a kept image's box has the size Core read before the picture loads, and keeps it when it fails; one without a size, or with a side past 65,535, has the fixed box; the picture is hidden until loaded; a file only referenced draws no box; an Agent cannot claim a size", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const put = {
    op: "put", key: "shots", kind: "report", title: "Screens",
    attachments: ["sized.png", "plain.png", "ref.png", "huge.png"].map((name) => ({ name, path: `/runs/${name}` })),
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["files"] },
      files: { type: "Attachments", props: { items: [{ name: "sized.png" }, { name: "plain.png" }, { name: "ref.png" }, { name: "huge.png" }] } },
    } },
  };
  const attachments = [
    attachment("sized.png", "image", "image/png", { width: 640, height: 400 }),
    attachment("plain.png", "image", "image/png"),
    attachment("ref.png", "image", "image/png", { snapshot: false, mayChange: true, path: "/runs/ref.png", width: 640, height: 400 }),
    attachment("huge.png", "image", "image/png", { width: 70_000, height: 400 }),
  ];
  window.renderSection(readSection(page, put, { attachments }), PROJECT);
  const item = (name) => [...document.querySelectorAll(".brief-attachments > li")].find((li) => li.textContent.includes(name));
  const sized = item("sized.png").querySelector("button.brief-image");
  assert.equal(sized.dataset.shape, "known");
  assert.deepEqual([sized.style.getPropertyValue("--image-width"), sized.style.getPropertyValue("--image-height")], ["640", "400"]);
  const plain = item("plain.png").querySelector("button.brief-image");
  assert.equal(plain.dataset.shape, "unknown");
  assert.equal(plain.style.getPropertyValue("--image-width"), "", "no size is made up");
  // A side past the 65,535 Core gives a size up to: the box for an unknown size.
  const huge = item("huge.png").querySelector("button.brief-image");
  assert.deepEqual([huge.dataset.shape, huge.style.getPropertyValue("--image-width")], ["unknown", ""]);
  // Hidden until it has loaded; then shown.
  const picture = sized.querySelector("img");
  assert.ok(picture.hasAttribute("data-loading"));
  picture.dispatchEvent(new window.Event("load"));
  await until(() => !picture.hasAttribute("data-loading"), "the loaded picture is shown");
  assert.ok(plain.querySelector("img").hasAttribute("data-loading"), "the other picture still waits for its own");
  // One that cannot load says so in the same box.
  plain.querySelector("img").dispatchEvent(new window.Event("error"));
  const failed = await until(() => item("plain.png").querySelector('.brief-image[data-failed][data-shape="unknown"] .brief-image-failed[role="status"]'), "the failure in its box");
  assert.equal(failed.textContent, "This image couldn't be loaded from this Core.");
  // A file only referenced has no bytes Core read: no picture box, whatever its entry says.
  assert.equal(item("ref.png").querySelector(".brief-image"), null);
  assert.equal(item("ref.png").querySelector(".brief-attachment-note").textContent, "Not kept by Yuzuno, so there is nothing to preview.");
  // The size is Core's alone: an Agent's write cannot carry one.
  assert.throws(() => window.checkBriefSection({ ...put, attachments: [{ name: "sized.png", path: "/runs/sized.png", width: 900, height: 900 }] }));
  assert.deepEqual(page.errors, []);
});

test("Mark up on a Brief image tells Point & Fix the image shown and its card, kept at that version (T-177)", async (t) => {
  const page = mount(() => ({ text: "png-bytes" }));
  t.after(page.close);
  const { document, window } = page;
  const opened = [];
  window.pointFixOpen = (source) => opened.push(source);
  const put = {
    op: "put", key: "shots", kind: "report", title: "Screens",
    attachments: [{ name: "shot.png", path: "/runs/shot.png" }],
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["files"] },
      files: { type: "Attachments", props: { items: [{ name: "shot.png" }] } },
    } },
  };
  const at = (version, takenAt) => readSection(page, put, { version, attachments: [attachment("shot.png", "image", "image/png", { takenAt })] });
  window.renderSection(at(3, "2026-10-17T07:58:00Z"), PROJECT);
  const dialog = () => document.querySelector('[role="dialog"]');
  document.querySelector("button.brief-image").click();
  await until(dialog, "the preview opens");
  // The card is updated while the preview is open: what is shown stays.
  window.renderSection(at(4, "2026-10-17T09:00:00Z"), PROJECT);
  await until(() => document.querySelector(".brief-image img")?.getAttribute("src").endsWith("version=4"), "the card shows its new snapshot");
  assert.equal(dialog().querySelector(".input-image-dialog img").getAttribute("src"), `${base}/attachments/shots/shot.png?version=3`);
  const markUp = [...dialog().querySelectorAll("button")].find((b) => b.textContent.includes("Mark up"));
  markUp.click();
  await until(() => opened.length === 1 && !dialog(), "Point & Fix is asked to open, and the preview closes");
  const [source] = opened;
  assert.equal(source.name, "shot.png");
  assert.equal(source.ownerId, "agent-a", "the card's author is offered first");
  assert.equal(source.chooseWithoutOwner, true, "never another Agent in the author's place");
  assert.equal(source.provenance,
    `the image “shot.png” on the Home card “Screens” (project ${PROJECT}, section shots, version 3; snapshot taken 2026-10-17T07:58:00Z)`);
  const before = page.requests.length;
  const blob = await source.load(new AbortController().signal);
  assert.equal(await blob.text(), "png-bytes");
  assert.deepEqual(page.requests.slice(before).map((r) => [r.method, r.url]), [["GET", `${base}/attachments/shots/shot.png?version=3`]],
    "it reads the version shown, not the card's newer one");
  assert.ok(page.requests.every((r) => r.method === "GET"));
  delete window.pointFixOpen;
});

// YN-3: a card's kept image opens whole on Home, in the viewer its report page opens (T-20), not the report.
const cardShot = (page, size, read = {}) => readSection(page, {
  op: "put", key: "shots", kind: "report", title: "Screens",
  attachments: [{ name: "shot.png", path: "/runs/shot.png" }],
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "files", size } }, children: ["lead", "files"] },
    lead: { type: "Markdown", props: { text: "The new login screen." } },
    files: { type: "Attachments", props: { items: [{ name: "shot.png", caption: "Login screen" }] } },
  } },
}, { attachments: [attachment("shot.png", "image", "image/png")], ...read });

test("YN-3 a card's kept image opens whole in place, at the version shown, by a button the keyboard reaches; focus goes back to it", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderCard(cardShot(page, "large"), PROJECT);
  const picture = () => document.querySelector(".home-card-frame button.home-card-image-open");
  assert.ok(picture(), "the card's picture is a button");
  assert.equal(picture().getAttribute("aria-label"), "Open image shot.png");
  assert.ok(!picture().closest("[inert]") && picture().tabIndex === 0, "in the keyboard's reach: not inert");
  assert.ok(picture().querySelector("img") && picture().querySelector(".brief-image-zoom"), "the picture, and the sign that it opens larger");
  const dialog = () => document.querySelector('[role="dialog"]');
  picture().focus();
  picture().click();
  await until(dialog, "the viewer opens on Home");
  assert.equal(dialog().querySelector("h2").textContent, "Login screen");
  assert.match(dialog().textContent, /shot\.png · Snapshot /);
  assert.equal(dialog().querySelector(".input-image-dialog img").getAttribute("src"), `${base}/attachments/shots/shot.png?version=3`);
  // The card is updated while the viewer is open: what is shown stays.
  window.renderCard(cardShot(page, "large", { version: 4 }), PROJECT);
  await until(() => document.querySelector(".home-card-frame img")?.getAttribute("src").endsWith("version=4"), "the card shows its new snapshot");
  assert.equal(dialog().querySelector(".input-image-dialog img").getAttribute("src"), `${base}/attachments/shots/shot.png?version=3`);
  dialog().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !dialog(), "Escape closes it");
  assert.ok(document.activeElement === picture(), "focus returns to the picture");
  assert.ok(page.requests.every((r) => r.method === "GET"), "opening it writes nothing");
  assert.deepEqual(page.errors, []);
});

test("YN-3 a small card's kept image is a View image button that opens the same viewer, in English and Chinese; a referenced or failed one opens nothing", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const view = () => [...document.querySelectorAll("button.home-card-image-view")];
  window.renderCard(cardShot(page, "small"), PROJECT, { deck: true });
  assert.ok(!document.querySelector(".home-card-frame"), "a small card draws no frame");
  assert.equal(view().length, 1, "its image is one button away");
  assert.equal(view()[0].textContent, "View image");
  assert.equal(view()[0].getAttribute("aria-label"), "View image shot.png");
  const dialog = () => document.querySelector('[role="dialog"]');
  view()[0].focus();
  view()[0].click();
  await until(dialog, "the viewer opens");
  assert.equal(dialog().querySelector(".input-image-dialog img").getAttribute("src"), `${base}/attachments/shots/shot.png?version=3`);
  dialog().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !dialog(), "Escape closes it");
  assert.ok(document.activeElement === view()[0], "focus returns to View image");
  window.chooseLanguage("zh-Hans");
  await until(() => view()[0]?.textContent === "查看图片", "View image in Chinese");
  assert.equal(view()[0].getAttribute("aria-label"), "查看图片 shot.png");
  window.chooseLanguage("en");
  await until(() => view()[0]?.textContent === "View image", "back in English");
  // Referenced, not kept: nothing to open, small or large.
  const referenced = { attachments: [attachment("shot.png", "image", "image/png", { snapshot: false })] };
  window.renderCard(cardShot(page, "small", referenced), PROJECT, { deck: true });
  assert.equal(view().length, 0, "a referenced image has no View image");
  window.renderCard(cardShot(page, "large", referenced), PROJECT);
  assert.ok(!document.querySelector("button.home-card-image-open"), "nor a picture to open");
  // Kept, but it could not be loaded: said in its frame, nothing to open.
  window.renderCard(cardShot(page, "large", { version: 5 }), PROJECT);
  document.querySelector(".home-card-frame img").dispatchEvent(new window.Event("error"));
  await until(() => document.querySelector(".home-card-figure-unavailable"), "the failure is shown");
  assert.ok(!document.querySelector("button.home-card-image-open"), "no broken picture to open");
  assert.deepEqual(page.errors, []);
});

test("YN-3 a card whose author named no summary opens as its body does: a first paragraph, or a first block as its picture, the card sized to it (PR C2); never more", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  // The image is registered only where the body shows it, as the contract asks.
  const unnamed = (top, elements) => {
    const image = top.includes("files");
    return readSection(page, {
      op: "put", key: "plain", kind: "report", title: "Plain",
      ...(image ? { attachments: [{ name: "shot.png", path: "/runs/shot.png" }] } : {}),
      body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: top }, ...elements } },
    }, { attachments: image ? [attachment("shot.png", "image", "image/png")] : [] });
  };
  const md = (text) => ({ type: "Markdown", props: { text } });
  const metrics = { type: "Metrics", props: { items: [{ label: "Shards", value: 2 }, { label: "Lines", value: 40, unit: "k" }] } };
  const lead = () => document.querySelector(".home-summary-lead")?.textContent.trim() ?? null;
  const card = () => document.querySelector("article.home-summary-card");
  // Text first: its first paragraph, the rest left to its page.
  window.renderCard(unnamed(["text", "m"], { text: md("Two shards rebuilt.\n\nThe rest below."), m: metrics }), PROJECT, { deck: true });
  assert.equal(lead(), "Two shards rebuilt.");
  assert.equal(card().dataset.cardSize, "small");
  assert.ok(!document.querySelector(".home-card-numbers"), "only the opening: not the Metrics after it");
  // Metrics first: as a small card shows them, in big numbers.
  window.renderCard(unnamed(["m"], { m: metrics }), PROJECT, { deck: true });
  assert.equal(lead(), null);
  assert.deepEqual([...document.querySelectorAll(".home-card-numbers dd")].map((dd) => dd.textContent), ["2", "40 k"]);
  // An image first: its picture, the card sized to it (large, PR C2), the image opened from its frame.
  window.renderCard(unnamed(["files"], { files: { type: "Attachments", props: { items: [{ name: "shot.png" }] } } }), PROJECT, { deck: true });
  assert.equal(card().dataset.cardSize, "large");
  assert.equal(document.querySelectorAll("button.home-card-image-open").length, 1);
  // Nothing a card can show first: its title alone, never “No summary named”.
  window.renderCard(unnamed(["g", "text"], { g: { type: "Group", props: { title: "Runs" }, children: ["log"] }, log: md("Run 101"), text: md("Merged.") }), PROJECT, { deck: true });
  assert.equal(lead(), null);
  assert.ok(!document.querySelector(".home-card-figure-note, .home-card-numbers, .home-card-frame"), "no figure");
  assert.doesNotMatch(card().textContent, /No summary named|Run 101|Merged/);
  assert.deepEqual(page.errors, []);
});

test("live references open the app's existing panels, GitHub pages or nothing", async (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document } = page;
  const opened = [];
  page.window.renderSection(readSection(page, everything, { attachments: everythingAttachments }), PROJECT, {
    onOpenAgent: (id) => opened.push(id),
  });
  const ref = (kind) => document.querySelector(`.brief-ref[data-kind="${kind}"]`);
  assert.equal(ref("task").tagName, "BUTTON");
  ref("task").click();
  ref("job").click();
  ref("agent").click();
  assert.deepEqual(page.events, [
    { name: "yuzuno:open-task-review", detail: { taskId: "T-85" } },
    { name: "yuzuno:open-job", detail: { jobId: "job-7" } },
  ]);
  assert.deepEqual(opened, ["agent-b"]);
  assert.equal(ref("pr").getAttribute("href"), "https://github.com/owner/repo/pull/12");
  assert.equal(ref("ci").getAttribute("href"), "https://github.com/owner/repo/actions/runs/99");
  assert.equal(ref("pr").rel, "noopener noreferrer");
  assert.equal(ref("machine").tagName, "SPAN", "no Machine opener was given");
  assert.match(ref("machine").textContent, /lab_host/);
  assert.match(ref("task").textContent, /Home V1.*T-85/);

  // Without an Agent opener, an Agent is a plain chip too.
  page.window.renderSection(readSection(page, everything, { attachments: everythingAttachments }), PROJECT);
  assert.equal(ref("agent").tagName, "SPAN");
  assert.equal(page.requests.filter((r) => r.method !== "GET").length, 0);
});

test("live references show Core's current state and open with what it knows", async (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document } = page;
  const observedAt = "2026-10-17T08:01:00Z";
  const refs = {
    "task:T-85": { kind: "task", id: "T-85", found: true, title: "Home V1 slice 1", state: "doing", tone: "active", observedAt },
    "pr:owner/repo#12": { kind: "pr", id: "owner/repo#12", found: true, title: "Brief renderer", state: "merged", tone: "ok", url: "https://github.com/owner/repo/pull/12" },
    "ci:https://github.com/owner/repo/actions/runs/99": {
      kind: "ci", id: "https://github.com/owner/repo/actions/runs/99", found: true, state: "failed", tone: "attention",
      url: "https://github.com/owner/repo/actions/runs/99/attempts/2",
    },
    "review:rev-3": { kind: "review", id: "rev-3", found: true, state: "changes requested", tone: "attention", taskId: "T-85" },
    "job:job-gone": { kind: "job", id: "job-gone", found: false },
    "agent:agent-b": { kind: "agent", id: "agent-b", found: true, title: "Coder (Claude)", state: "idle", tone: "neutral" },
  };
  page.window.renderSection(readSection(page, everything, { attachments: everythingAttachments, refs }), PROJECT);
  const ref = (kind, id) => [...document.querySelectorAll(`.brief-ref[data-kind="${kind}"]`)].find((el) => !id || el.textContent.includes(id));
  const task = ref("task");
  assert.equal(task.dataset.tone, "active");
  // The Agent's short label leads (T-173); Core's current title is in the
  // tip and read out after it.
  assert.equal(task.querySelector("span").textContent, "Home V1");
  assert.equal(task.querySelector(".sr-only").textContent, ": Home V1 slice 1");
  assert.match(task.textContent, /^Home V1: Home V1 slice 1T-85doing$/, "label, current title, then the id and its state");
  assert.match((await hoverTip(page.window, task))[0], /^Task T-85: Home V1 slice 1 · as of /, "what it is, no \"Open\" (YN-44)");
  assert.equal(ref("pr").getAttribute("href"), "https://github.com/owner/repo/pull/12");
  assert.match(ref("pr").textContent, /Brief renderer.*merged/);
  assert.equal(ref("pr").querySelector("span").textContent, "Brief renderer", "without a label, the current title");
  assert.ok(!ref("pr").querySelector(".sr-only"), "no second name");
  assert.equal(ref("ci").getAttribute("href"), "https://github.com/owner/repo/actions/runs/99/attempts/2", "the run URL Core knows");
  assert.equal(ref("ci").dataset.tone, "attention");
  assert.equal(ref("agent").tagName, "SPAN", "no opener given");
  assert.match(ref("agent").textContent, /Coder: Coder \(Claude\).*idle/);
  assert.equal(ref("agent").querySelector("span").textContent, "Coder");
  // The machine has no state from Core: it shows as the Agent wrote it.
  assert.equal(ref("machine").dataset.tone, undefined);
  const gone = ref("job", "job-gone");
  assert.equal(gone.tagName, "SPAN", "nothing to open");
  assert.equal(gone.dataset.tone, "missing");
  assert.match(gone.textContent, /not found/);
  ref("review").click();
  assert.deepEqual(page.events, [
    { name: "yuzuno:open-job", detail: { source: "reviews", taskId: "T-85", reviewId: "rev-3" } },
  ]);
  assert.equal(page.requests.filter((r) => r.method !== "GET").length, 0);
});

// T-18 (Lead 2752): a chart draws only the data read for the very version
// shown. Its names, units and series come with each version: an earlier
// version's points under a newer version's axis would be another chart.
test("a chart, whole or on its card, waits for its own version's data: never the older points under newer names, and a late answer for an older version is dropped", async (t) => {
  const held = new Map();
  const answer = (version, body) => held.get(`${base}/chart/timing/t?version=${version}`)({ body });
  const page = mount((url) => (url.includes("/chart/") ? new Promise((resolve) => held.set(url, resolve)) : { status: 404, body: { error: "not found" } }));
  t.after(page.close);
  const { document } = page;
  // Each version names its own unit and series; Core reads each version's own points.
  const version = (n, unit, name) => readSection(page, {
    op: "put", key: "timing", kind: "report", title: "Step time",
    attachments: [{ name: "timing.csv", path: "/runs/timing.csv" }],
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "t", size: "wide" } }, children: ["lead", "t"] },
      lead: { type: "Markdown", props: { text: "Steps got faster." } },
      t: { type: "LineChart", props: { id: "t", title: "Step time", x: { label: "Step" }, y: { label: "Time", unit },
        data: { attachment: "timing.csv", x: "step", series: [{ name, column: "t" }] } } },
    } },
  }, { version: n, attachments: [attachment("timing.csv", "data", "text/csv")] });
  const points = (name, values) => ({ series: [{ name, points: values.map((y, i) => [i + 1, y]) }], downsampled: false, sourcePoints: values.length });
  const asked = (n) => until(() => held.has(`${base}/chart/timing/t?version=${n}`), `version ${n} asked for`);
  // The y axis's name as each place writes it: one line on the page, name and unit apart on the card.
  for (const [place, render, state, axis, seconds] of [
    ["the report's chart", (s) => page.window.renderSection(s, PROJECT), ".brief-chart-state", ".brief-chart-axis.is-y", "Time (s)"],
    ["its card", (s) => page.window.renderCard(s, PROJECT), ".home-card-chart-state", ".home-card-chart-axis.is-y", "Time(s)"],
  ]) {
    held.clear();
    const shown = () => ({ state: document.querySelector(state)?.textContent.trim() ?? null, axis: document.querySelector(axis).textContent });
    // Version 3, in milliseconds, read and drawn.
    render(version(3, "ms", "Run 3"));
    await asked(3);
    answer(3, points("Run 3", [120, 130]));
    await until(() => shown().state === null, `${place}: version 3 drawn`);
    if (place === "the report's chart") {
      const table = document.querySelector("details.brief-chart-data");
      table.open = true;
      await until(() => /120/.test(table.querySelector("tbody")?.textContent ?? ""), "version 3's table");
    }
    // Version 4, in seconds, its answer held: it waits, with version 4's names; version 3's points are not drawn.
    render(version(4, "s", "Run 4"));
    await asked(4);
    await tick(60);
    assert.deepEqual(shown(), { state: "Loading chart data…", axis: seconds }, `${place}: waits for version 4`);
    assert.ok(!/120|130/.test(document.querySelector("#root").textContent), `${place}: no value of version 3 under version 4`);
    answer(4, points("Run 4", [0.12, 0.13]));
    await until(() => shown().state === null, `${place}: version 4 drawn`);
    if (place === "the report's chart")
      await until(() => document.querySelector("details.brief-chart-data tbody")?.textContent.includes("0.12"), "version 4's table");
    // Version 5 asked, then version 6 shown before 5's answer: 5's answer, late, is dropped.
    render(version(5, "ms", "Run 5"));
    await asked(5);
    render(version(6, "s", "Run 6"));
    await asked(6);
    answer(5, points("Run 5", [999]));
    await tick(60);
    assert.equal(shown().state, "Loading chart data…", `${place}: version 5's late answer is not drawn`);
    assert.ok(!/999|0\.12/.test(document.querySelector("#root").textContent), `${place}: no value of version 4 or 5 under version 6`);
    answer(6, points("Run 6", [0.1]));
    await until(() => shown().state === null, `${place}: version 6 drawn`);
    if (place === "the report's chart") {
      await until(() => document.querySelector("details.brief-chart-data tbody")?.textContent.includes("0.1"), "version 6's table");
      assert.deepEqual([...document.querySelectorAll("details.brief-chart-data thead th")].map((th) => th.textContent), ["Step", "Run 6"]);
      assert.ok(!/999/.test(document.querySelector("details.brief-chart-data").textContent));
    }
    page.window.unmountSection();
  }
  assert.deepEqual(page.errors, []);
});

test("a history entry reads its own version's snapshots and chart data, not the live section's", async (t) => {
  // A seen report moved to history at v2; a newer live report may share its key.
  const page = mount(() => ({ status: 404, body: { error: "not found" } }));
  t.after(page.close);
  const { document } = page;
  page.window.renderSection(readSection(page, everything, { attachments: everythingAttachments, version: 2, history: true }), PROJECT);
  await until(() => page.requests.some((r) => r.url.includes("/chart/")), "the chart read");
  assert.deepEqual(page.requests.filter((r) => r.url.includes("/chart/")).map((r) => r.url), [`${base}/chart/round-12%2Freview/loss?version=2`]);
  assert.equal(document.querySelector("img").getAttribute("src"), `${base}/attachments/round-12%2Freview/grid.png?version=2`);
  const reads = page.requests.filter((r) => r.url.includes("/attachments/")).map((r) => r.url);
  assert.ok(reads.length > 0 && reads.every((url) => url.endsWith("?version=2")), JSON.stringify(reads));
});

test("legacy unread attachments do not hide a stored live or history body; a repaired reference displays the image", (t) => {
  const page = mount();
  t.after(page.close);
  const image = JSON.parse(JSON.stringify(page.window.examples.image));
  const stored = readSection(page, image, { attachments: [attachment("layout.png", "image", "image/png")] });
  const legacy = { ...stored, body: { root: "body", elements: {
    body: { type: "BriefBody", props: {}, children: ["note"] },
    note: { type: "Markdown", props: { text: "Saved before attachment-use validation." } },
  } } };
  for (const history of [false, true]) {
    page.window.renderSection({ ...legacy, history }, PROJECT);
    assert.ok(page.document.querySelector(".brief-body").textContent.includes("Saved before"));
    assert.equal(page.document.querySelector(".result-part-error"), null);
    assert.equal(page.document.querySelector("img"), null, "registration alone never silently inserts a preview");
  }
  page.window.renderSection(stored, PROJECT);
  assert.equal(page.document.querySelector("img").getAttribute("src"), `${base}/attachments/preview/layout.png?version=3`);
  assert.deepEqual(page.errors, []);
});

test("the contract's examples render without a failed part", async (t) => {
  const page = mount((url) =>
    url.endsWith("/chart/training/loss?version=3")
      ? { body: { series: [{ name: "Train", points: [[1, 3], [2, 2]] }, { name: "Validation", points: [[1, 3.2], [2, 2.4]] }], downsampled: false, sourcePoints: 4 } }
      : url.endsWith("/chart/batch-size/loss?version=3")
        ? { body: { series: [{ name: "Validation loss", points: [["baseline", 0.42], ["larger batch", 0.4]] }], downsampled: false, sourcePoints: 2 } }
        : { status: 404, body: { error: "not found" } },
  );
  t.after(page.close);
  const { document, window } = page;
  const examples = JSON.parse(JSON.stringify(window.examples));
  const expected = {
    note: ["core.25", "fixed in core.26"],
    image: ["layout.png", "Screenshot of the updated layout"],
    status: ["Validation loss", "−0.025", "+35 samples/s", "18k of 40k", "Loss"],
    result: ["213 of 214", "not in a release yet", "FAIL brief limits", "A stale version is accepted after a restart."],
    compare: ["6% lower validation loss", "One seed each", "Validation loss, lower is better"],
    tasks: ["their budget is your call", "T-13", "Ablations; the form sets their scope."],
    overview: ["Where we are", "one decision", "Run 12, larger batch", "Validation loss falls 6% once warm-up ends.", "Choose the run 13 split"],
    decision: ["The larger split costs about 6% of training data."],
    form: ["cannot tell a gap under about 5% from noise"],
    interactive: ["6% of training data", "Validation split", "Current", "Larger", "Training data", "100", "Budget", "GPU-days"],
    calculator: ["¥684", "People", "None", "15%", "Round each share up", "Total", "¥752", "Each", "¥188.10", "Back to 4, 10%"],
    flowchart: ["its own CI and one review round", "Push the branch → PR CI", "All green? → Merged (yes)", "Fix and push → PR CI"],
    timeline: ["the user installs it", "Nov 3, 2026", "Candidate cut", "Notes reviewed", "Week 46", "Planned", "Installing it", "Step 1 of 4", "Download the bundle"],
  };
  const reads = {
    note: [],
    image: [attachment("layout.png", "image", "image/png")],
    status: [attachment("loss.csv", "data", "text/csv", { caption: "Loss per step" })],
    result: [],
    compare: [attachment("runs.csv", "data", "text/csv", { caption: "Validation loss of each run" })],
    tasks: [],
    overview: [],
    decision: [],
    form: [],
    interactive: [],
    calculator: [],
    flowchart: [],
    timeline: [],
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(examples).sort(), "every example is checked");
  for (const [name, put] of Object.entries(examples)) {
    window.renderSection(readSection(page, put, { attachments: reads[name] }), PROJECT);
    const body = document.querySelector(".brief-body");
    for (const text of expected[name]) assert.ok(body.textContent.includes(text), `${name}: ${text}`);
    assert.equal(document.querySelector(".result-part-error"), null, `${name}: no failed part`);
  }
  // The status example's chart reads its attachment by element id.
  window.renderSection(readSection(page, examples.status, { attachments: reads.status }), PROJECT);
  await until(() => document.querySelector(".brief-chart-plot") && !document.querySelector(".brief-chart-state"), "the status chart");
  assert.ok(page.requests.some((r) => r.url === `${base}/chart/training/loss?version=3`));
  assert.ok(!/Downsampled/.test(document.body.textContent), "not downsampled, so no note");
  assert.equal(document.querySelector(".brief-chart-points").textContent, "4 points");
});

test("columns sit side by side at their widths, and a tone tints its group", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(readSection(page, JSON.parse(JSON.stringify(window.examples.overview))), PROJECT);
  const root = document.querySelector(".brief-root");
  const [summary, columns] = root.children;
  assert.equal(summary.dataset.tone, "accent", "the summary across the top is tinted");
  assert.equal(summary.querySelector("h4").textContent, "Where we are");
  assert.ok(columns.classList.contains("brief-columns"));
  assert.equal(columns.style.getPropertyValue("--brief-columns"), "minmax(0, 3fr) minmax(0, 2fr)");
  assert.deepEqual([...columns.children].map((column) => column.querySelector("h4").textContent), ["Progress and findings", "Decisions and Jobs"]);
  assert.deepEqual([...columns.children].map((column) => column.dataset.tone), [undefined, undefined], "plain without a tone");
  // Equal columns without widths; a group may leave out its title.
  const put = {
    op: "put", key: "plain", kind: "report", title: "Plain",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["split"] },
      split: { type: "Columns", props: {}, children: ["left", "right"] },
      left: { type: "Group", props: { tone: "muted" }, children: ["a"] },
      right: { type: "Group", props: { tone: "plain" }, children: ["b"] },
      a: { type: "Markdown", props: { text: "Left" } },
      b: { type: "Markdown", props: { text: "Right" } },
    } },
  };
  window.renderSection(readSection(page, put), PROJECT);
  const split = document.querySelector(".brief-columns");
  assert.equal(split.style.getPropertyValue("--brief-columns"), "", "equal columns come from the stylesheet");
  assert.deepEqual([...split.children].map((column) => [column.dataset.tone, column.querySelector("h4"), column.textContent.trim()]), [["muted", null, "Left"], [undefined, null, "Right"]]);
  assert.equal(document.querySelector(".result-part-error"), null);
  assert.deepEqual(page.errors, []);
});

test("a long row of attachments shows the first few and the rest on request, focus kept (T-173)", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const shots = (count) => Array.from({ length: count }, (_, index) => `shot-${index + 1}.png`);
  const put = (names) => ({
    op: "put", key: "shots", kind: "report", title: "Screens",
    attachments: names.map((name) => ({ name, path: `/runs/12/${name}` })),
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["files"] },
      files: { type: "Attachments", props: { items: names.map((name) => ({ name, caption: `Before/after ${name}` })) } },
    } },
  });
  const show = (names) =>
    window.renderSection(readSection(page, put(names), { attachments: names.map((name) => attachment(name, "image", "image/png")) }), PROJECT);
  const listed = () => [...document.querySelectorAll(".brief-attachments > li")].map((li) => li.textContent.match(/shot-\d+\.png/)?.[0]);
  show(shots(6));
  assert.equal(listed().length, 6, "two more than the first four show at once");
  assert.ok(!document.querySelector(".brief-attachments-more"), "no toggle for six");
  show(shots(12));
  assert.deepEqual(listed(), shots(4));
  const more = document.querySelector(".brief-attachments-more");
  assert.equal(more.textContent, "Show all 12 attachments");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  more.focus();
  more.click();
  await tick();
  assert.deepEqual(listed(), shots(12));
  assert.ok(document.activeElement === more, "the toggle keeps focus");
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(more.textContent, "Show the first 4");
  more.click();
  await tick();
  assert.deepEqual(listed(), shots(4));
  assert.equal(page.requests.filter((r) => r.method !== "GET").length, 0);
  assert.deepEqual(page.errors, []);
});

// T-195: two Workspaces at one address can hold the same project and section
// ids, with the same table. How one window sorts and filters that table is
// not the other's, and a Workspace arriving under a mounted body must not
// let the one before's view be saved under this one's key.
test("a table's view belongs to the Workspace it was set in", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const body = {
    op: "put", key: KEY, kind: "report", title: "Runs",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["runs"] },
      runs: { type: "Table", props: { id: "runs", title: "Runs",
        columns: [{ key: "run", label: "Run" }, { key: "score", label: "Score" }],
        rows: [["11", 0.71], ["12", 0.74], ["21", 0.69]].map(([run, score]) => ({ id: `r${run}`, cells: { run, score } })) } },
    } },
  };
  const section = readSection(page, body, { version: 3 });
  const show = (workspaceId) => {
    window.unmountSection();
    window.renderSection(section, PROJECT, {}, workspaceId);
  };
  const filter = () => document.querySelector('input[aria-label="Filter Runs"]');
  const shown = () => [...document.querySelectorAll(".result-table-scroll tbody tr")].map((row) => row.cells[0].textContent);
  const type = (value) => {
    const input = filter();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const viewKey = (workspaceId) => `yuzuno.result-view.brief:${workspaceId}:${PROJECT}:${KEY}#runs`;

  show("ws-here");
  type("2");
  await until(() => filter().value === "2" && shown().length === 2, "filtered here");
  assert.equal(JSON.parse(window.localStorage.getItem(viewKey("ws-here"))).views.runs.filter, "2");

  // The other Workspace, same project, same section, same table.
  show("ws-there");
  assert.equal(filter().value, "", "it opens as the body was published");
  assert.equal(shown().length, 3);
  type("1");
  await until(() => filter().value === "1", "filtered there");
  assert.equal(JSON.parse(window.localStorage.getItem(viewKey("ws-there"))).views.runs.filter, "1");
  assert.equal(
    JSON.parse(window.localStorage.getItem(viewKey("ws-here"))).views.runs.filter,
    "2",
    "and the first Workspace's view is still its own",
  );

  // The Workspace arrives under a body already on screen: its own view is
  // read, and a change made then is saved under its key, not the other's.
  window.unmountSection();
  window.renderSection(section, PROJECT, {}, "");
  assert.equal(filter().value, "", "with no Workspace, no Workspace's view");
  window.renderSection(section, PROJECT, {}, "ws-here");
  await until(() => filter().value === "2", "the Workspace's own view is read in place");
  type("12");
  await until(() => filter().value === "12", "changed here");
  assert.equal(JSON.parse(window.localStorage.getItem(viewKey("ws-here"))).views.runs.filter, "12");
  assert.equal(
    JSON.parse(window.localStorage.getItem(viewKey("ws-there"))).views.runs.filter,
    "1",
    "the other Workspace's view was not written over",
  );
  assert.equal(window.localStorage.getItem(viewKey("")), null, "and nothing was saved for no Workspace");
  assert.deepEqual(page.errors, []);
});

test("a table's own words follow the UI language; titles, labels and cells stay as written", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const section = readSection(page, {
    op: "put", key: KEY, kind: "report", title: "Runs",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["runs"] },
      runs: { type: "Table", props: { id: "runs", title: "运行",
        columns: [{ key: "run", label: "名称" }, { key: "score", label: "得分" }],
        rows: [["甲", 60], ["乙", 67], ["丙", 74]].map(([run, score], i) => ({ id: `r${i}`, cells: { run, score } })) } },
    } },
  }, { version: 1 });
  const input = () => document.querySelector(".result-filter input");
  // On Home a count shows only when it says something: here, once filtered (T-9).
  const caption = () => document.querySelector(".result-table-caption span")?.textContent ?? null;
  const type = (value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
    input().dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  window.chooseLanguage("zh-Hans");
  window.renderSection(section, PROJECT, {}, "ws");
  await until(() => input()?.placeholder === "筛选…", "the Chinese filter");
  assert.equal(input().getAttribute("aria-label"), "筛选运行");
  assert.equal(document.querySelector(".result-table-scroll").getAttribute("aria-label"), "运行表格");
  assert.equal(caption(), null, "every row is shown: no count");
  assert.deepEqual([...document.querySelectorAll(".result-table-scroll thead th")].map((th) => th.textContent), ["名称", "得分"]);
  type("没有");
  await until(() => document.querySelector(".result-empty")?.textContent === "没有匹配的行，换个筛选词试试。", "no matches, in Chinese");
  assert.equal(caption(), "0 / 3 行");
  type("");
  await until(() => caption() === null, "every row again: no count");
  window.chooseLanguage("en");
  await until(() => input().placeholder === "Filter…", "back in English");
  assert.equal(input().getAttribute("aria-label"), "Filter 运行");
  type("甲");
  await until(() => caption() === "1 of 3 rows", "the count in English");
  window.unmountSection();
  assert.deepEqual(page.errors, []);
});

test("T-9 a long Home table shows its first rows and how many; sort and filter read every row; Show all keeps the filter and focus", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  // 14 runs: the lowest and highest scores come after the first eight rows.
  const rows = Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, cells: {
    run: `exp-${String(i + 1).padStart(3, "0")}`, model: i < 12 ? "base" : "large", code: String(i + 1).padStart(3, "0"),
    score: i === 10 ? 1 : i === 12 ? 99 : 50 + i,
  } }));
  const section = readSection(page, {
    op: "put", key: KEY, kind: "report", title: "Runs",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["runs"] },
      runs: { type: "Table", props: { id: "runs", title: "Runs",
        columns: [{ key: "run", label: "Run" }, { key: "model", label: "Model" }, { key: "code", label: "Code" }, { key: "score", label: "Score" }], rows } },
    } },
  }, { version: 1 });
  const shown = () => [...document.querySelectorAll(".result-table-scroll tbody tr")].map((row) => row.cells[0].textContent);
  const caption = () => document.querySelector(".result-table-caption span")?.textContent ?? null;
  const more = () => document.querySelector("button.result-table-more");
  const input = () => document.querySelector(".result-filter input");
  const type = (value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
    input().dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  window.renderSection(section, PROJECT, {}, "ws", "high");
  await until(() => shown().length === 8, "the first eight rows");
  assert.deepEqual(shown(), rows.slice(0, 8).map((row) => row.cells.run));
  assert.equal(caption(), "8 of 14 rows", "the rows not shown are counted");
  assert.equal(more().textContent, "Show all 14 rows");
  assert.equal(more().getAttribute("aria-expanded"), "false");
  // Numbers line up only where every value is a number: not run names, not zero-padded codes.
  assert.deepEqual([...document.querySelectorAll(".result-table-scroll thead th")].map((th) => [th.textContent, th.dataset.numeric === "true"]),
    [["Run", false], ["Model", false], ["Code", false], ["Score", true]]);
  assert.equal(document.querySelector(".result-table-scroll tbody td[data-primary]").textContent, "exp-001");
  // Sorting reads every row, then shows the first ones.
  [...document.querySelectorAll(".result-table-scroll th button")].find((b) => b.textContent === "Score").click();
  const sorted = await until(() => document.querySelector(".result-table-scroll th[aria-sort]:not([aria-sort=none])"), "sorted by score");
  assert.equal(shown()[0], sorted.getAttribute("aria-sort") === "descending" ? "exp-013" : "exp-011", "the extreme from beyond the first eight");
  assert.equal(shown().length, 8);
  // So does the filter; twelve match, eight are shown, the button says how many there are.
  type("base");
  await until(() => caption() === "8 of 14 rows" && more()?.textContent === "Show all 12 rows", "the filtered rows, folded");
  more().focus();
  more().click();
  await until(() => shown().length === 12, "every matching row");
  assert.equal(more().textContent, "Show fewer");
  assert.equal(more().getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, more(), "focus stays on the button");
  assert.equal(input().value, "base", "the filter is kept");
  assert.equal(caption(), "12 of 14 rows");
  more().click();
  await until(() => shown().length === 8, "folded again");
  assert.equal(document.activeElement, more(), "focus stays on the button");
  assert.equal(input().value, "base");
  // A filter that leaves only a few rows needs no button.
  type("exp-01");
  await until(() => shown().length === 5 && !more(), "the five matches, without Show all");
  assert.deepEqual([...shown()].sort(), ["exp-010", "exp-011", "exp-012", "exp-013", "exp-014"]);
  // Low density shows fewer rows first.
  type("");
  window.renderSection(section, PROJECT, {}, "ws", "low");
  await until(() => shown().length === 5 && more()?.textContent === "Show all 14 rows", "five rows at low density");
  window.unmountSection();
  assert.deepEqual(page.errors, []);
});

test("a table keeps its filter and sort when another block is edited, not when it is", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const table = (rows) => ({
    type: "Table",
    props: { id: "runs", title: "Runs", columns: [{ key: "run", label: "Run" }, { key: "score", label: "Score" }], rows: rows.map(([run, score]) => ({ id: `r${run}`, cells: { run, score } })) },
  });
  const put = (note, rows) => ({
    op: "put", key: KEY, kind: "report", title: "Runs",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["note", "runs"] },
      note: { type: "Markdown", props: { text: note } },
      runs: table(rows),
    } },
  });
  const rows = [["11", 0.71], ["12", 0.74], ["21", 0.69]];
  const show = (note, list, version) => {
    window.unmountSection();
    window.renderSection(readSection(page, put(note, list), { version }), PROJECT);
  };
  const filter = () => document.querySelector('input[aria-label="Filter Runs"]');
  const shown = () => [...document.querySelectorAll(".result-table-scroll tbody tr")].map((row) => row.cells[0].textContent);
  show("Two runs so far.", rows, 3);
  const input = filter();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "2");
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await until(() => filter().value === "2" && shown().length === 2, "the filter applied");
  document.querySelector(".result-table-scroll th button").click();
  await until(() => document.querySelector('.result-table-scroll th[aria-sort="ascending"]'), "sorted");
  const saved = JSON.parse(window.localStorage.getItem(`yuzuno.result-view.brief::${PROJECT}:${KEY}#runs`));
  assert.equal(saved.views.runs.filter, "2");
  // The Agent edits the note: the table, and so its view, is as it was.
  show("Three runs; run 12 leads.", rows, 4);
  assert.equal(document.querySelector(".brief-markdown").textContent.trim(), "Three runs; run 12 leads.");
  assert.equal(filter().value, "2", "the filter is kept");
  assert.deepEqual(shown(), ["12", "21"]);
  assert.ok(document.querySelector('.result-table-scroll th[aria-sort="ascending"]'), "the sort is kept");
  // The Agent changes the table itself: its rows may not match the old view.
  show("Three runs; run 12 leads.", [...rows, ["13", 0.8]], 5);
  assert.equal(filter().value, "", "a changed table starts unfiltered");
  assert.equal(shown().length, 4);
  assert.equal(document.querySelector('.result-table-scroll th[aria-sort="ascending"]'), null);
  assert.deepEqual(page.errors, []);
});

test("while Home stays mounted, an update drops only a changed or removed table's view and redraws only changed blocks", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const table = (id, title, columns, rows) => ({
    type: "Table",
    props: { id, title, columns: columns.map((key) => ({ key, label: key })), rows: rows.map((cells, i) => ({ id: `${id}${i}`, cells })) },
  });
  const runs = (extra = []) => table("runs", "Runs", ["run", "score"], [{ run: "11", score: 0.71 }, { run: "12", score: 0.74 }, { run: "21", score: 0.69 }, ...extra]);
  const costs = table("costs", "Costs", ["item", "usd"], [{ item: "gpu", usd: 9 }, { item: "disk", usd: 2 }]);
  const put = (note, elements, children = ["note", "runs", "costs"]) => ({
    op: "put", key: KEY, kind: "report", title: "Runs",
    body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children }, note: { type: "Markdown", props: { text: note } }, ...elements } },
  });
  // Each update is a new render of the same mounted body, as a live update is.
  const show = (put, version) => window.renderSection(readSection(page, put, { version }), PROJECT);
  const filter = (title) => document.querySelector(`input[aria-label="Filter ${title}"]`);
  const sorted = (title) => document.querySelector(`section[aria-label="${title}"] th[aria-sort="ascending"]`);
  const type = (input, text) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  show(put("Two tables.", { runs: runs(), costs }), 3);
  type(filter("Runs"), "2");
  document.querySelector('section[aria-label="Costs"] th button').click();
  await until(() => filter("Runs").value === "2" && sorted("Costs"), "both views set");
  const kept = { runs: document.querySelector('section[aria-label="Runs"]'), costs: document.querySelector('section[aria-label="Costs"]') };
  // Only the note changed: both views stay, and the tables keep their DOM.
  show(put("Run 12 leads.", { runs: runs(), costs }), 4);
  assert.equal(document.querySelector(".brief-markdown").textContent.trim(), "Run 12 leads.");
  assert.equal(filter("Runs").value, "2");
  assert.ok(sorted("Costs"));
  assert.equal(document.querySelector('section[aria-label="Runs"]'), kept.runs, "an unchanged table is not redrawn");
  assert.equal(document.querySelector('section[aria-label="Costs"]'), kept.costs);
  const note = document.querySelector(".brief-markdown");
  // The runs table changed: its rows may not match the old filter; costs keeps its sort.
  show(put("Run 12 leads.", { runs: runs([{ run: "13", score: 0.8 }]), costs }), 5);
  assert.equal(filter("Runs").value, "", "a changed table starts unfiltered");
  assert.ok(sorted("Costs"), "the other table keeps its sort");
  assert.equal(document.querySelector(".brief-markdown"), note, "an unchanged block keeps its DOM node");
  // The costs table is removed and comes back: it does not inherit its old view.
  show(put("Run 12 leads.", { runs: runs([{ run: "13", score: 0.8 }]) }, ["note", "runs"]), 6);
  assert.equal(document.querySelector('section[aria-label="Costs"]'), null);
  show(put("Run 12 leads.", { runs: runs([{ run: "13", score: 0.8 }]), costs }), 7);
  assert.equal(sorted("Costs"), null, "a removed table's view is gone");
  assert.deepEqual(page.errors, []);
});

test("a broken body or part stays local, and a failed chart read keeps its place", async (t) => {
  const page = mount(() => ({ status: 500, body: { error: "chart store unavailable" } }));
  t.after(page.close);
  const { document, window } = page;
  const base = readSection(page, everything, { attachments: everythingAttachments });
  window.renderSection({ ...base, body: { root: "x", elements: { x: { type: "Markdown", props: { text: "no root" } } } } }, PROJECT);
  assert.match(document.body.textContent, /This section couldn't be displayed\./);
  const body = structuredClone(base.body);
  body.elements.checks.type = "Video";
  window.renderSection({ ...base, body }, PROJECT);
  assert.equal(document.querySelectorAll(".result-part-error").length, 1, "only the unknown part");
  assert.ok(document.querySelector(".brief-markdown"), "the rest still shows");
  await until(() => /Chart data couldn't be read\. chart store unavailable/.test(document.body.textContent), "the chart error");
  const state = document.querySelectorAll(".brief-chart")[3].querySelector(".brief-chart-plot > .brief-chart-state");
  assert.ok(state, "the error sits inside the fixed-height plot");
  await until(() => /Preview unavailable/.test(document.body.textContent), "the preview error");
  assert.ok(document.querySelector("p.brief-preview-frame"), "the failed preview keeps its frame");
});

// T-9: the same body at Home's two densities, chosen per device. Low shows a
// card's main point, high every field and row; nothing is dropped silently,
// nothing unknown becomes 0, and switching keeps the section's state.
const dense = (elements, children, attachments = []) => ({
  op: "put",
  key: KEY,
  kind: "report",
  title: "Density",
  attachments: attachments.map((name) => ({ name, path: `/runs/${name}` })),
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children }, ...elements } },
});

test("T-9 low density: a plan is a short timeline from just before its current step, a blocked step never folded; high shows every step", async (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document, window } = page;
  const steps = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`,
    text: `Step ${i + 1}\nWhy step ${i + 1}`,
    state: i < 3 ? "done" : i === 3 ? "doing" : i === 9 ? "blocked" : "todo",
  }));
  const section = readSection(page, dense({ plan: { type: "Plan", props: { title: "Plan", steps } } }, ["plan"]));
  const items = () => [...document.querySelectorAll(".brief-plan li")];
  window.renderSection(section, PROJECT, {}, "", "low");
  assert.equal(document.querySelector(".brief-plan").dataset.density, "low");
  assert.deepEqual(items().map((li) => li.querySelector("strong").textContent), ["Step 3", "Step 4", "Step 5", "Step 6", "Step 7", "Step 10"]);
  assert.deepEqual(items().map((li) => li.value), [3, 4, 5, 6, 7, 10], "numbered as in the whole plan");
  assert.deepEqual(items().map((li) => li.dataset.gap), [undefined, undefined, undefined, undefined, undefined, "true"], "the blocked step after a gap");
  assert.equal(items()[5].querySelector(".brief-chip").textContent, "Blocked");
  assert.equal(items()[5].querySelector(".brief-plan-more").textContent, "Why step 10");
  assert.equal(items()[1].querySelector(".brief-plan-more").textContent, "Why step 4");
  assert.equal(items()[1].querySelector(".brief-chip").textContent, "Doing");
  assert.match(document.querySelector(".brief-plan header span").textContent, /3 of 10 done/);
  const all = document.querySelector(".brief-plan-all");
  assert.equal(all.textContent, "Show all 10 steps");
  all.click();
  await until(() => items().length === 10, "every step after Show all");
  assert.equal(items().filter((li) => li.dataset.gap).length, 0, "no gap once every step shows");
  window.renderSection(section, PROJECT, {}, "", "high");
  assert.equal(document.querySelector(".brief-plan").dataset.density, "high");
  assert.equal(items().length, 10);
  assert.ok(!document.querySelector(".brief-plan-all"), "high has nothing folded");
  assert.match(document.querySelector(".brief-plan header span").textContent, /3 of 10 done/, "the same count in both");
  assert.deepEqual(page.errors, []);
});

test("T-9 low density: metrics lead with the first value, count the rest and show them on request; units and unknown values stay as written", async (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document, window } = page;
  const items = [
    { label: "Memory", value: 86, unit: "MiB", previous: 90, detail: "latest sample" },
    { label: "Threads", value: 39 },
    { label: "Reads", value: "—" },
    { label: "Held", value: 0 },
    { label: "Failed", value: 1 },
    { label: "Gap", value: "unknown" },
  ];
  const section = readSection(page, dense({ m: { type: "Metrics", props: { items } } }, ["m"]));
  const metrics = () => [...document.querySelectorAll(".brief-metrics > div")];
  const value = (label) => metrics().find((div) => div.querySelector("dt").textContent === label)?.querySelector("dd").textContent;
  window.renderSection(section, PROJECT, {}, "", "low");
  assert.equal(metrics().length, 4, "the first and three more");
  assert.equal(document.querySelectorAll(".brief-metrics > [data-lead]").length, 1);
  assert.equal(metrics()[0].querySelector("dd").textContent, "86MiB");
  assert.match(metrics()[0].textContent, /latest sample/);
  assert.match(metrics()[0].querySelector(".brief-delta").textContent, /−4 MiB/, "the comparison keeps its unit");
  assert.equal(value("Reads"), "—", "not 0");
  const more = document.querySelector(".brief-metrics-more");
  assert.equal(more.tagName, "BUTTON");
  assert.equal(more.textContent, "Show 2 more");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  more.click();
  await until(() => metrics().length === 6, "every metric after Show 2 more");
  assert.equal(value("Gap"), "unknown");
  assert.equal(document.querySelector(".brief-metrics-more").textContent, "Show fewer");
  assert.equal(document.querySelector(".brief-metrics-more").getAttribute("aria-expanded"), "true");
  window.renderSection(section, PROJECT, {}, "", "high");
  assert.equal(metrics().length, 6);
  assert.ok(!document.querySelector(".brief-metrics-more"), "high has nothing folded");
  assert.equal(value("Gap"), "unknown");
  assert.equal(value("Held"), "0", "a real 0 is shown as 0");
  assert.equal(metrics()[0].querySelector("dd").textContent, "86MiB", "the same value in both");
  assert.match(metrics()[0].querySelector(".brief-delta").textContent, /−4 MiB/);
  assert.deepEqual(page.errors, []);
});

test("T-9 low density: a line chart is a compact trend, other charts as before; an empty series says so, never 0", async (t) => {
  // A body can't write an empty series (Core refuses it); a data file can
  // still have no points.
  const page = mount((url) =>
    url === `${base}/chart/${encodedKey}/empty?version=3`
      ? { body: { series: [{ name: "RSS", points: [] }], x: { label: "Time" }, y: { label: "Memory", unit: "MiB" }, downsampled: false, sourcePoints: 0 } }
      : respond(url),
  );
  t.after(page.close);
  const { document, window } = page;
  const section = readSection(page, dense({
    trend: {
      type: "LineChart",
      props: { id: "trend", title: "trend", x: { label: "Time" }, y: { label: "Memory", unit: "MiB" }, series: [{ name: "RSS", points: [[1, 80], [2, 86]] }] },
    },
    empty: {
      type: "LineChart",
      props: { id: "empty", title: "empty", x: { label: "Time" }, y: { label: "Memory", unit: "MiB" }, data: { attachment: "rss.csv", x: "t", series: [{ name: "RSS", column: "rss" }] } },
    },
    bars: { type: "BarChart", props: { id: "bars", title: "bars", x: { label: "Run" }, y: { label: "Cost" }, series: [{ name: "A", points: [["r1", 4]] }] } },
  }, ["trend", "empty", "bars"], ["rss.csv"]), { attachments: [attachment("rss.csv", "data", "text/csv")] });
  const chart = (title) => document.querySelector(`.brief-chart[aria-label="${title}"]`);
  const state = () => chart("empty").querySelector(".brief-chart-state")?.textContent;
  window.renderSection(section, PROJECT, {}, "", "low");
  assert.equal(chart("trend").dataset.density, "low");
  assert.equal(chart("bars").dataset.density, undefined, "bars keep their one form");
  await until(() => state() === "No points to show.", "the empty series says so");
  assert.match(chart("empty").querySelector(".brief-chart-foot").textContent, /Data: rss\.csv · snapshot/, "its source stays");
  assert.ok(chart("trend").querySelector("details.brief-chart-data"), "the values stay reachable in the data table");
  window.renderSection(section, PROJECT, {}, "", "high");
  assert.equal(chart("trend").dataset.density, undefined);
  await until(() => state() === "No points to show.", "the same in high density");
  assert.deepEqual(page.errors, []);
});

test("T-9 low density: attachments lead with the first deliverable; the rest are one click away", (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document, window } = page;
  const names = ["one.png", "two.png", "three.png"];
  const put = dense({ files: { type: "Attachments", props: { items: names.map((name) => ({ name, caption: `Shot ${name}` })) } } }, ["files"], names);
  const section = readSection(page, put, { attachments: names.map((name) => attachment(name, "image", "image/png")) });
  // A kept picture names its file in its folded details (T-9); the others in their header.
  const shown = () => [...document.querySelectorAll(".brief-attachments > li")].map((li) => (li.querySelector("strong") || li.querySelector(".brief-image-info dd")).textContent);
  window.renderSection(section, PROJECT, {}, "", "low");
  assert.deepEqual(shown(), ["one.png"]);
  assert.equal(document.querySelector(".brief-attachments-block").dataset.density, "low");
  assert.equal(document.querySelector(".brief-attachments-more").textContent, "Show all 3 attachments");
  assert.match(document.querySelector(".brief-attachment-caption").textContent, /Shot one\.png/);
  window.renderSection(section, PROJECT, {}, "", "high");
  assert.deepEqual(shown(), names);
  assert.ok(!document.querySelector(".brief-attachments-more"), "high has nothing folded");
  assert.deepEqual(page.errors, []);
});

test("T-9 low density never folds away an attachment that warns: gone, not kept or may change", async (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document, window } = page;
  const names = ["one.png", "two.png", "moving.log", "ref.png", "gone.png"];
  const put = dense({ files: { type: "Attachments", props: { items: names.map((name) => ({ name })) } } }, ["files"], names);
  const section = readSection(page, put, {
    attachments: [
      attachment("one.png", "image", "image/png"),
      attachment("two.png", "image", "image/png"),
      attachment("moving.log", "text", "text/plain", { mayChange: true }),
      attachment("ref.png", "image", "image/png", { snapshot: false, path: "/runs/ref.png" }),
    ],
  });
  // A kept picture names its file in its folded details (T-9); the others in their header.
  const shown = () => [...document.querySelectorAll(".brief-attachments > li")].map((li) => (li.querySelector("strong") || li.querySelector(".brief-image-info dd")).textContent);
  window.renderSection(section, PROJECT, {}, "", "low");
  assert.deepEqual(shown(), ["one.png", "moving.log", "ref.png", "gone.png"], "only the plain one folds");
  const block = document.querySelector(".brief-attachments-block");
  assert.match(block.textContent, /Not kept by Yuzuno/);
  assert.match(block.textContent, /May have changed/);
  assert.match(block.textContent, /no longer part of the section/);
  const button = document.querySelector(".brief-attachments-more");
  assert.equal(button.textContent, "Show all 5 attachments");
  button.click();
  await until(() => shown().length === 5, "every attachment after Show all");
  assert.deepEqual(shown(), names);
  assert.equal(document.querySelector(".brief-attachments-more").textContent, "Show fewer");
  assert.deepEqual(page.errors, []);
});

test("T-9 switching density keeps the section's state: the same nodes, a table's filter, an open data table and focus", async (t) => {
  const page = mount(respond);
  t.after(page.close);
  const { document, window } = page;
  const section = readSection(page, dense({
    note: { type: "Markdown", props: { text: "Runs so far." } },
    runs: {
      type: "Table",
      props: {
        id: "runs",
        title: "Runs",
        columns: [{ key: "run", label: "Run" }],
        rows: [{ id: "r1", cells: { run: "1" } }, { id: "r2", cells: { run: "2" } }, { id: "r12", cells: { run: "12" } }],
      },
    },
    trend: { type: "LineChart", props: { id: "trend", title: "Trend", x: { label: "Run" }, y: { label: "Score" }, series: [{ name: "S", points: [[1, 2], [2, 3]] }] } },
  }, ["note", "runs", "trend"]));
  window.renderSection(section, PROJECT, {}, "ws-density", "high");
  const body = document.querySelector(".brief-body");
  const note = document.querySelector(".brief-markdown");
  const filter = () => document.querySelector('input[aria-label="Filter Runs"]');
  const input = filter();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "2");
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await until(() => document.querySelectorAll(".result-table-scroll tbody tr").length === 2, "the filtered table");
  const data = document.querySelector("details.brief-chart-data");
  data.open = true;
  await until(() => data.querySelector("tbody tr"), "the opened data table");
  input.focus();
  window.renderSection(section, PROJECT, {}, "ws-density", "low");
  assert.ok(document.querySelector(".brief-body") === body, "the section is not drawn again");
  assert.ok(document.querySelector(".brief-markdown") === note, "an unchanged block keeps its node");
  assert.ok(filter() === input, "the filter input is the same node");
  assert.equal(filter().value, "2", "the filter stays");
  assert.equal(document.querySelectorAll(".result-table-scroll tbody tr").length, 2);
  assert.ok(document.querySelector("details.brief-chart-data") === data, "the data table is the same node");
  assert.ok(data.open, "the data table stays open");
  assert.ok(document.activeElement === input, "focus stays where it was");
  assert.deepEqual(page.errors, []);
});

// YN-16 S1: inputs, the variables they write and the blocks they show, on a
// card and on a page. Bodies accepted by the real contract; no Core.

const recipe = (extra = {}) => ({
  op: "put", key: "scones", kind: "report", title: "Scones",
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "try", size: "wide" } }, children: ["lead", "try", "more"] },
    lead: { type: "Markdown", props: { text: "Scales with the guests." } },
    try: { type: "Group", props: {}, children: ["guests", "vegan", "many"] },
    guests: { type: "NumberInput", props: { name: "guests", label: "Guests", value: 4, min: 1, max: 12, unit: "people", control: "both", detail: "Every amount scales." } },
    vegan: { type: "Switch", props: { name: "vegan", label: "Vegan", value: false } },
    many: { type: "Markdown", visible: { $state: "/guests", gte: 6 }, props: { text: "Bake on two trays." } },
    more: { type: "Group", props: { title: "Method" }, children: ["view", "oil", "side", "top"] },
    view: { type: "Segmented", props: { name: "view", label: "View", value: "side", options: [{ value: "side", label: "Side" }, { value: "top", label: "Top" }, { value: "cut", label: "Cut" }] } },
    oil: { type: "Markdown", visible: { $state: "/vegan" }, props: { text: "Use olive oil instead of butter." } },
    side: { type: "Markdown", visible: { $state: "/view", eq: "side" }, props: { text: "From the side: risen." } },
    top: { type: "Markdown", visible: { $state: "/view", neq: "side" }, props: { text: "From above: golden." } },
  } },
  ...extra,
});
const setField = (window, field, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const key = (window, target, name) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

test("YN-16 inputs set their variables and the blocks that read them follow, requesting nothing", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(readSection(page, recipe()), PROJECT);
  const text = () => document.querySelector(".brief-body").textContent;
  const field = () => document.querySelector(".brief-number-field");
  const [minus, plus] = [...document.querySelectorAll(".brief-step")];
  assert.equal(document.querySelector(".result-part-error"), null, "no part failed");
  // Starting values: 4 guests, not vegan, the side view; the blocks for other values are not there at all.
  assert.equal(field().value, "4");
  assert.equal(field().getAttribute("role"), "spinbutton");
  assert.equal(field().getAttribute("aria-valuetext"), "4 people");
  assert.equal(document.querySelector(".brief-number label").textContent, "Guests");
  assert.equal(minus.getAttribute("aria-label"), "Decrease Guests");
  assert.ok(/From the side/.test(text()) && !/two trays|olive oil|From above/.test(text()), text());
  // The stepper and the slider write the same variable; the block for 6 or more shows.
  plus.click();
  plus.click();
  await until(() => field().value === "6", "two steps up");
  assert.equal(document.querySelector(".brief-slider").value, "6");
  assert.ok(/Bake on two trays/.test(text()), "shown from 6 guests");
  setField(window, document.querySelector(".brief-slider"), "2");
  await until(() => field().value === "2", "the slider sets it");
  assert.ok(!/two trays/.test(text()), "hidden again under 6");
  // Keys step and jump; the ends disable their button and nothing passes them.
  key(window, field(), "ArrowUp");
  await until(() => field().value === "3", "ArrowUp");
  key(window, field(), "End");
  await until(() => field().value === "12", "End");
  assert.ok(plus.disabled && !minus.disabled, "+ is off at the max");
  plus.click();
  assert.equal(field().value, "12");
  key(window, field(), "Home");
  await until(() => field().value === "1" && minus.disabled, "Home");
  // Typed text: a number is stepped into the range when the reader is done; anything else goes back.
  field().focus();
  setField(window, field(), "abc");
  assert.equal(field().value, "abc", "the draft is kept while typing");
  field().blur();
  await until(() => field().value === "1", "not a number: the value stays");
  field().focus();
  setField(window, field(), "４０");
  key(window, field(), "Enter");
  await until(() => field().value === "12", "a full-width number past the max is kept at the max");
  // The switch: its state, said and drawn; its block shows.
  const toggle = document.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(document.querySelector(".brief-switch-state").textContent, "Off");
  document.querySelector(".brief-switch-label").click();
  await until(() => toggle.getAttribute("aria-checked") === "true", "its label turns it on");
  assert.equal(document.querySelector(".brief-switch-state").textContent, "On");
  assert.ok(/olive oil/.test(text()));
  // The segments: one choice, arrows move it and the focus, round the ends.
  const segments = () => [...document.querySelectorAll('[role="radio"]')];
  assert.deepEqual(segments().map((one) => [one.textContent, one.getAttribute("aria-checked"), one.tabIndex]), [["Side", "true", 0], ["Top", "false", -1], ["Cut", "false", -1]]);
  segments()[0].focus();
  key(window, segments()[0], "ArrowLeft");
  await until(() => segments()[2].getAttribute("aria-checked") === "true", "ArrowLeft wraps to the last");
  assert.ok(document.activeElement === segments()[2], "focus moves with the choice");
  assert.ok(/From above/.test(text()) && !/From the side/.test(text()));
  segments()[1].click();
  await until(() => segments()[1].getAttribute("aria-checked") === "true", "a click chooses");
  assert.equal(document.querySelector('[role="radiogroup"]').getAttribute("aria-labelledby"), document.querySelector(".brief-segmented .brief-input-label").id);
  assert.deepEqual(page.requests, [], "nothing is asked of Core");
  assert.deepEqual(page.errors, []);
});

test("YN-16 a section's variables start again with each version; two places never share them", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const v3 = readSection(page, recipe());
  window.renderSection(v3, PROJECT);
  const plus = () => document.querySelectorAll(".brief-step")[1];
  plus().click();
  await until(() => document.querySelector(".brief-number-field").value === "5", "set to 5");
  window.renderSection({ ...v3 }, PROJECT);
  assert.equal(document.querySelector(".brief-number-field").value, "5", "the same version keeps the reader's value");
  window.renderSection({ ...v3, version: 4 }, PROJECT);
  await until(() => document.querySelector(".brief-number-field").value === "4", "a new version starts from its own value");
  // The card and the page beside it: the reader sets the card; the page keeps its own.
  window.renderCardAndBody(readSection(page, recipe()), PROJECT);
  const fields = () => [...document.querySelectorAll(".brief-number-field")];
  assert.equal(fields().length, 2);
  const card = document.querySelector(".home-summary-card");
  card.querySelectorAll(".brief-step")[1].click();
  card.querySelectorAll(".brief-step")[1].click();
  await until(() => fields()[0].value === "6", "the card's value");
  assert.equal(fields()[1].value, "4", "the page's value is its own");
  assert.ok(/two trays/.test(card.textContent), "the card shows its own block");
  assert.deepEqual(page.errors, []);
});

test("YN-16 a card's Group of inputs works on the card, every size; its controls never open the report", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.reportOpens = [];
  for (const size of ["small", "wide", "large"]) {
    const put = recipe();
    put.body.elements.body.props.summary.size = size;
    window.renderCard(readSection(page, put), PROJECT, { deck: true });
    const frame = document.querySelector(".home-card-frame.kind-interactive");
    assert.ok(frame, `${size}: the card draws its Group of inputs`);
    assert.ok(!frame.closest("[inert]") && !frame.querySelector("[inert]"), `${size}: nothing in it is inert`);
    assert.ok(document.querySelector(".home-summary-card").classList.contains(`size-${size}`));
    // Only the summary: the Method group is the page's.
    assert.ok(!/From the side/.test(frame.textContent), `${size}: only the named figure`);
    const plus = frame.querySelectorAll(".brief-step")[1];
    plus.click();
    plus.click();
    await until(() => /two trays/.test(frame.textContent), `${size}: the card's block follows its input`);
    frame.querySelector('[role="switch"]').click();
    setField(window, frame.querySelector(".brief-slider"), "9");
    key(window, frame.querySelector(".brief-number-field"), "ArrowUp");
    await until(() => frame.querySelector(".brief-number-field").value === "10", `${size}: keys work on the card`);
    window.unmountSection();
  }
  assert.deepEqual(window.reportOpens, [], "no control opened the report");
  // The card's own way there still does, and a card of only its figure and lead has none (the whole report).
  const put = recipe();
  window.renderCard(readSection(page, put), PROJECT, { deck: true });
  document.querySelector(".home-report-open").click();
  assert.deepEqual(window.reportOpens, ["scones"]);
  delete put.body.elements.more;
  for (const id of ["view", "oil", "side", "top"]) delete put.body.elements[id];
  put.body.elements.body.children = ["lead", "try"];
  window.renderCard(readSection(page, put), PROJECT, { deck: true });
  assert.ok(document.querySelector(".home-summary-card.is-whole") && !document.querySelector(".home-report-open"), "the whole report");
  assert.deepEqual(page.requests, []);
  assert.deepEqual(page.errors, []);
});

test("YN-16 inputs speak the interface language; what the Agent wrote stays as written", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.chooseLanguage("zh-Hans");
  window.renderSection(readSection(page, recipe()), PROJECT);
  await until(() => document.querySelector(".brief-switch-state")?.textContent === "关", "the switch's state in Chinese");
  const [minus, plus] = [...document.querySelectorAll(".brief-step")];
  assert.equal(minus.getAttribute("aria-label"), "减少Guests");
  assert.equal(plus.getAttribute("aria-label"), "增加Guests");
  assert.equal(document.querySelector(".brief-number label").textContent, "Guests");
  assert.equal(document.querySelector(".brief-input small").textContent, "Every amount scales.");
  window.chooseLanguage("en");
  assert.deepEqual(page.errors, []);
});

test("YN-16 R1 P3: a NumberInput shows as many decimals as a value it can take, min's and max's included", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const put = recipe();
  put.body.elements.guests.props = { name: "guests", label: "Guests", value: 1.25, min: 0.25, max: 10 };
  window.renderSection(readSection(page, put), PROJECT);
  const field = () => document.querySelector(".brief-number-field");
  assert.equal(field().value, "1.25");
  assert.equal(field().getAttribute("aria-valuetext"), "1.25");
  document.querySelectorAll(".brief-step")[1].click();
  await until(() => field().value === "2.25", "one step of 1 from 1.25");
  assert.deepEqual(page.errors, []);
});

// YN-16 S2: a Calc works its numbers out from the variables as they change;
// a Button sets them back. No request; nothing but the variables changes.
const bill = () => ({
  op: "put", key: "bill", kind: "report", title: "Bill",
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "split", size: "wide" } }, children: ["lead", "split"] },
    lead: { type: "Markdown", props: { text: "Dinner for the team." } },
    split: { type: "Group", props: {}, children: ["people", "tip", "roundUp", "shares", "reset"] },
    people: { type: "NumberInput", props: { name: "people", label: "People", value: 4, min: 1, max: 12 } },
    tip: { type: "Segmented", props: { name: "tip", label: "Tip", value: 10, options: [{ value: 0, label: "None" }, { value: 10, label: "10%" }] } },
    roundUp: { type: "Switch", props: { name: "roundUp", label: "Round up", value: false } },
    shares: { type: "Calc", props: { title: "Shares", items: [
      { id: "total", label: "Total", expr: "round(600 * (1 + tip / 100), 2)", prefix: "¥", digits: 2 },
      { id: "each", label: "Each", expr: "roundUp ? ceil(total / people) : round(total / people, 2)", prefix: "¥", digits: 2, emphasis: true, detail: "Per person" },
      { id: "extra", label: "Rounding adds", expr: "each * people - total", when: "extra > 0.001", prefix: "¥", digits: 2 },
      { id: "spare", label: "Per extra guest", expr: "total / (people - 4)", unit: "each" },
    ] } },
    reset: { type: "Button", props: { label: "Back to 4", tone: "accent" }, on: { press: [
      { action: "setState", params: { statePath: "/people", value: 4 } },
      { action: "setState", params: { statePath: "/roundUp", value: false } },
    ] } },
  } },
});
const row = (document, id) => document.querySelector(`.brief-calc [data-item="${id}"]`);
const shownValue = (document, id) => row(document, id)?.querySelector("dd").textContent ?? null;

test("YN-16 S2 a Calc follows its inputs, shows a dash with its reason where it cannot be worked out, and a Button sets them back", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(readSection(page, bill()), PROJECT);
  assert.equal(document.querySelector(".result-part-error"), null, "no part failed");
  assert.equal(document.querySelector(".brief-calc h4").textContent, "Shares");
  assert.deepEqual([shownValue(document, "total"), shownValue(document, "each")], ["¥660.00", "¥165.00"]);
  assert.ok(row(document, "each").hasAttribute("data-emphasis") && /Per person/.test(row(document, "each").textContent));
  assert.ok(!row(document, "extra"), "its when is false: no extra");
  // 600 × 1.1 / (4 − 4): a dash that says why, never NaN or Infinity.
  assert.deepEqual(await hoverTip(window, row(document, "spare").querySelector(".brief-calc-none")), ["Can't be worked out for these values"]);
  assert.ok(!/NaN|Infinity/.test(document.querySelector(".brief-calc").textContent));
  // Inputs change the numbers.
  const plus = document.querySelectorAll(".brief-step")[1];
  plus.click();
  plus.click();
  await until(() => shownValue(document, "each") === "¥110.00", "six people");
  assert.match(shownValue(document, "spare"), /^330 ?each$/, "a unit after the number, digits up to 2 by default");
  document.querySelector('[role="radio"]').click();
  await until(() => shownValue(document, "total") === "¥600.00", "no tip");
  document.querySelector('[role="switch"]').click();
  await until(() => shownValue(document, "each") === "¥100.00", "rounded up: 600 / 6 is whole");
  plus.click();
  await until(() => shownValue(document, "each") === "¥86.00" && row(document, "extra"), "seven people: rounding adds");
  assert.equal(shownValue(document, "extra"), "¥2.00");
  // The Button: back to 4 people, not rounded; the tip it does not name stays.
  const reset = document.querySelector(".brief-button");
  assert.ok(reset.classList.contains("primary-button"), "accent tone");
  reset.click();
  await until(() => document.querySelector(".brief-number-field").value === "4", "the Button sets the people back");
  assert.equal(document.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
  assert.equal(document.querySelector('[role="radio"][aria-checked="true"]').textContent, "None", "the tip it does not name stays");
  assert.equal(shownValue(document, "each"), "¥150.00");
  assert.deepEqual(page.requests, [], "nothing is asked of Core");
  assert.deepEqual(page.errors, []);
});

test("YN-16 S2 a Calc's numbers are in the interface language; a stored press is only ever setState of a variable", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.chooseLanguage("zh-Hans");
  const section = readSection(page, bill());
  window.renderSection(section, PROJECT);
  await until(() => row(document, "spare")?.querySelector(".brief-calc-none .sr-only")?.textContent.trim() === "按这些值无法算出", "the reason in Chinese");
  assert.deepEqual(await hoverTip(window, row(document, "spare").querySelector(".brief-calc-none")), ["按这些值无法算出"]);
  window.chooseLanguage("en");
  // A body Core kept before any check could carry anything under on: only setState of a variable name is run.
  const stored = JSON.parse(JSON.stringify(section));
  stored.version = 4;
  stored.body.elements.reset.on.press.push(
    { action: "setState", params: { statePath: "/people/0", value: 9 } },
    { action: "pushState", params: { statePath: "/people", value: 9 } },
    { action: "setState", params: { statePath: "/roundUp", value: { $state: "/people" } } },
  );
  stored.body.elements.reset.props.yuzunoPress = [{ statePath: "/people", value: 12 }];
  stored.body.elements.shares.on = { press: { action: "setState", params: { statePath: "/people", value: 9 } } };
  window.renderSection(stored, PROJECT);
  document.querySelectorAll(".brief-step")[1].click();
  await until(() => document.querySelector(".brief-number-field").value === "5", "five");
  document.querySelector(".brief-button").click();
  await until(() => document.querySelector(".brief-number-field").value === "4", "only the checked press ran");
  assert.equal(document.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
  assert.deepEqual(page.requests, []);
  assert.deepEqual(page.errors, []);
});

test("YN-16 S2 a card's Calc and Button work on the card and never open the report", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.reportOpens = [];
  const put = bill();
  put.body.elements.body.children.push("note");
  put.body.elements.note = { type: "Markdown", props: { text: "More on the page." } };
  window.renderCard(readSection(page, put), PROJECT, { deck: true });
  const frame = document.querySelector(".home-card-frame.kind-interactive");
  assert.ok(frame && frame.querySelector(".brief-calc") && frame.querySelector(".brief-button"));
  frame.querySelectorAll(".brief-step")[1].click();
  await until(() => shownValue(frame, "each") === "¥132.00", "five people on the card");
  frame.querySelector(".brief-button").click();
  await until(() => shownValue(frame, "each") === "¥165.00", "the card's Button");
  assert.deepEqual(window.reportOpens, [], "no control opened the report");
  assert.deepEqual(page.errors, []);
});

// YN-16 S3: a Diagram laid out by Yuzuno (dagre, loaded when a body has one);
// its nodes selected by pointer or keyboard, into its own variable or a
// Segmented's. No request.
const bike = () => ({
  op: "put", key: "bike", kind: "report", title: "Bike",
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "parts", size: "wide" } }, children: ["lead", "parts", "more"] },
    lead: { type: "Markdown", props: { text: "Seven gears, one chain." } },
    parts: { type: "Group", props: {}, children: ["pick", "drawing"] },
    pick: { type: "Segmented", props: { name: "part", label: "Part", value: "frame", options: [{ value: "frame", label: "Frame" }, { value: "chain", label: "Chain" }, { value: "gears", label: "Gears" }] } },
    drawing: { type: "Diagram", props: { title: "Drive", select: "part", nodes: [
      { id: "frame", label: "Frame", detail: "Holds it all." },
      { id: "chain", label: "Chain", detail: "Moves the wheel." },
      { id: "gears", label: "Rear gears", shape: "diamond", tone: "accent" },
    ], edges: [{ from: "frame", to: "chain" }, { from: "chain", to: "gears", label: "drives" }] } },
    more: { type: "Group", props: { title: "More" }, children: ["about", "steps"] },
    about: { type: "Markdown", visible: { $state: "/part", eq: "chain" }, props: { text: "Oil the chain monthly." } },
    steps: { type: "Diagram", props: { direction: "right", nodes: [{ id: "a", label: "Shift" }, { id: "b", label: "Pedal", detail: "Keep pedalling while shifting." }], edges: [{ from: "a", to: "b" }] } },
  } },
});
const node = (document, scope, id) => scope.querySelector(`.brief-diagram-node[data-node="${id}"]`);

test("YN-16 S3 a Diagram draws every node and edge once laid out; selecting a node shows its detail and sets the variable", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(readSection(page, bike()), PROJECT);
  const svg = await until(() => document.querySelector('.brief-diagram svg[aria-label="Drive"]'), "the drive diagram, laid out");
  assert.equal(document.querySelector(".result-part-error"), null);
  assert.equal(svg.querySelectorAll(".brief-diagram-node").length, 3);
  assert.equal(svg.querySelectorAll(".brief-diagram-edge path").length, 2);
  assert.ok(svg.querySelector('[data-edge="chain>gears"] .brief-diagram-edge-label').textContent === "drives");
  assert.match(svg.getAttribute("viewBox"), /^0 0 \d+ \d+$/);
  // The connections in words for a screen reader.
  assert.deepEqual([...document.querySelectorAll('.brief-diagram ul[aria-label="Connections"] li')].slice(0, 2).map((li) => li.textContent), ["Frame → Chain", "Chain → Rear gears (drives)"]);
  // The Segmented's starting value is the diagram's selected node.
  assert.equal(node(document, svg, "frame").getAttribute("aria-pressed"), "true");
  assert.match(svg.closest(".brief-diagram").querySelector(".brief-diagram-detail").textContent, /Frame.*Holds it all\./);
  node(document, svg, "chain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => node(document, svg, "chain").getAttribute("aria-pressed") === "true", "the chain selected");
  assert.equal(document.querySelector('[role="radio"][aria-checked="true"]').textContent, "Chain", "the segments follow the nodes");
  assert.ok(/Oil the chain monthly/.test(document.querySelector(".brief-body").textContent), "visible reads the selection");
  // The keyboard: a node is a button; Enter or Space selects it, and pressed again it stays selected.
  const gears = node(document, svg, "gears");
  assert.equal(gears.getAttribute("tabindex"), "0");
  assert.equal(gears.getAttribute("aria-label"), "Rear gears");
  gears.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent === "Gears", "Enter selects it");
  gears.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await tick(30);
  assert.equal(document.querySelector('[role="radio"][aria-checked="true"]').textContent, "Gears", "still selected");
  // A segment selects the node.
  document.querySelectorAll('[role="radio"]')[1].click();
  await until(() => node(document, svg, "chain").getAttribute("aria-pressed") === "true", "a segment selects the node");
  // A Diagram without select keeps its own selection; a node without detail says only its label.
  const steps = [...document.querySelectorAll(".brief-diagram")][1];
  assert.match(steps.querySelector(".brief-diagram-detail").textContent, /Select a node to read about it/);
  node(document, steps, "b").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => /Keep pedalling/.test(steps.querySelector(".brief-diagram-detail").textContent), "its own selection");
  assert.equal(node(document, svg, "chain").getAttribute("aria-pressed"), "true", "the other diagram's selection stays");
  assert.deepEqual(page.requests, []);
  assert.deepEqual(page.errors, []);
});

test("YN-16 S3 a Diagram on a card works there and never opens the report; its labels are as written in any language", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.reportOpens = [];
  window.chooseLanguage("zh-Hans");
  window.renderCard(readSection(page, bike()), PROJECT, { deck: true });
  const frame = document.querySelector(".home-card-frame.kind-interactive");
  const svg = await until(() => frame.querySelector(".brief-diagram svg"), "the card's diagram");
  assert.ok(!frame.closest("[inert]"));
  assert.equal(frame.querySelector(".brief-diagram-hint"), null, "the starting selection shows its detail");
  node(document, svg, "chain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => frame.querySelector('[role="radio"][aria-checked="true"]')?.textContent === "Chain", "on the card");
  assert.deepEqual(window.reportOpens, []);
  // A Diagram alone as the visual is the card's live figure too.
  const alone = bike();
  alone.body.elements.body.props.summary.visual = "steps";
  alone.body.elements.body.children = ["lead", "steps", "parts", "more"];
  alone.body.elements.more.children = ["about"];
  window.renderCard(readSection(page, alone), PROJECT, { deck: true });
  const live = await until(() => document.querySelector(".home-card-frame.kind-interactive .brief-diagram svg"), "a Diagram as the visual");
  assert.match(live.closest(".brief-diagram").querySelector(".brief-diagram-detail").textContent, /选择一个节点查看说明/);
  window.chooseLanguage("en");
  assert.deepEqual(page.errors, []);
});

// YN-16 S4: a Figure over the section's own image, Steps and a Timeline;
// each works by pointer and keyboard, and nothing is sent.
const bikeShot = () => ({
  op: "put", key: "parts", kind: "report", title: "Parts",
  attachments: [{ name: "bike.png", path: "/runs/bike.png" }],
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "try", size: "large" } }, children: ["lead", "try", "how", "when"] },
    lead: { type: "Markdown", props: { text: "Two parts carry the drive." } },
    try: { type: "Group", props: {}, children: ["part", "photo"] },
    part: { type: "Segmented", props: { name: "part", value: "frame", options: [{ value: "frame", label: "Frame" }, { value: "chain", label: "Chain" }] } },
    photo: { type: "Figure", props: { image: "bike.png", alt: "A seven-speed bike", caption: "Side view", select: "part", hotspots: [
      { id: "frame", label: "Frame", x: 40, y: 50, detail: "Holds every other part." },
      { id: "chain", label: "Chain", x: 62.5, y: 75, detail: "Carries the force." },
    ] } },
    how: { type: "Steps", props: { title: "Oiling the chain", mode: "walk", steps: [
      { id: "clean", title: "Wipe the chain", time: "2 min" },
      { id: "oil", title: "Oil each link", text: "One drop per link." },
      { id: "wipe", title: "Wipe off the rest" },
    ] } },
    when: { type: "Timeline", props: { title: "Service", items: [
      { id: "bought", at: "2026-03-14", title: "Bought", state: "done" },
      { id: "service", at: "2026-11-07T09:30:00Z", title: "First service", state: "now", text: "Brakes and chain." },
      { id: "next", at: "Spring", title: "Next service", state: "next", text: "Planned, not booked." },
    ] } },
  } },
});
const keptPng = (extra = {}) => attachment("bike.png", "image", "image/png", { width: 400, height: 300, ...extra });

test("YN-16 S4 a Figure shows the section's image at its own size with numbered hotspots; the list selects them with the segments", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(readSection(page, bikeShot(), { attachments: [keptPng()] }), PROJECT);
  const figure = document.querySelector(".brief-figure");
  const img = figure.querySelector("img");
  assert.equal(img.getAttribute("src"), `${base}/attachments/parts/bike.png?version=3`);
  assert.equal(img.getAttribute("alt"), "A seven-speed bike");
  assert.match(figure.querySelector(".brief-figure-picture").getAttribute("style"), /aspect-ratio: 400 \/ 300/);
  const markers = [...figure.querySelectorAll(".brief-hotspot")];
  assert.deepEqual(markers.map((m) => [m.textContent, m.style.left, m.style.top, m.getAttribute("tabindex")]), [["1", "40%", "50%", "-1"], ["2", "62.5%", "75%", "-1"]]);
  const keys = () => [...figure.querySelectorAll(".brief-figure-key-item")];
  assert.equal(figure.querySelector(".brief-figure-key").getAttribute("aria-label"), "Parts of A seven-speed bike");
  assert.deepEqual(keys().map((k) => [k.textContent, k.getAttribute("aria-pressed")]), [["1Frame", "true"], ["2Chain", "false"]]);
  assert.match(figure.querySelector(".brief-figure-detail").textContent, /Holds every other part/);
  keys()[1].click();
  await until(() => keys()[1].getAttribute("aria-pressed") === "true", "the list selects");
  assert.equal(document.querySelector('[role="radio"][aria-checked="true"]').textContent, "Chain", "the segments follow");
  markers[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => keys()[0].getAttribute("aria-pressed") === "true", "a marker selects");
  assert.equal(figure.querySelector("figcaption").textContent, "Side view");
  // Only referenced, not kept: no picture, the parts still listed.
  window.renderSection(readSection(page, bikeShot(), { attachments: [keptPng({ snapshot: false })] }), PROJECT);
  assert.ok(!document.querySelector(".brief-figure img"));
  assert.match(document.querySelector(".brief-figure-missing").textContent, /bike\.png is only referenced, not kept/);
  assert.equal(document.querySelectorAll(".brief-figure-key-item").length, 2);
  assert.deepEqual(page.requests, [], "an image is read by the browser from its address; nothing is fetched or sent");
  assert.deepEqual(page.errors, []);
});

test("YN-16 S4 Steps walk one at a time with Back, Next and a dot each; a Timeline formats dates, opens an event, and says what is planned", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(readSection(page, bikeShot(), { attachments: [keptPng()] }), PROJECT);
  const steps = document.querySelector('.brief-steps[data-mode="walk"]');
  const card = () => steps.querySelector(".brief-step-card");
  const [back, next] = [...steps.querySelectorAll(".brief-step-move")];
  assert.match(card().textContent, /Step 1 of 3.*Wipe the chain.*2 min/);
  assert.ok(back.disabled && !next.disabled);
  next.click();
  await until(() => /Step 2 of 3.*Oil each link.*One drop per link/.test(card().textContent), "Next");
  const dots = [...steps.querySelectorAll(".brief-step-dot")];
  assert.deepEqual(dots.map((d) => d.getAttribute("aria-current")), [null, "step", null]);
  dots[2].click();
  await until(() => /Wipe off the rest/.test(card().textContent) && next.disabled, "a dot jumps; Next stops at the end");
  // The Timeline: down without room to measure; dates in the reader's format; text on asking.
  const timeline = document.querySelector(".brief-timeline");
  assert.equal(timeline.getAttribute("data-layout"), "down");
  const rows = [...timeline.querySelectorAll(".brief-timeline-items > li")];
  assert.deepEqual(rows.map((r) => r.getAttribute("data-state")), ["done", "now", "next"]);
  assert.match(rows[0].textContent, /^Mar 14, 2026Bought/);
  assert.ok(!rows[0].querySelector("button"), "an event without text is not a control");
  assert.match(rows[2].textContent, /SpringNext servicePlanned/);
  const open = rows[1].querySelector("button");
  assert.equal(open.getAttribute("aria-expanded"), "false");
  open.click();
  await until(() => /Brakes and chain/.test(rows[1].textContent), "the event's text");
  assert.equal(open.getAttribute("aria-expanded"), "true");
  window.chooseLanguage("zh-Hans");
  window.renderSection(readSection(page, bikeShot(), { attachments: [keptPng()] }), PROJECT);
  // The same section redrawn keeps the step the reader is on: the third.
  await until(() => /第 3 步，共 3 步/.test(document.querySelector(".brief-step-card")?.textContent ?? ""), "Chinese steps, still on the third");
  assert.equal(document.querySelectorAll(".brief-step-move")[0].textContent, "上一步");
  assert.match(document.querySelector(".brief-timeline").textContent, /2026年3月14日/);
  window.chooseLanguage("en");
  assert.deepEqual(page.errors, []);
});

test("YN-16 S4 on a card the Figure, Steps and a Timeline work as on the page, opening no report", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.reportOpens = [];
  for (const visual of ["try", "how", "when"]) {
    const put = bikeShot();
    put.body.elements.body.props.summary.visual = visual;
    window.renderCard(readSection(page, put, { attachments: [keptPng()] }), PROJECT, { deck: true });
    const frame = document.querySelector(".home-card-frame.kind-interactive");
    assert.ok(frame && !frame.closest("[inert]"), visual);
    if (visual === "try") {
      frame.querySelectorAll(".brief-figure-key-item")[1].click();
      await until(() => frame.querySelector('[role="radio"][aria-checked="true"]')?.textContent === "Chain", "the card's figure");
    } else if (visual === "how") {
      frame.querySelectorAll(".brief-step-move")[1].click();
      await until(() => /Step 2 of 3/.test(frame.textContent), "the card's steps");
    } else {
      frame.querySelector(".brief-timeline-items button").click();
      await until(() => /Brakes and chain/.test(frame.textContent), "the card's timeline");
    }
    window.unmountSection();
  }
  assert.deepEqual(window.reportOpens, []);
  assert.deepEqual(page.errors, []);
});

test("YN-16 S2 R1 P3: Copy report leaves out a Calc that shows nothing at the starting values, title and all", (t) => {
  const page = mount();
  t.after(page.close);
  const { window } = page;
  const put = bill();
  put.body.elements.split.children.push("hiddenCalc");
  put.body.elements.hiddenCalc = { type: "Calc", props: { title: "Only when rounding", items: [{ id: "spare", label: "Spare", expr: "people * 2", when: "roundUp" }] } };
  const copied = window.sectionMarkdown(readSection(page, put), "en", { clock: "h24", timeZone: "UTC" });
  assert.ok(!copied.includes("Only when rounding"), copied);
  assert.equal(copied.split("Worked out from the starting values").length - 1, 1, "only the Calc that shows something says it");
  assert.match(copied, /#+ Shares\n+_Worked out from the starting values_\n+- Total: ¥660\.00\n- Each: ¥165\.00/);
  assert.deepEqual(page.errors, []);
});

test("YN-16 S4 R1 P3: walking Steps stays within a list a later version shortens: the counter, the dots and Next agree", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const put = bikeShot();
  window.renderSection(readSection(page, put, { attachments: [keptPng()] }), PROJECT);
  const steps = () => document.querySelector('.brief-steps[data-mode="walk"]');
  const next = () => steps().querySelectorAll(".brief-step-move")[1];
  // One press at a time, as a reader's taps arrive: each is drawn before the next.
  next().click();
  await until(() => /Step 2 of 3/.test(steps().textContent), "on the second of three");
  next().click();
  await until(() => /Step 3 of 3/.test(steps().textContent), "on the last of three");
  // A later version has two steps: the reader is on the last there is.
  const shorter = bikeShot();
  shorter.body.elements.how.props.steps = shorter.body.elements.how.props.steps.slice(0, 2);
  window.renderSection({ ...readSection(page, shorter, { attachments: [keptPng()] }), version: 4 }, PROJECT);
  await until(() => /Step 2 of 2/.test(steps().textContent), "the counter within the list");
  assert.match(steps().querySelector(".brief-step-card").textContent, /Oil each link/);
  assert.ok(next().disabled, "Next stops at the end");
  assert.deepEqual([...steps().querySelectorAll(".brief-step-dot")].map((d) => d.getAttribute("aria-current")), [null, "step"]);
  steps().querySelectorAll(".brief-step-move")[0].click();
  await until(() => /Step 1 of 2/.test(steps().textContent), "Back from the clamped step");
  assert.deepEqual(page.errors, []);
});

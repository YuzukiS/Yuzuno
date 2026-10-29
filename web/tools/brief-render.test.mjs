import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

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
const root=createRoot(document.getElementById('root'));
window.chooseLanguage=(language)=>saveLanguagePreferences({language});
window.examples=BRIEF_EXAMPLES;
window.checkBriefSection=checkBriefSection;
// With a density, as Home draws its cards (T-9); without one, as anywhere else.
window.renderSection=(section,projectId,extra={},workspaceId='',density)=>{const body=<CardFoldWorkspace.Provider value={workspaceId}><PointFixOpen.Provider value={window.pointFixOpen||null}><BriefSectionBody section={section} projectId={projectId} {...extra}/></PointFixOpen.Provider></CardFoldWorkspace.Provider>;flushSync(()=>root.render(density?<BriefDensity.Provider value={density}>{body}</BriefDensity.Provider>:body));};
window.unmountSection=()=>flushSync(()=>root.render(null));`,
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
  assert.equal(document.querySelector('.brief-delta[data-sign="-1"]').title, "Previously 0.437");

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
  assert.equal(where.title, "/home/me/experiments/round-12/outputs/sweep/huge.jsonl", "the full path on hover");
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
  assert.equal(dialog().querySelector("h2").textContent, "shot.png");
  assert.match(dialog().textContent, /Login screen · Snapshot /);
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
  const ref = (kind, id) => document.querySelector(`.brief-ref[data-kind="${kind}"]${id ? `[title*="${id}"]` : ""}`);
  const task = ref("task");
  assert.equal(task.dataset.tone, "active");
  // The Agent's short label leads (T-173); Core's current title is in the
  // tooltip and read out after it.
  assert.equal(task.querySelector("span").textContent, "Home V1");
  assert.equal(task.querySelector(".sr-only").textContent, ": Home V1 slice 1");
  assert.match(task.textContent, /^Home V1: Home V1 slice 1T-85doing$/, "label, current title, then the id and its state");
  assert.match(task.title, /^(Open )?Task T-85: Home V1 slice 1 · as of /);
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
    image: ["layout.png", "Screenshot of the updated layout"],
    status: ["Validation loss", "−0.025", "+35 samples/s", "18k of 40k", "Loss"],
    result: ["213 of 214", "not in a release yet", "FAIL brief limits", "A stale version is accepted after a restart."],
    compare: ["6% lower validation loss", "One seed each", "Validation loss, lower is better"],
    overview: ["Where we are", "one decision", "Run 12, larger batch", "Validation loss falls 6% once warm-up ends.", "Choose the run 13 split"],
    decision: ["The larger split costs about 6% of training data."],
  };
  const reads = {
    image: [attachment("layout.png", "image", "image/png")],
    status: [attachment("loss.csv", "data", "text/csv", { caption: "Loss per step" })],
    result: [],
    compare: [attachment("runs.csv", "data", "text/csv", { caption: "Validation loss of each run" })],
    overview: [],
    decision: [],
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
  const caption = () => document.querySelector(".result-table-caption span").textContent;
  const type = (value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
    input().dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  window.chooseLanguage("zh-Hans");
  window.renderSection(section, PROJECT, {}, "ws");
  await until(() => input()?.placeholder === "筛选…", "the Chinese filter");
  assert.equal(input().getAttribute("aria-label"), "筛选运行");
  assert.equal(document.querySelector(".result-table-scroll").getAttribute("aria-label"), "运行表格");
  assert.equal(caption(), "3 / 3 行");
  assert.deepEqual([...document.querySelectorAll(".result-table-scroll thead th")].map((th) => th.textContent), ["名称", "得分"]);
  type("没有");
  await until(() => document.querySelector(".result-empty")?.textContent === "没有匹配的行，换个筛选词试试。", "no matches, in Chinese");
  assert.equal(caption(), "0 / 3 行");
  type("");
  window.chooseLanguage("en");
  await until(() => input().placeholder === "Filter…", "back in English");
  assert.equal(input().getAttribute("aria-label"), "Filter 运行");
  assert.equal(caption(), "3 of 3 rows");
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
  const shown = () => [...document.querySelectorAll(".brief-attachments > li strong")].map((s) => s.textContent);
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
  const shown = () => [...document.querySelectorAll(".brief-attachments > li strong")].map((s) => s.textContent);
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

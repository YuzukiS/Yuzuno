// T-19 slice 2d-3, running steps (M14: ST:R3, ST:RP1, ST:B2), in Chromium on a production build of
// the app, through the real Settings, with every API answered here (no Core, no Tailscale, no backup).
// - Phone access and its phone previews, while Core reports a change running: the running step has
//   the update steps' moving segment under its words, in the gap below, hidden from assistive tech.
//   It takes no room, follows the change to its next step without moving any step, and is gone once
//   the change has ended (phone access succeeded, previews failed).
// - A backup while it runs: the same segment along the bottom of its box, inside the padding, taking
//   no room; gone once it has stopped.
// - Under reduced motion the segment is there and stands still; the step's words carry it.
// - The update steps' current bar moves with the same keyframes.
// Writes: none but the app's own saves of where an Agent was read; anything else is refused and
// counted. Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2d3-steps-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2d3-steps");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], reads: [], unknownGets: [], writes: [], readingSaves: [], samples: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
// The backend's examples (synthetic names): phone access applied and verified, with its previews.
const examples = JSON.parse(await readFile(new URL("./fixtures/remote-access-views.json", import.meta.url), "utf8"));
const operation = (id, step, state = "running") => ({ id, requestId: `page-${id}`, kind: "apply", state, step,
  startedAt: "2026-11-03T09:00:00Z", finishedAt: state === "running" ? null : "2026-11-03T09:00:05Z",
  url: "https://pc.tail0.ts.net:8444", request: { requestId: `page-${id}`, enabled: true },
  ...(state === "failed" ? { error: "Tailscale Serve did not answer" } : {}) });
const backupOperation = (step, state = "running") => ({ id: "op-b", requestId: "page-op-b", kind: "backup", state, step,
  request: { to: "/backups/manual" }, startedAt: "2026-11-03T09:00:00Z", finishedAt: state === "running" ? null : "2026-11-03T09:01:00Z",
  error: null, result: null });
// What Core answers now; each run sets it as it goes.
let remote, remoteOp, previewOp, backup, backupOp;
function reset() {
  remoteOp = operation("op-r", "listen");
  previewOp = operation("op-p", "done", "succeeded");
  remote = { ...structuredClone(examples.appliedVerified), operation: remoteOp };
  remote.preview = { ...remote.preview, operation: previewOp };
  backupOp = backupOperation("database");
  backup = { canChange: true, workspaceId: "fixture", canBackUp: true, refusals: [], unfinishedJobs: [], estimateBytes: 3 * 1024 * 1024,
    current: backupOp, recent: [], notCovered: [], replaceRunningWorkspace: "Replacing the Workspace this Core uses needs Core stopped" };
}
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [], messageReceipts: [] },
  "/api/agents/a/reading": { handoff: null },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
  "/api/remote-access": remote,
  "/api/remote-access/operations/op-r": remoteOp,
  "/api/remote-access/preview/operations/op-p": previewOp,
  "/api/workspace/backup": backup,
  "/api/workspace/backup/operations/op-b": backupOp,
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(url.pathname)) {
      report.readingSaves.push(url.pathname);
      return route.fulfill({ json: { accepted: true } });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (!report.reads.includes(url.pathname)) report.reads.push(url.pathname);
    const known = gets()[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    if (known === undefined && /^\/api\/(agents|remote-access|workspace)\/./.test(url.pathname)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    return route.fulfill({ json: known ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** A list of steps (or a backup's box) as it is now: each step, its segment, and the segment's motion. */
function readSteps([selector, gapMs]) {
  const root = document.querySelector(selector);
  if (!root) return null;
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
  const segments = [...root.querySelectorAll(".step-moving")];
  const seg = segments[0] ?? null;
  const style = seg && getComputedStyle(seg);
  const items = [...root.querySelectorAll(":scope > li")].map((li) => ({ state: li.dataset.state, text: li.textContent, box: box(li),
    segment: !!li.querySelector(".step-moving") }));
  const first = seg && style.backgroundPosition;
  return new Promise((done) => setTimeout(() => done({
    root: box(root), items, segments: segments.length,
    segment: seg && { box: box(seg), hidden: seg.getAttribute("aria-hidden"), position: style.position, text: seg.textContent,
      animation: [style.animationName, style.animationDuration, style.animationIterationCount].join(" "),
      positions: [first, getComputedStyle(seg).backgroundPosition] },
  }), gapMs));
}
/** The same list with its segment taken out of the page: whether anything else moves. */
function withoutSegment(selector) {
  const root = document.querySelector(selector);
  const seg = root?.querySelector(".step-moving");
  if (!seg) return null;
  const measure = () => ({ root: root.getBoundingClientRect().height,
    tops: [...root.querySelectorAll(":scope > li, :scope > :not(.step-moving)")].map((el) => el.getBoundingClientRect().top) });
  const before = measure();
  seg.style.display = "none";
  const after = measure();
  seg.style.display = "";
  return { before, after };
}
const same = (a, b) => !!a && !!b && Math.abs(a.root - b.root) <= 0.5 && a.tops.length === b.tops.length && a.tops.every((t, i) => Math.abs(t - b.tops[i]) <= 0.5);
const moving = (s, reduced) => !!s?.segment && (reduced
  ? s.segment.animation.startsWith("none ") && s.segment.positions[0] === s.segment.positions[1]
  : s.segment.animation === "step-moving 1.6s infinite" && s.segment.positions[0] !== s.segment.positions[1]);

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const OWN = "#settings-editor-remote .remote-access-operation:not(.remote-access-previews *) .remote-access-steps";
const PREVIEWS = "#settings-editor-remote .remote-access-previews .remote-access-steps";
const BACKUP = "#settings-editor-backup .workspace-backup-operation";
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  reset();
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  const steps = async (selector, label) => {
    await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
    const read = await page.evaluate(readSteps, [selector, 250]);
    report.samples[`${tag}: ${label}`] = read;
    return read;
  };
  const without = (selector) => page.evaluate(withoutSegment, selector);
  const openEditor = async (query, title, editor) => {
    if (!(await page.locator(".settings-search input").isVisible())) {
      await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
      await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
    }
    await page.locator(".settings-search input").fill(query);
    const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
    await card.locator("button").click({ timeout: 10_000 });
    await page.locator(`#settings-editor-${editor}`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
  };
  /** Until the running step is `index` (a poll is about once a second), or the list is gone (-1). */
  const until = (selector, index) => page.waitForFunction(([selector, index]) => {
    const items = [...(document.querySelector(selector)?.children ?? [])];
    return index < 0 ? items.length === 0 : items[index]?.dataset.state === "running";
  }, [selector, index], { timeout: 5000 });
  try {
    await page.goto("http://127.0.0.1:4319/");
    await page.locator(".agent-row").first().waitFor();

    // Phone access, its change running at its third step.
    await openEditor("phone", "Phone & remote access", "remote");
    await page.locator(OWN).waitFor({ timeout: 10_000 });
    const listen = await steps(OWN, "phone access at listen");
    const at = (s, i) => s?.items[i];
    /** One segment, in step `i` alone, which still reads as its words. */
    const under = (s, i, words) => !!s?.segment && s.segments === 1 && at(s, i)?.state === "running" && at(s, i).segment &&
      s.segment.hidden === "true" && s.segment.text === "" && at(s, i).text === words;
    ok(`${tag}: phone access running at "Core listens on the phone's port": one segment, in that step alone, hidden from assistive tech (${listen?.segments ?? 0} segments)`,
      under(listen, 2, "Core listens on the phone's port"), listen && { items: listen.items.map((i) => [i.state, i.segment]), segment: listen.segment });
    ok(`${tag}: phone access: the segment moves under normal motion and stands still under reduced motion (${listen?.segment?.animation ?? "no segment"})`,
      moving(listen, reduced), listen?.segment);
    const gap = (s, i) => !!s?.segment && s.segment.box.top >= at(s, i).box.bottom - 0.5 && s.segment.box.bottom <= at(s, i + 1).box.top + 0.5 &&
      Math.abs(s.segment.box.left - at(s, i).box.left) <= 0.5 && Math.abs(s.segment.box.right - at(s, i).box.right) <= 0.5;
    const ownWithout = await without(OWN);
    ok(`${tag}: phone access: the segment lies in the gap under its step's words and takes no room (the list is as it is without it)`,
      gap(listen, 2) && same(ownWithout?.before, ownWithout?.after), { segment: listen?.segment?.box, step: at(listen, 2)?.box, ownWithout });
    remoteOp = operation("op-r", "serve");
    await until(OWN, 3);
    const serveStep = await steps(OWN, "phone access at serve");
    ok(`${tag}: phone access goes to its next step: the segment is in "Tailscale Serve points to it" alone, and no step moved`,
      under(serveStep, 3, "Tailscale Serve points to it") && serveStep.items.every((item, i) => Math.abs(item.box.top - listen.items[i].box.top) <= 0.5),
      serveStep && { tops: [listen?.items.map((i) => i.box.top), serveStep.items.map((i) => i.box.top)], items: serveStep.items.map((i) => [i.state, i.segment]) });
    remoteOp = operation("op-r", "done", "succeeded");
    remote = { ...remote, operation: remoteOp };
    await until(OWN, -1);
    const ended = await page.evaluate(() => ({ segments: document.querySelectorAll("#settings-editor-remote .remote-access-operation:not(.remote-access-previews *) .step-moving").length,
      said: document.querySelector("#settings-editor-remote .remote-access-operation:not(.remote-access-previews *) [role=status]")?.textContent ?? null }));
    ok(`${tag}: phone access ends (succeeded): no segment is left (${ended.segments}), and it says how it ended`, ended.segments === 0 && !!ended.said, ended);

    // Its phone previews, their change running at its second step, after a reload of the page.
    previewOp = operation("op-p", "save");
    remote.preview = { ...remote.preview, operation: previewOp };
    await page.reload();
    await page.locator(".agent-row").first().waitFor();
    await openEditor("phone", "Phone & remote access", "remote");
    await page.locator(PREVIEWS).waitFor({ timeout: 10_000 });
    const listenP = await steps(PREVIEWS, "previews at save");
    ok(`${tag}: phone previews running at "Save them": one segment, in that step alone, hidden from assistive tech (${listenP?.segments ?? 0} segments)`,
      under(listenP, 1, "Save them"), listenP && { items: listenP.items.map((i) => [i.state, i.segment]), segment: listenP.segment });
    ok(`${tag}: phone previews: the segment moves under normal motion and stands still under reduced motion (${listenP?.segment?.animation ?? "no segment"})`,
      moving(listenP, reduced), listenP?.segment);
    const previewsWithout = await without(PREVIEWS);
    ok(`${tag}: phone previews: the segment lies in the gap under its step's words and takes no room (the list is as it is without it)`,
      gap(listenP, 1) && same(previewsWithout?.before, previewsWithout?.after), { segment: listenP?.segment?.box, step: at(listenP, 1)?.box, previewsWithout });
    previewOp = operation("op-p", "listen");
    await until(PREVIEWS, 2);
    const listenNext = await steps(PREVIEWS, "previews at listen");
    ok(`${tag}: phone previews go to their next step: the segment is in "Core listens on the previews' port" alone, and no step moved`,
      under(listenNext, 2, "Core listens on the previews' port") && listenNext.items.every((item, i) => Math.abs(item.box.top - listenP.items[i].box.top) <= 0.5),
      listenNext && { tops: [listenP?.items.map((i) => i.box.top), listenNext.items.map((i) => i.box.top)], items: listenNext.items.map((i) => [i.state, i.segment]) });
    previewOp = operation("op-p", "listen", "failed");
    remote.preview = { ...remote.preview, operation: previewOp };
    await until(PREVIEWS, -1);
    const previewsEnded = await page.evaluate(() => ({ segments: document.querySelectorAll("#settings-editor-remote .remote-access-previews .step-moving").length,
      said: document.querySelector("#settings-editor-remote .remote-access-previews [role=alert]")?.textContent ?? null }));
    ok(`${tag}: phone previews end (failed): no segment is left (${previewsEnded.segments}), and they say how it ended`,
      previewsEnded.segments === 0 && !!previewsEnded.said, previewsEnded);

    // A backup, running.
    await openEditor("backup", "Workspace backup & restore", "backup");
    await page.locator(BACKUP).waitFor({ timeout: 10_000 });
    const running = await steps(BACKUP, "backup running");
    const backupBox = await page.evaluate((selector) => {
      const box = document.querySelector(selector);
      if (!box) return null;
      const style = getComputedStyle(box);
      const r = box.getBoundingClientRect();
      const content = [...box.children].filter((el) => !el.classList.contains("step-moving")).map((el) => el.getBoundingClientRect().bottom);
      return { bottom: r.bottom, left: r.left, right: r.right, border: parseFloat(style.borderBottomWidth), padding: [parseFloat(style.paddingLeft), parseFloat(style.paddingBottom)],
        contentBottom: Math.max(...content), title: box.querySelector("[role=status]")?.textContent ?? null };
    }, BACKUP);
    report.samples[`${tag}: backup box`] = backupBox;
    const s = running?.segment?.box;
    ok(`${tag}: a backup running ("${backupBox?.title}"): one segment along the bottom of its box, inside its padding, hidden from assistive tech (${running?.segments ?? 0} segments)`,
      running?.segments === 1 && running.segment.hidden === "true" && running.segment.text === "" && backupBox?.title === "Backup: Copying the database…" &&
        s.bottom <= backupBox.bottom - backupBox.border + 0.5 && s.top >= backupBox.contentBottom - 0.5 &&
        Math.abs(s.left - (backupBox.left + backupBox.border + backupBox.padding[0])) <= 0.5 && Math.abs(s.right - (backupBox.right - backupBox.border - backupBox.padding[0])) <= 0.5,
      { segment: s, box: backupBox });
    ok(`${tag}: a backup running: the segment moves under normal motion and stands still under reduced motion (${running?.segment?.animation ?? "no segment"})`,
      moving(running, reduced), running?.segment);
    const backupWithout = await without(BACKUP);
    ok(`${tag}: a backup running: the segment takes no room (the box is as it is without it)`,
      same(backupWithout?.before, backupWithout?.after), backupWithout);
    backupOp = backupOperation("files", "stopped");
    backup = { ...backup, current: null, recent: [backupOp] };
    await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.state === "stopped", BACKUP, { timeout: 5000 });
    const stopped = await page.evaluate((selector) => ({ segments: document.querySelector(selector).querySelectorAll(".step-moving").length,
      title: document.querySelector(selector).querySelector("[role=status]")?.textContent ?? null }), BACKUP);
    ok(`${tag}: the backup stopped: no segment is left (${stopped.segments}), and it says so ("${stopped.title}")`,
      stopped.segments === 0 && /stopped/.test(stopped.title ?? ""), stopped);

    // The update steps' current bar: the same keyframes, still on the current step.
    const updates = await page.evaluate(() => {
      const names = [];
      for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) if (rule instanceof CSSKeyframesRule) names.push(rule.name);
      const list = document.createElement("ol");
      list.className = "update-steps";
      list.innerHTML = '<li class="is-current">x</li><li class="is-next">y</li>';
      document.body.append(list);
      const [current, next] = [...list.children].map((li) => getComputedStyle(li, "::before"));
      const out = { current: [current.animationName, current.animationDuration, current.animationIterationCount].join(" "), next: next.animationName,
        keyframes: names.filter((n) => /step-moving/.test(n)) };
      list.remove();
      return out;
    });
    report.samples[`${tag}: update steps`] = updates;
    ok(`${tag}: the update steps' current bar moves with the same keyframes (${updates.current}; ${updates.keyframes.join(", ")})`,
      updates.keyframes.length === 1 && updates.keyframes[0] === "step-moving" && updates.next === "none" &&
        (reduced ? updates.current.startsWith("none ") : updates.current === "step-moving 1.6s infinite"), updates);
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was sent to Core but reads (${report.reads.filter((p) => /remote-access|backup/.test(p)).join(", ")}) and where an Agent was read (PUT .../reading, ${report.readingSaves.length})`,
  report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2d3-steps-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);

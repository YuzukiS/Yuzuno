import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-14: a managed service's lifecycle in the real Portal, in JSDOM, with
// Core answered by a fixture whose service, replies and read timing each test
// sets. Process, health and this browser's check stay three facts; a stop or
// start names the run and intent revision its confirmation opened with; an
// unconfirmed reply is retried only on request, with the same request. No
// Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "service-lifecycle-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {closePortal, openInPortal} from ${src("portal/index.ts")};
const root=createRoot(document.getElementById('root'));
flushSync(()=>root.render(<div className="app"><aside className="rail"/><main className="main-panel"/></div>));
window.portal={open:openInPortal,close:closePortal};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ServiceLifecycleUi", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

// Synthetic records only.
const intent = (revision = 0, extra = {}) => ({ revision, desiredState: "unspecified", recoveryMode: "manual", requestedAt: null,
  requestedBy: null, appliesToJobId: null, sourceJobId: null, requestId: null, ...extra });
const job = (extra = {}) => ({ jobId: "j1", status: "running", owner: "verified", earlierJobIds: [], canStop: true, reason: null,
  resultReason: null, startedAt: "2026-10-31T00:00:00Z", finishedAt: null, timeoutSeconds: 14400, reserved: true,
  cancelRequestedAt: null, attempt: "a1", ownerCheckedAt: "2026-10-31T00:30:00Z", ...extra });
const ended = (extra = {}) => job({ status: "cancelled", canStop: false, reserved: false, finishedAt: "2026-10-31T00:40:00Z",
  cancelRequestedAt: "2026-10-31T00:39:00Z", ...extra });
const service = ({ job: run = job(), intent: chosen = intent(), canStart = false, port = 4381, health, ...rest } = {}) => ({
  id: "s1", projectId: "p1", machineId: "local", port: 5173, path: "/", name: "Board dev server", author: { kind: "user" }, createdAt: "",
  connection: { state: "available", localPort: port, httpStatus: 200, framing: "allowed", since: "2026-10-31T00:30:00Z" },
  job: run,
  health: health ?? { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: "2026-10-31T00:30:00Z" },
  lifecycle: run ? { intent: chosen, canStart, startBlockedCode: canStart ? null : "service_busy",
    startBlockedReason: canStart ? null : "service_busy: this Job has not conclusively ended without a reservation", sourceJobId: run.jobId } : null,
  ...rest,
});
const userStopped = (revision, requestId = "r-earlier") => intent(revision, { desiredState: "stopped", requestedAt: "2026-10-31T00:39:00Z",
  requestedBy: { kind: "user" }, appliesToJobId: "j1", requestId });
const target = (s, extra = {}) => ({ kind: "service", service: s, url: `http://127.0.0.1:${s.connection.localPort}/`,
  browserCheckedAt: "2026-10-31T00:31:00Z", browserJobId: s.job?.jobId ?? null, where: "Core host · port 5173", ...extra });
/** Core's receipt for a recorded action, as service_control.rs writes it. */
const receipt = (action, body, jobId, status) => ({ serviceId: "s1", requestId: body.requestId, action, jobId, status,
  intent: intent(body.expectedIntentRevision + 1, { desiredState: action === "stop" ? "stopped" : "running", requestedAt: "2026-10-31T00:50:00Z",
    requestedBy: { kind: "user" }, appliesToJobId: jobId, sourceJobId: body.sourceJobId ?? null, requestId: body.requestId }) });

function mount() {
  const errors = [];
  const requests = [];
  const opened = [];
  // What Core says. control answers stop/start; gate, when set, holds the
  // services list until released.
  const core = { service: service(), readFails: false, control: () => ({ status: 500, body: { error: "unexpected" } }), gate: null, openPort: 4382 };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.open = (...args) => { opened.push(args); return null; };
  const answer = async (request) => {
    if (request.url === "/api/projects/p1/services") {
      if (core.gate) await core.gate;
      return core.readFails ? { status: 500, body: { error: "Core could not read services" } } : { body: { services: [structuredClone(core.service)] } };
    }
    const action = request.url.match(/^\/api\/services\/s1\/(stop|start|open|close)$/)?.[1];
    if (action === "stop" || action === "start") return core.control(action, request.body);
    if (action === "open") {
      // Opening again may give the service's way another port; the list says it from then on.
      core.service = { ...core.service, connection: { ...core.service.connection, state: "available", localPort: core.openPort } };
      return { body: { ...structuredClone(core.service), proof: { challenge: "c2", answer: "a2" } } };
    }
    if (action === "close") return { body: {} };
    if (request.url === `http://127.0.0.1:${core.openPort}/.well-known/yuzuno-service/c2`) return { text: "a2" };
    if (request.url.endsWith("/logs")) return { body: { text: "" } };
    return { body: {} };
  };
  window.fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    const reply = await answer(request);
    // As a lost connection reaches the page: fetch's own rejection.
    if (reply === "network") throw new window.TypeError("Failed to fetch");
    const { status = 200, body = {}, text } = reply;
    return { ok: status < 400, status, json: async () => body, text: async () => text ?? JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  const panel = () => document.querySelector(".portal-panel");
  const frame = () => document.querySelector(".portal-panel iframe");
  const lifecycle = () => document.querySelector(".portal-panel .portal-lifecycle");
  const dialog = () => document.querySelector(".service-control-dialog");
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const button = (label, scope = document) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  const fact = (name) => lifecycle()?.querySelector(`[data-fact="${name}"]`)?.textContent ?? "";
  const headline = () => lifecycle()?.querySelector(".service-lifecycle-heading h3")?.textContent ?? "";
  const posts = (action) => requests.filter((r) => r.method === "POST" && r.url === `/api/services/s1/${action}`);
  /** A read the user asks for: from the panel, or from the open confirmation. */
  const refresh = async (scope = lifecycle()) => {
    const before = requests.filter((r) => r.url === "/api/projects/p1/services").length;
    click(button("Refresh status", scope));
    await until(() => requests.filter((r) => r.url === "/api/projects/p1/services").length > before, "the read");
    await tick(40);
  };
  return { window, document, errors, requests, opened, core, panel, frame, lifecycle, dialog, click, button, fact, headline, posts, refresh,
    close: () => window.close() };
}

test("a managed service: process, health and this browser apart; the end is planned, and closing the preview stops nothing", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  assert.ok(page.frame(), "the running page is shown");
  assert.equal(page.headline(), "Running, with a preview connection");
  assert.match(page.fact("process"), /^ProcessRunningPort ownership confirmedChecked \S/);
  assert.match(page.fact("health"), /^HTTP health checkCheck passed\/health · HTTP 200 · \S/);
  assert.match(page.fact("browser"), /^This browserConnection confirmedChecked \S/);
  // The planned end is the Job's start plus its limit; it is not an exit.
  assert.notEqual(page.lifecycle().querySelector(".service-lifecycle-deadline strong").textContent, "End time not recorded");
  assert.match(page.lifecycle().textContent, /The time limit alone does not confirm that the process exited\./);
  page.click(page.button("Close preview"));
  await until(() => !page.panel(), "the Portal closed");
  assert.deepEqual(page.requests.filter((r) => r.method === "POST"), [], "closing the preview sends nothing");
  assert.deepEqual(page.errors, []);
});

test("a stop confirmation keeps the run it opened for: a newer run read meanwhile is never stopped by it", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  page.click(page.button("Stop service…", page.lifecycle()));
  const dialog = await until(page.dialog, "the confirmation");
  assert.match(dialog.querySelector(".service-control-reference").textContent, /j1/);
  // Meanwhile another run took the service's place.
  page.core.service = service({ job: job({ jobId: "j2", attempt: "a2" }),
    intent: intent(1, { desiredState: "running", requestedBy: { kind: "user" }, appliesToJobId: "j2", sourceJobId: "j1", requestId: "r-other" }) });
  await page.refresh(dialog);
  await until(() => /changed after this confirmation opened/.test(dialog.textContent), "said to have changed");
  assert.match(dialog.querySelector(".service-control-reference").textContent, /j1/, "what it opened for stays shown");
  const confirm = page.button("Stop service", dialog);
  assert.ok(confirm.disabled, "its confirm is off");
  page.click(confirm);
  await tick(60);
  assert.equal(page.posts("stop").length, 0, "nothing stopped");
  // Reviewing takes the current run, and that one is what is sent.
  page.click(page.button("Review the current run", dialog));
  await until(() => /j2/.test(dialog.querySelector(".service-control-reference").textContent), "the current run");
  page.core.control = (action, body) => ({ body: receipt(action, body, "j2", "cancelling") });
  page.click(page.button("Stop service", dialog));
  const [sent] = await until(() => page.posts("stop").length && page.posts("stop"), "the stop");
  assert.deepEqual(Object.keys(sent.body).sort(), ["expectedIntentRevision", "expectedJobId", "requestId"]);
  assert.deepEqual([sent.body.expectedJobId, sent.body.expectedIntentRevision], ["j2", 1]);
  assert.deepEqual(page.requests.filter((r) => r.url.includes("/cancel")), [], "never a Job cancel of its own");
  assert.deepEqual(page.errors, []);
});

test("a stop is a recorded choice, not an exit: stopping until the run ends, then stopped as you asked, with a manual start", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  // Core records the intent and asks the Job to cancel; the run is cancelling.
  page.core.control = (action, body) => {
    page.core.service = service({ job: job({ status: "cancelling", canStop: false, cancelRequestedAt: "2026-10-31T00:50:00Z" }),
      intent: receipt(action, body, "j1", "cancelling").intent });
    return { body: receipt(action, body, "j1", "cancelling") };
  };
  page.click(page.button("Stop service…", page.lifecycle()));
  page.click(page.button("Stop service", await until(page.dialog, "the confirmation")));
  await until(() => /The request was recorded\./.test(page.lifecycle().textContent), "the receipt is said");
  await until(() => page.headline() === "Stop requested; waiting for exit", "stopping, not stopped");
  assert.match(page.lifecycle().textContent, /Your choice to keep it stopped is recorded\./);
  assert.equal(page.frame(), null, "no page while it stops");
  assert.match(page.panel().querySelector(".portal-idle").textContent, /^Stopping the service/);
  assert.equal(page.fact("browser"), "This browserNo current preview connectionNot evidence that the process ended");
  assert.equal(page.button("Start again…", page.lifecycle()), undefined, "no start while it may still run");
  assert.equal(page.button("Open in browser"), undefined);
  // Only the run's own end makes it stopped; the choice is said as the user's.
  page.core.service = service({ job: ended(), intent: page.core.service.lifecycle.intent, canStart: true });
  await page.refresh();
  await until(() => page.headline() === "Stopped as you requested", "stopped as asked");
  assert.match(page.panel().querySelector(".portal-idle").textContent, /^Service stopped/);
  assert.equal(page.fact("browser"), "This browserNo current preview connectionChecked again once a new run starts");
  assert.ok(page.button("Start again…", page.lifecycle()), "a manual start is offered");
  assert.deepEqual(page.errors, []);
});

test("an unconfirmed reply is retried only on request, as the same request; a read that shows it recorded confirms it", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  page.core.control = () => "network";
  page.click(page.button("Stop service…", page.lifecycle()));
  const dialog = await until(page.dialog, "the confirmation");
  page.click(page.button("Stop service", dialog));
  await until(() => page.button("Retry the same request", dialog), "the retry offered");
  assert.match(dialog.textContent, /The outcome is not confirmed\./);
  await tick(300);
  assert.equal(page.posts("stop").length, 1, "nothing is resent by itself");
  // A reply that isn't this request's receipt stays unconfirmed.
  page.core.control = (action, body) => ({ body: { ...receipt(action, body, "j1", "cancelling"), requestId: "someone-else" } });
  page.click(page.button("Retry the same request", dialog));
  await until(() => page.posts("stop").length === 2, "the retry");
  await tick(40);
  const [first, second] = page.posts("stop");
  assert.deepEqual(second.body, first.body, "the same request, id and body");
  assert.ok(page.button("Retry the same request", dialog), "still unconfirmed");
  // The answer was lost but Core recorded it: a read that shows this request
  // confirms it, with no resend.
  page.core.service = service({ job: job({ status: "cancelling", canStop: false }),
    intent: intent(1, { desiredState: "stopped", requestedBy: { kind: "user" }, appliesToJobId: "j1", requestId: first.body.requestId }) });
  await page.refresh(dialog);
  await until(() => !page.dialog() && /The request was recorded\./.test(page.lifecycle().textContent), "confirmed by the read");
  assert.equal(page.button("Retry the same request"), undefined);
  assert.equal(page.posts("stop").length, 2);
  assert.deepEqual(page.errors, []);
});

test("a definite refusal sends nothing more: the current run must be reviewed first", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  page.core.control = () => ({ status: 400, body: { error: "stale_service_state: the service intent changed; read the service again before choosing an action" } });
  page.click(page.button("Stop service…", page.lifecycle()));
  const dialog = await until(page.dialog, "the confirmation");
  page.click(page.button("Stop service", dialog));
  await until(() => /stale_service_state/.test(dialog.textContent), "the refusal said");
  assert.match(dialog.textContent, /changed after this confirmation opened/);
  assert.ok(page.button("Stop service", dialog).disabled, "no second send of a refused request");
  assert.equal(page.button("Retry the same request", dialog), undefined, "a refusal is no unknown outcome");
  assert.ok(page.button("Review the current run", dialog));
  assert.equal(page.posts("stop").length, 1);
  assert.deepEqual(page.errors, []);
});

test("starting again: only an ended run without a reservation, with the chosen limit; a queued run isn't ready, a new run needs a new check", async (t) => {
  const page = mount();
  t.after(page.close);
  page.core.service = service({ job: ended({ timeoutSeconds: 7200 }), intent: userStopped(1), canStart: true });
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  assert.equal(page.frame(), null);
  page.click(page.button("Start again…", page.lifecycle()));
  const dialog = await until(page.dialog, "the start confirmation");
  const options = () => [...dialog.querySelectorAll(".service-lifetime-options label")].map((l) => [l.textContent, l.querySelector("input").checked]);
  assert.deepEqual(options(), [["1 hour", false], ["4 hours", false], ["24 hours", false], ["Current limit · 2 hours", true]]);
  page.click(dialog.querySelector('input[value="3600"]'));
  await until(() => options()[0][1], "1 hour chosen");
  // A background read keeps the choice.
  await page.refresh(dialog);
  assert.deepEqual(options().map(([, checked]) => checked), [true, false, false, false]);
  // Core takes the start: a new run, queued, not ready.
  page.core.control = (action, body) => {
    page.core.service = service({ job: job({ jobId: "j2", status: "queued", canStop: true, reserved: false, startedAt: null, timeoutSeconds: body.timeoutSeconds,
      attempt: null, ownerCheckedAt: null }), intent: receipt(action, body, "j2", "queued").intent, health: { declared: true, path: "/health", state: "unknown" } });
    return { body: receipt(action, body, "j2", "queued") };
  };
  page.click(page.button("Start one run", dialog));
  const [sent] = await until(() => page.posts("start").length && page.posts("start"), "the start");
  assert.deepEqual({ ...sent.body, requestId: typeof sent.body.requestId },
    { requestId: "string", expectedJobId: "j1", expectedIntentRevision: 1, sourceJobId: "j1", timeoutSeconds: 3600 });
  await until(() => page.headline() === "Waiting for this run to start", "queued");
  assert.match(page.panel().querySelector(".portal-idle").textContent, /^Waiting for this run to start/);
  assert.equal(page.lifecycle().querySelector(".service-lifecycle-deadline strong").textContent, "1 hour from the actual start");
  assert.equal(page.fact("browser"), "This browserNo current preview connectionChecked once this run is ready");
  assert.equal(page.frame(), null);
  // Running now; the earlier check was of another run, so none is claimed.
  page.core.service = service({ job: job({ jobId: "j2", startedAt: "2026-10-31T00:55:00Z", timeoutSeconds: 3600 }), intent: page.core.service.lifecycle.intent });
  await page.refresh();
  await until(() => page.headline() === "The service is running", "running");
  assert.equal(page.frame(), null, "not shown before this browser checks it");
  assert.match(page.fact("browser"), /^This browserNo check recorded here/);
  const check = page.panel().querySelector(".portal-idle");
  assert.match(check.textContent, /^Ready to check the preview/);
  page.click(page.button("Check and open preview", check));
  const frame = await until(page.frame, "the page after its check");
  assert.equal(frame.getAttribute("src"), "http://127.0.0.1:4382/");
  assert.ok(page.requests.some((r) => r.method === "POST" && r.url === "/api/services/s1/open"));
  assert.ok(page.requests.some((r) => r.url === "http://127.0.0.1:4382/.well-known/yuzuno-service/c2"));
  await until(() => page.headline() === "Running, with a preview connection", "ready");
  assert.equal(page.posts("start").length, 1, "checking starts nothing");
  assert.deepEqual(page.errors, []);
});

test("no start while a run may still hold the service; a passed time limit alone is no exit", async (t) => {
  const page = mount();
  t.after(page.close);
  const cases = [
    // The outcome is not known: no duplicate run, and an earlier check is no proof of whose process answers.
    [service({ job: job({ status: "unknown", owner: "unknown" }) }), "This run still needs checking", /^Check the original run first/],
    // Ended but still holding its reservation.
    [service({ job: ended({ reserved: true }), canStart: true }), "This run has ended", /^This run has ended/],
    // Core's capability names another source run.
    [{ ...service({ job: ended(), canStart: true }), lifecycle: { ...service({ job: ended(), canStart: true }).lifecycle, sourceJobId: "j0" } }, "This run has ended", /^This run has ended/],
    // Cancelling with no recorded choice: stopping, its initiator not said.
    [service({ job: job({ status: "cancelling", canStop: false, cancelRequestedAt: "2026-10-31T00:50:00Z" }) }), "Stop requested; waiting for exit", /^Stopping the service/],
  ];
  const reopen = async (shown) => {
    page.window.portal.close();
    await until(() => !page.panel(), "the Portal closed");
    page.core.service = shown;
    page.window.portal.open(target(shown));
  };
  for (const [shown, title, idle] of cases) {
    await reopen(shown);
    await until(() => page.headline() === title, title);
    assert.equal(page.button("Start again…", page.lifecycle()), undefined, title);
    assert.match(page.panel().querySelector(".portal-idle").textContent, idle);
    assert.doesNotMatch(page.lifecycle().textContent, /Your choice to keep it stopped/, `${title}: no choice invented`);
  }
  assert.match(page.fact("browser"), /^This browserNo current preview connection/);
  await reopen(service({ job: job({ status: "unknown", owner: "unknown" }) }));
  await until(() => page.headline() === "This run still needs checking", "unknown");
  assert.match(page.fact("browser"), /Doesn't confirm the original process$/);
  // Long past its planned end and still running: running, not expired.
  await reopen(service({ job: job({ startedAt: "2026-10-01T00:00:00Z", timeoutSeconds: 60 }) }));
  await until(() => page.headline() === "Running, with a preview connection", "still running");
  assert.ok(page.frame());
  assert.deepEqual(page.requests.filter((r) => r.method === "POST"), []);
  assert.deepEqual(page.errors, []);
});

test("Escape closes only the confirmation; a failed read keeps the last facts and holds new actions", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  page.click(page.button("Stop service…", page.lifecycle()));
  const dialog = await until(page.dialog, "the confirmation");
  // From its close button, outside the confirmation's own body.
  page.button("Close dialog", dialog).dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await until(() => !page.dialog(), "the confirmation closed");
  assert.ok(page.panel(), "the Portal stays open");
  assert.equal(page.posts("stop").length, 0);
  page.core.readFails = true;
  await page.refresh();
  await until(() => /Status could not be refreshed\./.test(page.lifecycle().textContent), "the failed read said");
  assert.equal(page.headline(), "Running, with a preview connection", "the last facts stay");
  assert.ok(page.button("Stop service…", page.lifecycle()).disabled, "no new action on stale facts");
  page.core.readFails = false;
  await page.refresh();
  await until(() => !/Status could not be refreshed\./.test(page.lifecycle().textContent), "read again");
  assert.ok(!page.button("Stop service…", page.lifecycle()).disabled);
  assert.deepEqual(page.errors, []);
});

test("on an older Core, the Job's stop keeps the Job its confirmation opened for", async (t) => {
  const page = mount();
  t.after(page.close);
  const legacy = (jobId) => ({ ...service({ job: job({ jobId }) }), lifecycle: undefined });
  page.core.service = legacy("j1");
  // The first read waits, so the confirmation opens on the Job the Portal was opened with.
  let release;
  page.core.gate = new Promise((done) => { release = done; });
  page.window.portal.open(target(page.core.service));
  const section = await until(() => page.panel()?.querySelector(".portal-job"), "the Job");
  assert.equal(page.lifecycle(), null, "no lifecycle panel without Core's lifecycle");
  page.click(page.button("Stop Job…", section));
  const confirm = await until(() => page.button("Stop the Job", section), "the confirmation");
  page.core.service = legacy("j2");
  release();
  page.core.gate = null;
  await until(() => /now refers to another Job/.test(section.textContent), "said to have changed");
  assert.ok(confirm.disabled);
  page.click(confirm);
  await tick(60);
  assert.deepEqual(page.requests.filter((r) => r.url.includes("/cancel")), [], "neither Job cancelled");
  assert.deepEqual(page.errors, []);
});

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
import {ProjectServices} from ${src("ProjectServices.tsx")};
const root=createRoot(document.getElementById('root'));
const shell=(child)=><div className="app"><aside className="rail"/><main className="main-panel">{child}</main></div>;
flushSync(()=>root.render(shell(null)));
window.portal={open:openInPortal,close:closePortal};
window.renderServices=()=>flushSync(()=>root.render(shell(<ProjectServices projectId="p1" machines={[]} disabled={false}/>)));`,
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
    const action = request.url.match(/^\/api\/services\/s1\/(stop|start|recovery|open|close)$/)?.[1];
    if (action === "stop" || action === "start" || action === "recovery") return core.control(action, request.body);
    if (action === "open") {
      // Opening again may give the service's way another port; the list says it from then on.
      core.service = { ...core.service, connection: { ...core.service.connection, state: "available", localPort: core.openPort } };
      // As Core answers it (services.rs, open_service): the service and its
      // way, never its Job, lifecycle or health, which only the list reads.
      const { job: _job, lifecycle: _lifecycle, health: _health, ...opened } = structuredClone(core.service);
      return { body: { ...opened, proof: { challenge: "c2", answer: "a2" } } };
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
  await until(() => /The service has a newer run\. Review it before stopping; this stop wasn't carried out\./.test(dialog.textContent), "said to have changed");
  // Only the refusal: what this stop would have done no longer holds.
  assert.equal(page.button("Stop service", dialog), undefined, "no confirm to press");
  assert.doesNotMatch(dialog.textContent, /ends the linked run|Keep it stopped/, "no description that no longer holds");
  await tick(60);
  assert.equal(page.posts("stop").length, 0, "nothing stopped");
  // Reviewing takes the current run, and that one is what is sent.
  page.click(page.button("Review the current run", dialog));
  await until(() => /j2/.test(dialog.querySelector(".service-control-reference")?.textContent ?? ""), "the current run");
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
  // An ended run says when it ended, not when it was planned to.
  assert.match(page.lifecycle().querySelector(".service-lifecycle-deadline").textContent, /^This run ended\S/);
  assert.match(page.lifecycle().textContent, /The request was recorded\./, "its note stays while the choice is this request's");
  // Core records a later choice: the note about this one is history.
  page.core.service = service({ job: ended(), intent: intent(2, { desiredState: "stopped", requestedBy: { kind: "user" }, appliesToJobId: "j1", requestId: "r-later" }), canStart: true });
  await page.refresh();
  await until(() => !/The request was recorded\./.test(page.lifecycle().textContent), "the note cleared");
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
  await until(() => /The service has a newer run\. Review it before stopping; this stop wasn't carried out\./.test(dialog.textContent), "the refusal said");
  assert.equal(page.button("Stop service", dialog), undefined, "no second send of a refused request");
  assert.doesNotMatch(dialog.textContent, /ends the linked run|Keep it stopped/, "only the refusal");
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
  // Opening answers only the way: the run, its panel and the proof stay through the next read.
  await page.refresh();
  assert.equal(page.headline(), "Running, with a preview connection");
  assert.equal(page.frame()?.getAttribute("src"), "http://127.0.0.1:4382/");
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
  // A stop may be asked of it (design v3.4 §6); the next test follows one.
  assert.ok(page.button("Stop service…", page.lifecycle()));
  assert.ok(page.button("Open in Jobs", page.lifecycle()));
  // Long past its planned end and still running: running, not expired.
  await reopen(service({ job: job({ startedAt: "2026-10-01T00:00:00Z", timeoutSeconds: 60 }) }));
  await until(() => page.headline() === "Running, with a preview connection", "still running");
  assert.ok(page.frame());
  assert.deepEqual(page.requests.filter((r) => r.method === "POST"), []);
  assert.deepEqual(page.errors, []);
});

test("an outcome still being checked: a stop is only asked for, and the run stays to be checked until Jobs confirms its end", async (t) => {
  const page = mount();
  t.after(page.close);
  const unknown = job({ status: "unknown", owner: "unknown" });
  page.core.service = service({ job: unknown, intent: intent(3) });
  page.core.control = (action, body) => {
    // Core records the choice and asks Jobs to cancel; the outcome stays unknown.
    page.core.service = service({ job: { ...unknown, canStop: false, cancelRequestedAt: "2026-10-31T00:50:00Z" },
      intent: userStopped(body.expectedIntentRevision + 1, body.requestId) });
    return { body: receipt(action, body, "j1", "unknown") };
  };
  page.window.portal.open(target(page.core.service));
  await until(() => page.headline() === "This run still needs checking", "the unknown run");
  assert.equal(page.button("Start again…", page.lifecycle()), undefined, "no start while the outcome is unknown");
  page.click(page.button("Stop service…", page.lifecycle()));
  await until(page.dialog, "the stop confirmation");
  assert.match(page.dialog().textContent, /This run's outcome isn't confirmed yet\. Stopping records your choice and asks for the run to end; until that end is confirmed, it still needs checking\./);
  assert.doesNotMatch(page.dialog().textContent, /disconnects its page/, "no promise that the page ends now");
  page.click(page.button("Stop service", page.dialog()));
  await until(() => page.lifecycle().textContent.includes("Still needs checking · stop requested, waiting for confirmation"), "the requested stop");
  assert.deepEqual(page.posts("stop").map((r) => [r.body.expectedJobId, r.body.expectedIntentRevision]), [["j1", 3]]);
  assert.equal(page.headline(), "This run still needs checking");
  assert.equal(page.button("Stop service…", page.lifecycle()), undefined, "asked once");
  assert.equal(page.button("Start again…", page.lifecycle()), undefined, "still no start");
  assert.ok(page.button("Refresh status", page.lifecycle()));
  assert.doesNotMatch(page.lifecycle().textContent, /Stopped as you requested|Your choice to keep it stopped/, "not stopped before Jobs confirms it");
  assert.match(page.panel().querySelector(".portal-idle").textContent, /^Check the original run first/);
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

test("the services list: opening a managed service keeps its run details, and its open choice outlasts the next read", async (t) => {
  const page = mount();
  t.after(page.close);
  page.core.service = { ...service(), connection: { state: "closed", since: "" } };
  page.window.renderServices();
  const list = await until(() => page.document.querySelector('[aria-label="Services"]'), "the services list");
  page.click(await until(() => page.button("Open", list), "Open"));
  await until(() => list.querySelector(".services-open"), "the open choice, once this browser reaches the port");
  assert.equal(list.querySelector(".services-open small").textContent, "127.0.0.1:4382/");
  // Core's answer to opening has no Job: the entry keeps the one the list read.
  const details = page.button("Run details", list);
  assert.ok(details, "the run details stay offered after opening");
  // The next read keeps the proof: it was of this run.
  page.click(details);
  const dialog = await until(() => page.document.querySelector(".services-lifecycle-dialog"), "the run details");
  await page.refresh(dialog);
  assert.ok(list.querySelector(".services-open"), "the open choice outlasts the next read");
  assert.match(dialog.querySelector('[data-fact="browser"]').textContent, /^This browserConnection confirmedChecked \S/);
  assert.deepEqual(page.errors, []);
});

// Bounded recovery as Core reports it (Dev 5's contract v1; design v3.4 §3).
const armedIntent = intent(1, { desiredState: "running", recoveryMode: "bounded", requestedAt: "2026-10-31T00:00:00Z",
  requestedBy: { kind: "user" }, appliesToJobId: "j1", sourceJobId: "j0", requestId: "r-armed" });
const recovery = (extra = {}) => ({ mode: "bounded", state: "armed", launch: "running", queueReason: null,
  retry: { scheduled: 0, started: 0, max: 3 }, schedule: [30, 120, 600], deadlineAt: "2026-10-31T04:00:00Z", retryJobId: null,
  notBefore: null, lastFailure: null, haltedReason: null, haltedAt: null,
  attempts: [{ retry: 0, jobId: "j1", startedAt: "2026-10-31T00:00:00Z", endedAt: null, outcome: null }],
  observedAt: "2026-10-31T00:30:00Z", ...extra });
const withRecovery = (s, block, extra = {}) => ({ ...s, lifecycle: { ...s.lifecycle, recovery: block, ...extra } });
// The window after two crashes: j1 and retry 1 (j2) exited 1; retry 2 (j3)
// waits for its earliest time, two minutes after the last failure.
const history = [{ retry: 0, jobId: "j1", startedAt: "2026-10-31T00:00:00Z", endedAt: "2026-10-31T00:20:00Z", outcome: "exit:1" },
  { retry: 1, jobId: "j2", startedAt: "2026-10-31T00:20:31Z", endedAt: "2026-10-31T00:40:00Z", outcome: "exit:1" }];
const lastFailure = { kind: "exit", code: 1, jobId: "j2", endedAt: "2026-10-31T00:40:00Z" };
const retryJob = (extra = {}) => job({ jobId: "j3", status: "queued", reserved: false, startedAt: null, attempt: null, owner: "unknown",
  ownerCheckedAt: null, ...extra });
const windowAt = (run, block, extra = {}) => withRecovery(service({ job: run, intent: armedIntent, ...extra }), recovery({
  retry: { scheduled: 2, started: 1, max: 3 }, retryJobId: "j3", lastFailure,
  attempts: [...history, { retry: 2, jobId: "j3", startedAt: run.startedAt ?? null, endedAt: null, outcome: null }], ...block }));
const waiting = (block = {}) => windowAt(retryJob(), { state: "waiting", launch: "queued", queueReason: "Waiting for shared machine capacity",
  notBefore: "2026-10-31T00:42:00Z", observedAt: "2026-10-31T00:40:01Z", ...block });
const recoveryText = (page) => [...(page.lifecycle()?.querySelectorAll(".service-recovery-intent p span") ?? [])].map((line) => line.textContent);

test("bounded recovery is chosen on each start, unticked; only a ticked start asks for it", async (t) => {
  const page = mount();
  t.after(page.close);
  const ended = (jobId) => withRecovery(service({ job: { ...job({ jobId }), status: "failed", canStop: false, reserved: false, finishedAt: "2026-10-31T00:40:00Z" },
    intent: intent(1, { desiredState: "running", requestedBy: { kind: "user" }, appliesToJobId: jobId, requestId: "r-x" }), canStart: true }),
    recovery({ mode: "manual", state: "off", launch: null, retry: { scheduled: 0, started: 0, max: 0 }, attempts: [] }));
  page.core.service = ended("j1");
  const started = [];
  page.core.control = (action, body) => {
    started.push(body);
    const answer = receipt(action, body, `j${started.length + 1}`, "queued");
    answer.intent.recoveryMode = body.recovery ? "bounded" : "manual";
    page.core.service = ended(`j${started.length + 1}`);
    page.core.service.lifecycle.intent = answer.intent;
    return { body: answer };
  };
  page.window.portal.open(target(page.core.service));
  await until(page.lifecycle, "the service panel");
  assert.deepEqual(recoveryText(page), [], "a manual run says nothing of recovery");
  for (const tick_ of [false, true, false]) {
    page.click(page.button("Start again…", page.lifecycle()));
    const dialog = await until(page.dialog, "the start confirmation");
    const option = dialog.querySelector(".service-recovery-option input");
    assert.equal(option.checked, false, "unticked on every start");
    assert.match(dialog.querySelector(".service-recovery-option").textContent,
      /^Retry automatically after a failureAt most 3 times, after 30 seconds, 2 minutes and 10 minutes; shares this run's end time; never after a stop, the end time or a Core restart$/);
    assert.match(dialog.textContent, /Manual recovery by default: unticked, nothing starts again after a failure/);
    if (tick_) { page.click(option); await until(() => option.checked, "ticked"); }
    page.click(page.button("Start one run", dialog));
    await until(() => !page.dialog() && /The request was recorded\./.test(page.lifecycle().textContent), "the start recorded");
  }
  assert.deepEqual(started.map((body) => body.recovery ?? null), [null, { mode: "bounded" }, null]);
  assert.deepEqual(Object.keys(started[0]).sort(), ["expectedIntentRevision", "expectedJobId", "requestId", "sourceJobId", "timeoutSeconds"]);
  assert.deepEqual(page.errors, []);
});

test("a waiting retry: this round hasn't started, the earliest time is no promise, and both stop and opt-out say what they cancel", async (t) => {
  const page = mount();
  t.after(page.close);
  page.core.service = waiting();
  page.window.portal.open(target(page.core.service));
  await until(() => page.headline() === "Stopped; an automatic retry follows", "the waiting retry");
  assert.match(page.lifecycle().querySelector(".service-lifecycle-heading p").textContent,
    /^The last run exited with code 1 \([^)]+\)\. The preview is available once this retry runs\.$/);
  assert.match(recoveryText(page)[0], /^Automatic retry 2 of 3 · waiting · tried no earlier than [^·]+ · in about 2 min$/);
  assert.doesNotMatch(page.lifecycle().textContent, /starts at|will start|soon/i, "no promised start");
  assert.equal(page.fact("process"), "ProcessNot started this roundWaiting to retry");
  assert.match(page.lifecycle().querySelector(".service-lifecycle-deadline").textContent, /Shared end time; it stops then, and no new run window opens$/);
  assert.match(page.panel().querySelector(".portal-idle").textContent, /^Waiting for an automatic retry/);
  assert.match(page.lifecycle().querySelector(".service-recovery-off").textContent, /^Turn off automatic retryCancels the waiting retry; the service stays stopped$/);
  assert.match(page.lifecycle().querySelector(".service-recovery-details").textContent, /2 scheduled · 1 started · at most 3/);
  assert.equal(page.lifecycle().querySelectorAll(".service-attempts li").length, 3);
  assert.deepEqual([...page.lifecycle().querySelectorAll(".service-attempts li span:last-child")].map((cell) => cell.textContent), ["Exit code 1", "Exit code 1", "In progress"]);
  assert.equal(page.button("Start again…", page.lifecycle()), undefined, "no start while a retry is queued");
  // Past its earliest time it is queued with Jobs' own reason, never "soon".
  page.core.service = waiting({ observedAt: "2026-10-31T00:42:20Z" });
  await page.refresh();
  await until(() => /past [^,]+, queued: Waiting for shared machine capacity$/.test(recoveryText(page)[0] ?? ""), "overdue");
  // Stop: no process runs, and the waiting retry is cancelled with it.
  page.click(page.button("Stop service…", page.lifecycle()));
  const dialog = await until(page.dialog, "the stop confirmation");
  assert.match(dialog.textContent, /No process is running now; stopping only changes what happens next\./);
  assert.match(dialog.textContent, /This also cancels the waiting automatic retry \(tried no earlier than [^)]+\); nothing starts automatically afterwards\./);
  assert.doesNotMatch(dialog.textContent, /disconnects its page/);
  page.click(page.button("Keep running", dialog));
  await until(() => !page.dialog(), "closed");
  // Opting out needs no confirmation; it names the retry it cancels.
  page.core.control = (action, body) => {
    const answer = { serviceId: "s1", requestId: body.requestId, action, jobId: "j3", status: "cancelled", cancelledRetryJobId: "j3",
      intent: intent(2, { desiredState: "running", requestedAt: "2026-10-31T00:43:00Z", requestedBy: { kind: "user" }, appliesToJobId: "j3",
        sourceJobId: "j0", requestId: body.requestId }) };
    page.core.service = windowAt(retryJob({ status: "cancelled", canStop: false, finishedAt: "2026-10-31T00:43:00Z" }),
      { mode: "manual", state: "off", launch: null, haltedReason: "opted_out", haltedAt: "2026-10-31T00:43:00Z" }, { intent: answer.intent, canStart: true });
    return { body: answer };
  };
  page.click(page.button("Turn off automatic retry", page.lifecycle()));
  const [sent] = await until(() => page.posts("recovery").length && page.posts("recovery"), "the opt-out");
  assert.deepEqual({ ...sent.body, requestId: typeof sent.body.requestId },
    { requestId: "string", expectedJobId: "j3", expectedIntentRevision: 1, mode: "manual" });
  await until(() => /Automatic retry is off\. Runtime facts below still come from Core\./.test(page.lifecycle().textContent), "the opt-out recorded");
  await until(() => recoveryText(page)[0] === "You turned off automatic retry", "said as the user's");
  assert.equal(page.fact("process"), "ProcessDidn't start this roundPort ownership is not confirmed");
  assert.equal(page.button("Turn off automatic retry", page.lifecycle()), undefined);
  assert.ok(page.button("Start again…", page.lifecycle()), "manual from here");
  assert.equal(page.posts("stop").length, 0);
  assert.deepEqual(page.errors, []);
});

test("a stop from a reading before an automatic retry still stops the window; Core answers for its current Job", async (t) => {
  const page = mount();
  t.after(page.close);
  page.core.service = withRecovery(service({ job: job(), intent: armedIntent }), recovery());
  page.window.portal.open(target(page.core.service));
  await until(() => recoveryText(page)[0] === "Automatic retry is on · 3 left", "armed");
  assert.match(page.lifecycle().querySelector(".service-recovery-off").textContent, /This round continues; no automatic retries after it$/);
  page.click(page.button("Stop service…", page.lifecycle()));
  const dialog = await until(page.dialog, "the stop confirmation");
  assert.match(dialog.textContent, /This applies to the whole automatic-retry period: this run and any later retries stop/);
  // Meanwhile j1 crashed twice and retry 2 waits: the revision is the same.
  page.core.service = waiting();
  await page.refresh(dialog);
  assert.ok(!page.button("Stop service", dialog).disabled, "still this window's stop");
  page.core.control = (action, body) => {
    page.core.service = windowAt(retryJob({ status: "cancelled", canStop: false, finishedAt: "2026-10-31T00:41:00Z" }),
      { state: "halted", launch: null, haltedReason: "user_stop", haltedAt: "2026-10-31T00:41:00Z" },
      { intent: userStopped(2, body.requestId), canStart: true });
    page.core.service.lifecycle.intent.appliesToJobId = "j3";
    const answer = receipt(action, body, "j3", "cancelled");
    return { body: answer };
  };
  page.click(page.button("Stop service", dialog));
  const [sent] = await until(() => page.posts("stop").length && page.posts("stop"), "the stop");
  assert.deepEqual([sent.body.expectedJobId, sent.body.expectedIntentRevision], ["j1", 1], "as the confirmation opened");
  await until(() => !page.dialog() && /The request was recorded\./.test(page.lifecycle().textContent), "recorded for j3");
  await until(() => recoveryText(page)[0] === "You stopped the service; automatic retry is off", "the window's end");
  assert.equal(page.headline(), "Stopped as you requested");
  assert.doesNotMatch(page.lifecycle().textContent, /Your choice to keep it stopped is recorded\./, "said once");
  assert.equal(page.button("Retry the same request"), undefined);
  assert.deepEqual(page.errors, []);
});

test("a retry in launch preparation: a stop may let it run briefly; opting out keeps this round", async (t) => {
  const page = mount();
  t.after(page.close);
  page.core.service = windowAt(retryJob({ status: "starting", reserved: true }), { state: "retry", launch: "starting", notBefore: "2026-10-31T00:42:00Z" });
  page.window.portal.open(target(page.core.service));
  await until(() => page.headline() === "Automatic retry 2 is preparing to start", "starting");
  assert.deepEqual(recoveryText(page), ["Automatic retry 2 of 3 is preparing to start"]);
  assert.match(page.panel().querySelector(".portal-idle").textContent, /^Preparing an automatic retry/);
  assert.match(page.lifecycle().querySelector(".service-recovery-off").textContent, /This round continues; no automatic retries after it$/);
  page.click(page.button("Stop service…", page.lifecycle()));
  const dialog = await until(page.dialog, "the stop confirmation");
  assert.match(dialog.textContent, /This also stops this retry; nothing starts automatically afterwards\. The retry being prepared may run briefly before it stops\./);
  assert.deepEqual(page.errors, []);
});

test("a refused opt-out sends nothing more and offers no resend", async (t) => {
  const page = mount();
  t.after(page.close);
  page.core.service = waiting();
  page.core.control = () => ({ status: 400, body: { error: "recovery_off: automatic retry is not on for this service" } });
  page.window.portal.open(target(page.core.service));
  await until(() => page.lifecycle() && page.button("Turn off automatic retry", page.lifecycle()), "the opt-out");
  page.click(page.button("Turn off automatic retry", page.lifecycle()));
  await until(() => /recovery_off/.test(page.lifecycle().textContent), "the refusal said");
  assert.equal(page.button("Retry the same request"), undefined, "a refusal is no unknown outcome");
  await tick(80);
  assert.equal(page.posts("recovery").length, 1);
  assert.deepEqual(page.errors, []);
});

test("each end of the window is said, with the current Job's own line after a Core restart", async (t) => {
  const page = mount();
  t.after(page.close);
  const ended = (extra) => retryJob({ canStop: false, finishedAt: "2026-10-31T00:44:00Z", ...extra });
  const unknownRun = (extra = {}) => retryJob({ status: "unknown", reserved: true, canStop: true, startedAt: "2026-10-31T00:42:05Z", ...extra });
  const cases = [
    ["exhausted", windowAt(ended({ status: "failed", startedAt: "2026-10-31T00:42:05Z" }), { state: "exhausted", launch: null, retry: { scheduled: 3, started: 3, max: 3 } }, { canStart: true }),
      ["All 3 automatic retries are used · start again manually when needed"], { start: true, stop: false }],
    ["too little time", windowAt(ended({ status: "rejected" }), { state: "ended", launch: null, haltedReason: "insufficient_time" }, { canStart: true }),
      ["Less than 1 minute of run time left; no more automatic retries"], { start: true, stop: false, process: "Didn't start this round" }],
    ["Core restart, never started", windowAt(ended({ status: "rejected" }), { state: "halted", launch: null, haltedReason: "core_restart" }, { canStart: true }),
      ["Automatic retry is off (Core restarted)", "Current retry: confirmed not started"], { start: true, stop: false }],
    ["Core restart, running", windowAt(retryJob({ status: "running", reserved: true, startedAt: "2026-10-31T00:42:05Z", owner: "verified" }), { state: "halted", launch: "running", haltedReason: "core_restart" }),
      ["Automatic retry is off (Core restarted)", "Current run: still running"], { start: false, stop: true }],
    ["Core restart, starting", windowAt(retryJob({ status: "starting", reserved: true }), { state: "halted", launch: "starting", haltedReason: "core_restart" }),
      ["Automatic retry is off (Core restarted)", "Current retry: preparing to start"], { start: false, stop: true }],
    ["Core restart, unknown", windowAt(unknownRun(), { state: "halted", launch: "unknown", haltedReason: "core_restart" }, {}),
      ["Automatic retry is off (Core restarted)", "Current run: needs checking"], { start: false, stop: true }],
    ["Core restart, unknown, stop asked", withRecovery(windowAt(unknownRun({ status: "cancelling", canStop: false, cancelRequestedAt: "2026-10-31T00:45:00Z" }),
      { state: "halted", launch: "stopping", haltedReason: "core_restart" }), windowAt(unknownRun(), { state: "halted", launch: "stopping", haltedReason: "core_restart" }).lifecycle.recovery, { outcomeUnknown: true }),
      ["Automatic retry is off (Core restarted)", "Current run: needs checking · stop requested, waiting for confirmation"], { start: false, stop: false, headline: "This run still needs checking" }],
    ["unknown outcome, stop asked", withRecovery(windowAt(unknownRun({ canStop: false, cancelRequestedAt: "2026-10-31T00:45:00Z" }), {}),
      recovery({ state: "halted", launch: "unknown", haltedReason: "unknown_outcome", retry: { scheduled: 2, started: 2, max: 3 }, retryJobId: "j3", lastFailure,
        attempts: [...history, { retry: 2, jobId: "j3", startedAt: "2026-10-31T00:42:05Z", endedAt: null, outcome: null }] }), { outcomeUnknown: true }),
      ["The outcome needs checking; nothing is resent automatically", "Still needs checking · stop requested, waiting for confirmation"], { start: false, stop: false, headline: "This run still needs checking" }],
    ["superseded", withRecovery(service({ job: job({ jobId: "j9" }), intent: armedIntent }), recovery({ state: "ended", launch: "running", haltedReason: "superseded", retry: { scheduled: 2, started: 2, max: 3 }, attempts: history })),
      ["Another run took over; automatic retry has ended"], { start: false, stop: true }],
  ];
  for (const [name, shown, lines, expect] of cases) {
    page.window.portal.close();
    await until(() => !page.panel(), "the Portal closed");
    page.core.service = shown;
    page.window.portal.open(target(shown));
    await until(() => JSON.stringify(recoveryText(page)) === JSON.stringify(lines), `${name}: ${lines.join(" / ")}`);
    assert.equal(!!page.button("Start again…", page.lifecycle()), expect.start, `${name}: start`);
    assert.equal(!!page.button("Stop service…", page.lifecycle()), expect.stop, `${name}: stop`);
    assert.equal(page.button("Turn off automatic retry", page.lifecycle()), undefined, `${name}: nothing left to turn off`);
    if (expect.process) assert.match(page.fact("process"), new RegExp(`^Process${expect.process}`), name);
    if (expect.headline) assert.equal(page.headline(), expect.headline, name);
    assert.doesNotMatch(page.lifecycle().textContent, /Stopped as you requested/, `${name}: never stopped before it is`);
    // While the outcome is unconfirmed there is no manual start to point to.
    assert.equal(page.lifecycle().querySelector(".service-manual").textContent,
      /needs checking|The outcome needs checking/.test(lines.join(" ")) ? "Automatic retry has ended" : "Automatic retry has ended · start again manually when needed", name);
  }
  assert.deepEqual(page.requests.filter((r) => r.method === "POST"), [], "reading sends nothing");
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
  // The read that brought j2 is in; then the confirmation is pressed.
  // (An older Portal read first on its 5-second poll.)
  await until(() => page.requests.some((r) => r.url === "/api/projects/p1/services"), "the read", 7000);
  await tick(80);
  page.click(confirm);
  await tick(80);
  assert.deepEqual(page.requests.filter((r) => r.url.includes("/cancel")).map((r) => r.url), [], "neither Job cancelled");
  assert.match(section.textContent, /now refers to another Job/);
  assert.ok(confirm.disabled);
  assert.deepEqual(page.errors, []);
});

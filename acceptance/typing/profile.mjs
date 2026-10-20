// T-18: what typing costs while a long conversation streams. Run against the
// lab Core (lab.py start/serve WEB_DIR); the same fixture serves each build.
//
//   node acceptance/typing/profile.mjs LABEL [--attribution]
//
// Three Agents stream 20 deltas/s each (the open one included). Four windows:
// idle (10 s), typing (180 characters, 60 ms apart), holding Backspace for
// 10 s (repeat keydowns at up to ~30/s over a 1500-character draft) and one
// 20 020-character paste (Ctrl+V; "largeInsert" if the clipboard fails).
// Per window: React commits; keydowns, repeats, achieved key rate and gaps;
// input events by type; long tasks; frame gaps; Event Timing for key events
// (only those of 16 ms or more are reported by the browser); for the open
// Agent, SSE callback start to its text in the DOM (a mutation, not a paint);
// runtime emit to SSE callback and to the DOM (same machine clock);
// localStorage writes; Chromium's script/layout/style time. Draft lengths and
// deleted characters are checked against the input events; a mismatch makes
// the run "inconsistent". --attribution also counts which components
// rendered; that walk costs time, so its timings are not compared.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const lab = path.join(root, "target/t18/lab");
const label = process.argv[2];
if (!label) throw new Error("usage: profile.mjs LABEL [--attribution]");
const attribution = process.argv.includes("--attribution");
const state = JSON.parse(await readFile(path.join(lab, "lab.json"), "utf8"));
const api = (method, p, body) => fetch(`${state.base}/api${p}`, {
  method, headers: { "content-type": "application/json", "x-yuzuno-client": "desktop" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());

function instrument({ attribution, openAgent }) {
  const S = (window.__t18 = {});
  const now = () => performance.now();
  S.reset = () => Object.assign(S, { t0: now(), commits: 0, renders: {}, longtasks: [], frames: [], events: [],
    keydowns: [], inputs: {}, pastes: 0, recv: {}, dom: {}, storage: {} });
  S.reset();
  // React calls this hook when it exists before React loads.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, fiberRoot) {
      S.commits++;
      if (!attribution) return;
      // Descend only where children were reconciled; a function component
      // rendered if it mounted or carries PerformedWork (flag 1).
      const stack = [fiberRoot.current];
      while (stack.length) {
        const f = stack.pop();
        const type = typeof f.type === "function" ? f.type : f.type && (f.type.type || f.type.render);
        if (typeof type === "function" && (!f.alternate || (f.flags & 1))) {
          const name = type.displayName || type.name || "anonymous";
          S.renders[name] = (S.renders[name] || 0) + 1;
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child && (!f.alternate || f.child !== f.alternate.child)) stack.push(f.child);
      }
    },
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) S.longtasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (/^(keydown|keypress|beforeinput|input|keyup|paste)$/.test(e.name))
        S.events.push({ name: e.name, start: e.startTime, duration: e.duration, processing: e.processingEnd - e.processingStart });
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
  // What actually reached the page: keydowns (with auto-repeat), input
  // events by type, real paste events.
  addEventListener("keydown", (e) => S.keydowns.push({ t: now(), repeat: e.repeat }), true);
  addEventListener("input", (e) => { S.inputs[e.inputType] = (S.inputs[e.inputType] || 0) + 1; }, true);
  addEventListener("paste", () => S.pastes++, true);
  const frame = (t) => { S.frames.push(t); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const MARK = /⟦(\d+-\d+)⟧/g;
  const seen = (text, into, agent) => {
    if (!text || !text.includes("⟦")) return;
    const t = now();
    for (const m of text.matchAll(MARK)) if (!(m[1] in into)) into[m[1]] = { t, agent };
  };
  const agentOf = (data) => { try { return JSON.parse(data).agentId; } catch { return undefined; } };
  // The app listens for typed SSE events; note when each callback starts.
  const add = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (type, listener, options) {
    const wrapped = typeof listener === "function"
      ? (e) => { seen(e.data, S.recv, agentOf(e.data)); return listener.call(this, e); } : listener;
    return add.call(this, type, wrapped, options);
  };
  const onmessage = Object.getOwnPropertyDescriptor(EventSource.prototype, "onmessage");
  Object.defineProperty(EventSource.prototype, "onmessage", {
    set(listener) { onmessage.set.call(this, listener && ((e) => { seen(e.data, S.recv, agentOf(e.data)); return listener.call(this, e); })); },
    get() { return onmessage.get.call(this); },
  });
  // When the text is in the DOM (a mutation record, not a paint).
  addEventListener("DOMContentLoaded", () => new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") seen(r.target.data, S.dom);
      else for (const node of r.addedNodes) seen(node.textContent, S.dom);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true }));
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    const t = now();
    try { return setItem.call(this, key, value); } finally {
      const s = (S.storage[key] ||= { count: 0, ms: 0, bytes: 0 });
      s.count++; s.ms += now() - t; s.bytes += String(value).length;
    }
  };
  S.collect = () => {
    const t0 = S.t0, end = now();
    const gaps = S.frames.filter((t) => t >= t0).map((t, i, a) => (i ? t - a[i - 1] : null)).filter((v) => v !== null);
    const long = S.longtasks.filter((e) => e.start >= t0);
    const events = S.events.filter((e) => e.start >= t0);
    // Only the open Agent's stream is shown; the other two are not rendered.
    const open = Object.entries(S.recv).filter(([, r]) => r.t >= t0 && r.agent === openAgent);
    const callbackToDom = open.filter(([k]) => k in S.dom).map(([k, r]) => S.dom[k].t - r.t);
    // Received in the last 0.5 s may simply not be applied yet.
    const notInDom = open.filter(([k, r]) => !(k in S.dom) && r.t < end - 500).length;
    const domEpoch = Object.fromEntries(open.filter(([k]) => k in S.dom).map(([k]) => [k, performance.timeOrigin + S.dom[k].t]));
    const recvEpoch = Object.fromEntries(Object.entries(S.recv).filter(([, r]) => r.t >= t0)
      .map(([k, r]) => [k, performance.timeOrigin + r.t]));
    const keyGaps = S.keydowns.map((k, i, a) => (i ? k.t - a[i - 1].t : null)).filter((v) => v !== null);
    return { seconds: (end - t0) / 1000, commits: S.commits, renders: S.renders,
      keydowns: S.keydowns.length, repeats: S.keydowns.filter((k) => k.repeat).length, keyGaps,
      keySpan: S.keydowns.length > 1 ? (S.keydowns.at(-1).t - S.keydowns[0].t) / 1000 : 0,
      inputs: S.inputs, pastes: S.pastes,
      longtasks: { count: long.length, ms: long.reduce((s, e) => s + e.duration, 0), max: Math.max(0, ...long.map((e) => e.duration)) },
      gaps, events, callbackToDom, notInDom, openReceived: open.length, domEpoch, recvEpoch, storage: S.storage };
  };
}

const pct = (values, q) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))];
};
const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
const dist = (values) => ({ n: values.length, p50: round(pct(values, 0.5)), p95: round(pct(values, 0.95)), max: round(pct(values, 1)) });

async function emitted() {
  const times = {};
  for (const file of await readdir(path.join(lab, "timeline"))) {
    for (const line of (await readFile(path.join(lab, "timeline", file), "utf8")).split("\n")) {
      if (line) { const row = JSON.parse(line); times[row.marker] = row.t * 1000; }
    }
  }
  return times;
}

const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
const report = { label, attribution, windows: {}, web: state.web };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: state.base });
  const page = await context.newPage();
  await page.addInitScript(instrument, { attribution, openAgent: state.agents.Long });
  await page.addInitScript((id) => {
    localStorage.setItem("yuzuno.selected", JSON.stringify(id));
    localStorage.removeItem("yuzuno.drafts");
  }, state.agents.Long);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  await page.goto(`${state.base}/?shell=desktop`);
  const composer = page.getByRole("textbox", { name: /^Message Long/ });
  await composer.waitFor();
  await page.waitForTimeout(1500);
  report.turnsShown = await page.locator(".turn, [data-turn-id]").count();
  // A lab Core restarted for another build leaves its Agents offline with a
  // stale running Turn; reconnecting settles that. Streams of an earlier run
  // must also have finished: a new message would steer them.
  for (const id of Object.values(state.agents)) {
    await api("POST", `/agents/${id}/reconnect`);
    for (let i = 0; i < 120; i++) {
      const d = await api("GET", `/agents/${id}`);
      if (!d.turns.some((t) => t.status === "inProgress")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // Stream on all three Agents for the whole run.
  for (const id of Object.values(state.agents))
    await api("POST", `/agents/${id}/messages`, { clientMessageId: `${label}-${id}-${Date.now()}`, text: "stream:70:20" });
  await page.waitForTimeout(3000);
  report.streaming = await page.evaluate(() => Object.keys(window.__t18.recv).length > 0);
  if (!report.streaming) throw new Error("the streams did not start; nothing to measure against");
  const run = async (name, act) => {
    const before = await metrics();
    await page.evaluate(() => window.__t18.reset());
    const extra = (await act()) || {};
    const raw = await page.evaluate(() => window.__t18.collect());
    const after = await metrics();
    const sent = await emitted();
    // Same machine, same wall clock: the runtime's time.time() and the page's
    // timeOrigin + performance.now() are directly comparable.
    const toCallback = Object.entries(raw.recvEpoch).filter(([k]) => k in sent).map(([k, t]) => t - sent[k]);
    const toDom = Object.entries(raw.domEpoch).filter(([k]) => k in sent).map(([k, t]) => t - sent[k]);
    const keyEvents = raw.events.filter((e) => /key|input/.test(e.name));
    report.windows[name] = {
      seconds: round(raw.seconds), commits: raw.commits, commitsPerSecond: round(raw.commits / raw.seconds),
      keydowns: raw.keydowns, repeats: raw.repeats, keysPerSecond: raw.keySpan ? round(raw.keydowns / raw.keySpan) : null,
      keyGapMs: dist(raw.keyGaps), inputs: raw.inputs, pastes: raw.pastes,
      longtasks: { count: raw.longtasks.count, ms: round(raw.longtasks.ms), max: round(raw.longtasks.max) },
      frameGapMs: { ...dist(raw.gaps), over50: raw.gaps.filter((g) => g > 50).length },
      // Event Timing reports only events of 16 ms or more; the rest are faster.
      keyEventsOver16ms: { ...dist(keyEvents.map((e) => e.duration)), over50: keyEvents.filter((e) => e.duration > 50).length,
        ofKeydowns: raw.keydowns },
      // Open Agent only: SSE callback start to the text in the DOM (a mutation
      // record, not a paint; queueing before the callback is not included).
      sseCallbackToDomMs: dist(raw.callbackToDom), openReceived: raw.openReceived, openNotInDom: raw.notInDom,
      // Runtime emit to SSE callback (all Agents) and to the DOM (open Agent).
      runtimeToCallbackMs: dist(toCallback), runtimeToDomMs: dist(toDom),
      storage: Object.fromEntries(Object.entries(raw.storage).map(([k, s]) => [k, { count: s.count, ms: round(s.ms), kb: round(s.bytes / 1024) }])),
      chromiumMs: Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"]
        .map((k) => [k, round((after[k] - before[k]) * 1000)])),
      ...(attribution ? { renders: Object.fromEntries(Object.entries(raw.renders).sort((a, b) => b[1] - a[1]).slice(0, 25)) } : {}),
      ...extra,
    };
  };
  const problems = [];
  await run("idle", () => page.waitForTimeout(10000));
  await composer.click();
  const typed = "The quick brown fox jumps over the lazy dog. ".repeat(4);
  await run("typing", async () => {
    const start = Date.now();
    await composer.pressSequentially(typed, { delay: 60 });
    const draft = await composer.inputValue();
    if (draft !== typed) problems.push(`typing: draft ${draft.length} chars, expected ${typed.length}`);
    return { typed: typed.length, draftLength: draft.length, actSeconds: round((Date.now() - start) / 1000) };
  });
  await composer.fill("x".repeat(1500));
  await composer.press("End");
  await run("backspace", async () => {
    const before = (await composer.inputValue()).length;
    const start = Date.now();
    const end = start + 10000;
    await page.keyboard.down("Backspace");
    // A held key: further keydowns with repeat=true, ~30/s. Injection waits
    // for each to be dispatched, so a busy page lowers the achieved rate;
    // keysPerSecond and keyGapMs report what was achieved.
    while (Date.now() < end) {
      await page.keyboard.down("Backspace");
      await page.waitForTimeout(33);
    }
    await page.keyboard.up("Backspace");
    await page.waitForTimeout(300);
    const after = (await composer.inputValue()).length;
    return { draftBefore: before, draftAfter: after, deleted: before - after, actSeconds: round((Date.now() - start) / 1000) };
  });
  const back = report.windows.backspace;
  if (back.deleted !== (back.inputs.deleteContentBackward || 0) || back.deleted !== back.keydowns || back.repeats !== back.keydowns - 1)
    problems.push(`backspace: deleted ${back.deleted}, delete inputs ${back.inputs.deleteContentBackward}, keydowns ${back.keydowns}, repeats ${back.repeats}`);
  await composer.fill("");
  const pasteText = "Pasted line of a long note.\n".repeat(715);
  await run("paste", async () => {
    // A real paste (Ctrl+V from the clipboard); if the clipboard is not
    // available this is reported as a large insert instead.
    let kind = "paste";
    try {
      await page.evaluate((text) => navigator.clipboard.writeText(text), pasteText);
      await composer.press("Control+V");
    } catch {
      kind = "largeInsert";
      await page.keyboard.insertText(pasteText);
    }
    await page.waitForTimeout(5000);
    const length = (await composer.inputValue()).length;
    if (length !== pasteText.length) problems.push(`${kind}: draft ${length} chars, expected ${pasteText.length}`);
    return { kind, draftLength: length };
  });
  if (report.windows.paste.kind === "paste" && report.windows.paste.pastes !== 1) problems.push(`paste: ${report.windows.paste.pastes} paste events`);
  report.problems = problems;
  report.status = problems.length ? "inconsistent" : "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack || error);
} finally {
  await browser.close();
  await mkdir(path.join(root, "target/t18/runs"), { recursive: true });
  await writeFile(path.join(root, `target/t18/runs/${label}${attribution ? "-attribution" : ""}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1).slice(0, 6000));
}

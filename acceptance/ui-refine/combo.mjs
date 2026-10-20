// T-34: the request pin and the whole-box composer while a long conversation
// streams and Backspace is held. A bounded check, not a measurement series;
// T-18's before/after figures (acceptance/typing) stay as they are.
//
//   python3 acceptance/ui-refine/lab.py start WEB_DIR
//   node acceptance/ui-refine/combo.mjs
//   python3 acceptance/ui-refine/lab.py stop
//
// All three Agents stream 20 deltas/s. With the request pin hidden (original
// request in view), shown (following the stream) and open, Backspace is held
// for 4 s over a 600-character draft. Each window checks: deleted characters
// equal delete inputs and keydowns; the pin keeps its state; a hidden pin's
// reading position does not move; the stream keeps reaching the DOM; the
// composer keeps focus. Then the composer: a press on its status line puts
// the caret at the end; a press inside the text keeps the caret there; a
// control in the box (and its dialog's overlay) leaves the selection and
// draft; undo steps back to exactly the text before the typing and before a
// held Backspace; the draft survives an Agent switch.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const lab = path.join(root, "target/t34/lab");
const state = JSON.parse(await readFile(path.join(lab, "lab.json"), "utf8"));
const api = (method, p, body) => fetch(`${state.base}/api${p}`, {
  method, headers: { "content-type": "application/json", "x-yuzuno-client": "desktop" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());

function instrument(openAgent) {
  const S = (window.__t34 = {});
  const now = () => performance.now();
  S.reset = () => Object.assign(S, { t0: now(), keydowns: [], inputs: {}, longtasks: [], frames: [], dom: 0 });
  S.reset();
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) S.longtasks.push(e.duration);
  }).observe({ type: "longtask", buffered: true });
  addEventListener("keydown", (e) => S.keydowns.push({ t: now(), repeat: e.repeat }), true);
  addEventListener("input", (e) => { S.inputs[e.inputType] = (S.inputs[e.inputType] || 0) + 1; }, true);
  const frame = (t) => { S.frames.push(t); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  // Stream markers (⟦n-m⟧) of the open Agent reaching the DOM.
  addEventListener("DOMContentLoaded", () => new MutationObserver((records) => {
    for (const r of records) {
      const text = r.type === "characterData" ? r.target.data : [...r.addedNodes].map((n) => n.textContent).join("");
      if (text && text.includes("⟦")) S.dom += (text.match(/⟦\d+-\d+⟧/g) || []).length;
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true }));
  S.collect = () => {
    const frames = S.frames.filter((t) => t >= S.t0);
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const span = S.keydowns.length > 1 ? (S.keydowns.at(-1).t - S.keydowns[0].t) / 1000 : 0;
    return {
      keydowns: S.keydowns.length, repeats: S.keydowns.filter((k) => k.repeat).length,
      keysPerSecond: span ? Math.round((S.keydowns.length / span) * 10) / 10 : null,
      inputs: S.inputs, streamMarksInDom: S.dom,
      longtasks: { count: S.longtasks.length, ms: Math.round(S.longtasks.reduce((a, b) => a + b, 0)) },
      frameGapP95: gaps.length ? Math.round(gaps[Math.floor(gaps.length * 0.95)]) : null,
    };
  };
}

const report = { web: state.web, windows: {}, composer: {}, problems: [] };
const problem = (text) => report.problems.push(text);
const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(instrument, state.agents.Long);
  await page.addInitScript((id) => {
    if (!sessionStorage.getItem("t34-started")) {
      sessionStorage.setItem("t34-started", "1");
      localStorage.setItem("yuzuno.selected", JSON.stringify(id));
      localStorage.removeItem("yuzuno.drafts");
    }
  }, state.agents.Long);
  // Earlier streams must have finished: a new message would steer them.
  for (const id of Object.values(state.agents)) {
    await api("POST", `/agents/${id}/reconnect`);
    for (let i = 0; i < 120; i++) {
      const d = await api("GET", `/agents/${id}`);
      if (!d.turns.some((t) => t.status === "inProgress")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await page.goto(`${state.base}/?shell=desktop`);
  const composer = page.getByRole("textbox", { name: /^Message Long/ });
  await composer.waitFor();
  for (const id of Object.values(state.agents))
    await api("POST", `/agents/${id}/messages`, { clientMessageId: `t34-${id}-${Date.now()}`, text: "stream:90:20" });
  const pin = page.locator(".current-turn-prompt");
  await pin.waitFor({ state: "attached" });
  await page.waitForTimeout(3000);
  const pinState = () => pin.evaluate((el) => ({ pinned: el.dataset.pinned === "true", open: el.open }));
  const requestBox = () => page.evaluate(() => {
    const turn = [...document.querySelectorAll(".turn[data-turn-id]")].at(-1);
    return turn.querySelector(".user-message").getBoundingClientRect().top;
  });
  // Scroll to the end as a reader would. (Back to latest's smooth scroll can
  // stop short while a stream grows fast; that also happens on main effccee,
  // so it is not what this check is about.)
  const toLatest = async () => {
    await page.locator(".conversation-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(() => {
      const el = document.querySelector(".conversation-scroll");
      return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    });
  };
  const hold = async (name, setup, expect) => {
    await setup();
    await composer.fill("x".repeat(600));
    await composer.press("End");
    const before = { pin: await pinState(), request: await requestBox() };
    await page.evaluate(() => window.__t34.reset());
    const draftBefore = (await composer.inputValue()).length;
    await page.keyboard.down("Backspace");
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      await page.keyboard.down("Backspace");
      await page.waitForTimeout(33);
    }
    await page.keyboard.up("Backspace");
    await page.waitForTimeout(300);
    const raw = await page.evaluate(() => window.__t34.collect());
    const deleted = draftBefore - (await composer.inputValue()).length;
    const after = { pin: await pinState(), request: await requestBox() };
    const focused = await composer.evaluate((el) => document.activeElement === el);
    report.windows[name] = { ...raw, deleted, pinBefore: before.pin, pinAfter: after.pin, focused,
      requestMovedPx: Math.round(after.request - before.request) };
    if (deleted !== (raw.inputs.deleteContentBackward || 0) || deleted !== raw.keydowns || raw.repeats !== raw.keydowns - 1)
      problem(`${name}: deleted ${deleted}, delete inputs ${raw.inputs.deleteContentBackward}, keydowns ${raw.keydowns}, repeats ${raw.repeats}`);
    if (JSON.stringify(before.pin) !== JSON.stringify(expect) || JSON.stringify(after.pin) !== JSON.stringify(expect))
      problem(`${name}: pin ${JSON.stringify(before.pin)} -> ${JSON.stringify(after.pin)}, expected ${JSON.stringify(expect)}`);
    if (!expect.pinned && Math.abs(after.request - before.request) > 1)
      problem(`${name}: the reading position moved ${after.request - before.request}px`);
    if (!raw.streamMarksInDom) problem(`${name}: no streamed text reached the DOM`);
    if (!focused) problem(`${name}: the composer lost focus`);
  };

  await hold("pin hidden", async () => {
    // The request in view: the reader scrolled up from the stream.
    await page.locator(".conversation-scroll").evaluate((el) => {
      const turn = [...el.querySelectorAll(".turn[data-turn-id]")].at(-1);
      const box = turn.querySelector(".user-message").getBoundingClientRect();
      el.scrollTop += box.top - el.getBoundingClientRect().top - 200;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(300);
    await composer.focus();
  }, { pinned: false, open: false });
  await hold("pin shown", async () => {
    await toLatest();
    await page.waitForFunction(() => document.querySelector(".current-turn-prompt").dataset.pinned === "true");
    await composer.focus();
  }, { pinned: true, open: false });
  await hold("pin open", async () => {
    await toLatest();
    await pin.locator("summary").click();
    await composer.focus();
  }, { pinned: true, open: true });
  await pin.evaluate((el) => { el.open = false; });

  // The whole composer box is the input.
  const C = report.composer;
  await composer.fill("first line");
  await page.evaluate(() => document.activeElement.blur());
  await page.locator(".composer-bottom > span").click();
  C.statusLinePress = await composer.evaluate((el) => ({ focused: document.activeElement === el, caret: el.selectionStart, length: el.value.length }));
  if (!C.statusLinePress.focused || C.statusLinePress.caret !== C.statusLinePress.length) problem(`status line press: ${JSON.stringify(C.statusLinePress)}`);
  // A press inside the text keeps the caret where it was pressed.
  const box = await composer.boundingBox();
  await page.mouse.click(box.x + 20, box.y + 22);
  C.textPress = await composer.evaluate((el) => ({ caret: el.selectionStart, length: el.value.length }));
  if (C.textPress.caret >= C.textPress.length) problem(`press inside the text moved the caret to the end: ${JSON.stringify(C.textPress)}`);
  // A control in the box still works and leaves the selection and draft.
  await composer.evaluate((el) => el.setSelectionRange(0, 5));
  await page.getByRole("button", { name: "Ask for an interactive result" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.mouse.click(5, 5); // the dialog overlay
  await dialog.waitFor({ state: "detached" });
  C.control = await composer.evaluate((el) => ({ value: el.value, selection: [el.selectionStart, el.selectionEnd] }));
  if (C.control.value !== "first line" || C.control.selection.join() !== "0,5") problem(`control press: ${JSON.stringify(C.control)}`);
  // Undo steps back through what was typed after a status-line press, and
  // through a held Backspace, to exactly the earlier text. (How many steps
  // Chromium groups per undo is its own; with injected keys it is one
  // character each, on main effccee as well.)
  const undoUntil = async (target, limit) => {
    const seen = [];
    for (let i = 0; i < limit; i++) {
      const value = await composer.inputValue();
      if (value === target) break;
      await page.keyboard.press("Control+z");
      seen.push(await composer.inputValue());
    }
    return seen;
  };
  await page.evaluate(() => document.activeElement.blur());
  await page.locator(".composer-bottom > span").click();
  await page.keyboard.type(" and more");
  const typingSteps = await undoUntil("first line", 12);
  C.undoTyping = { steps: typingSteps.length, last: typingSteps.at(-1) };
  if (typingSteps.at(-1) !== "first line" || typingSteps.some((v) => !(" and more".startsWith(v.slice(10)) && v.startsWith("first line"))))
    problem(`undo after typing: ${JSON.stringify(typingSteps)}`);
  await page.keyboard.type(" and more");
  const full = await composer.inputValue();
  await page.keyboard.down("Backspace");
  for (let i = 0; i < 4; i++) { await page.keyboard.down("Backspace"); await page.waitForTimeout(33); }
  await page.keyboard.up("Backspace");
  const shortened = await composer.inputValue();
  const backSteps = await undoUntil(full, 8);
  C.undoBackspace = { shortened, steps: backSteps.length, restored: backSteps.at(-1) };
  if (shortened.length !== full.length - 5 || backSteps.at(-1) !== full)
    problem(`undo after Backspace: ${JSON.stringify(C.undoBackspace)}`);
  // The draft (as React holds it) survives switching Agents and back.
  const draft = await composer.inputValue();
  await page.locator(`[data-agent-id="${state.agents["Busy one"]}"]`).click();
  await page.getByRole("textbox", { name: /^Message Busy one/ }).waitFor();
  await page.locator(`[data-agent-id="${state.agents.Long}"]`).click();
  await composer.waitFor();
  C.draftAfterSwitch = { before: draft, after: await composer.inputValue() };
  if (C.draftAfterSwitch.after !== draft) problem(`draft after switching Agents: ${JSON.stringify(C.draftAfterSwitch)}`);
  report.pageErrors = errors;
  if (errors.length) problem(`page errors: ${errors.join(" | ")}`);
  report.status = report.problems.length ? "failed" : "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack || error);
} finally {
  await browser.close();
  await mkdir(path.join(root, "target/t34/runs"), { recursive: true });
  await writeFile(path.join(root, "target/t34/runs/combo.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  if (report.status !== "passed") process.exitCode = 1;
}

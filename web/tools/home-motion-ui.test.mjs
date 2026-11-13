// Home's own motion rows left to T-51 (T-19 HM:H2, H3, H7, H15, S11), in jsdom: Refresh says it is busy while the read
// it asked for is on its way; the error banner floats in its own slot and leaves; a moved project's arrow keeps the focus
// as the order saves and as a refused order puts it back; a reply's project gone, the note saying so is brought into
// view and settles; a kept reply's Copy text says it copied, or that it could not. jsdom lays nothing out and plays
// nothing; the overlay, the fades and A4's held height are the Chromium check's (home-motion-check.mjs).
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const web = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(web, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-motion-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(web, "src/home/Home.tsx"))};
import {cardReplySlot} from ${JSON.stringify(path.join(web, "src/home/CardReply.tsx"))};
window.cardReplySlot=cardReplySlot;
const root=createRoot(document.getElementById('root'));
// A Project's page opens as the app opens it (YN-86): its id, and a jump to the card named.
function Shell({workspaceId,revision,arrival,start}){
  const [project,setProject]=React.useState(start);
  const [jump,setJump]=React.useState(null);
  return <Home workspaceId={workspaceId} revision={revision} jobsRevision={0} agents={[]} projects={[]} readOnly={false} arrival={arrival} onBackToReply={()=>{}} onNavigate={()=>{}} onChanged={()=>{}}
    project={project} jumpTo={jump} onOpenProject={(id,key)=>{setProject(id);setJump((j)=>({projectId:id,sectionKey:key,n:(j?.n??0)+1}));}} onCloseProject={()=>setProject(null)}/>;
}
window.renderHome=(workspaceId,revision=0,arrival=null,project=null)=>root.render(<Shell workspaceId={workspaceId} revision={revision} arrival={arrival} start={project}/>);`,
  );
  const result = await build({
    root: web, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeMotion", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((x) => x.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((r) => setTimeout(r, 20));
async function until(predicate, label) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`${label} should settle`);
}
/** Waits for `predicate` a while and says whether it came: the assertion after says what was wanted. */
async function came(predicate) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return true;
    await tick();
  }
  return false;
}
const owner = { agentId: "a", name: "Mina", state: "active" };
const body = { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text: "A useful result." } } } };
const section = (id, key, title) => ({ id, key, kind: "report", title, version: 1, owner, updatedAt: "2026-11-05T10:00:00Z",
  updatedTurnId: null, body, attachments: [], refs: {}, seen: null, history: false });
const panel = (id, name) => ({ project: { id, name }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 1, sections: [section(Number(id.slice(1)), `card-${id}`, `${name} result`)], history: [] } });
const home = (order = ["p1", "p2"]) => ({ generatedAt: "2026-11-05T10:00:00Z", order, needsYou: [],
  projects: [panel("p1", "Northstar"), panel("p2", "Atlas")] });

/** Home in jsdom; `answer(url, init)` gives each request's answer: a value, or { status, body } for a refusal. */
function mount(answer) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.test", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const scrolls = [];
  w.HTMLElement.prototype.scrollIntoView = function (options) { scrolls.push({ el: this, options }); };
  // jsdom has no element scrolling; a Project's page starts at its top (Home.tsx).
  w.HTMLElement.prototype.scrollTo = function () {};
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.fetch = async (url, init = {}) => {
    const value = await answer(String(url), init);
    const refused = value && typeof value === "object" && "status" in value && value.status >= 400;
    return { ok: !refused, status: refused ? value.status : 200, headers: new w.Headers(),
      json: async () => structuredClone(refused ? value.body : value), text: async () => JSON.stringify(refused ? value.body : value) };
  };
  w.eval(bundle);
  return { w, doc: w.document, errors, scrolls, close: () => w.close() };
}
const others = (url) =>
  url.includes("github_repositories")
    ? { repositories: [], links: [] }
    : url.endsWith("/api/machine-live")
      ? { machines: [] }
      : {};
const refresh = (p) => p.doc.querySelector('[aria-label="Refresh Home"]');

test("Refresh says it is busy, its icon turning, while the read it asked for is on its way; Home's own reads say nothing (T-19 HM:H3)", async () => {
  const reads = [];
  const p = mount((url) => (url.endsWith("/api/home") ? new Promise((resolve) => reads.push(resolve)) : others(url)));
  try {
    p.w.renderHome("ws");
    await until(() => reads.length === 1, "the first read");
    reads[0](home());
    await until(() => p.doc.querySelector("[data-glance-project]"), "the projects");
    assert.equal(refresh(p).hasAttribute("aria-busy"), false, "not busy before");
    refresh(p).click();
    await until(() => reads.length === 2, "the read Refresh asked for");
    assert.equal(refresh(p).getAttribute("aria-busy"), "true", "busy while it reads");
    assert.equal(refresh(p).querySelector("svg").classList.contains("spin"), true, "its icon turns");
    reads[1](home());
    await until(() => !refresh(p).hasAttribute("aria-busy"), "the read answered");
    assert.equal(refresh(p).querySelector("svg").classList.contains("spin"), false, "and stands still");
    // A read Home makes on its own (a new revision) shows nothing on Refresh.
    p.w.renderHome("ws", 1);
    await until(() => reads.length === 3, "Home's own read");
    assert.equal(refresh(p).hasAttribute("aria-busy"), false, "Home's own read says nothing");
    reads[2](home());
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("the error banner shows in its own slot over what is below, and leaves when the next read answers (T-19 HM:H2)", async () => {
  let fail = true;
  const p = mount((url) => {
    if (!url.endsWith("/api/home")) return others(url);
    if (fail) { fail = false; return { status: 503, body: { error: "Core is restarting" } }; }
    return home();
  });
  try {
    p.w.renderHome("ws");
    await until(() => p.doc.querySelector(".home-error-banner"), "the banner");
    const banner = p.doc.querySelector(".home-error-banner");
    assert.equal(banner.parentElement.classList.contains("home-error-slot"), true, "in a slot of its own, over what is below");
    assert.match(banner.textContent, /Core is restarting/);
    // jsdom has no motion tokens, so the banner goes at once; its fade out is the Chromium check's.
    refresh(p).click();
    await until(() => !p.doc.querySelector(".home-error-banner"), "the banner gone");
    assert.equal(!!p.doc.querySelector(".home-error-slot"), false, "and its slot");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("as the next read answers, the banner that leaves is the one that showed, on its way out, never a second alert (T-19 HM:H2, PR 620 R1)", async () => {
  let fail = true;
  const p = mount((url) => {
    if (!url.endsWith("/api/home")) return others(url);
    if (fail) { fail = false; return { status: 503, body: { error: "Core is restarting" } }; }
    return home();
  });
  // jsdom has no CSS: an exit-small token, so the banner takes its way out as it does in a browser.
  const computed = p.w.getComputedStyle.bind(p.w);
  p.w.getComputedStyle = (el, pseudo) => {
    const style = computed(el, pseudo);
    if (el !== p.doc.documentElement) return style;
    return new Proxy(style, { get: (target, key) => (key === "getPropertyValue"
      ? (name) => (name === "--motion-exit-small" ? "130ms" : target.getPropertyValue(name))
      : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  };
  try {
    p.w.renderHome("ws");
    await until(() => p.doc.querySelector(".home-error-banner"), "the banner");
    const banner = p.doc.querySelector(".home-error-banner");
    const alerts = [];
    new p.w.MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeType === 1 && (node.matches('[role="alert"]') || node.querySelector('[role="alert"]'))) alerts.push(node);
    }).observe(p.doc.body, { childList: true, subtree: true });
    refresh(p).click();
    await until(() => banner.classList.contains("is-leaving") || !banner.isConnected, "the banner leaving");
    assert.equal(banner.isConnected, true, "the banner that showed is the one that leaves");
    assert.equal(banner.classList.contains("is-leaving"), true, "on its way out");
    await until(() => !p.doc.querySelector(".home-error-banner"), "the banner gone");
    assert.equal(alerts.length === 0, true, "no second alert was put in its place");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("a moved project's arrow keeps the focus while the order saves, after, and as a refused order puts it back; unavailable arrows say so and stay focusable (T-19 HM:H7)", async () => {
  let order = ["p1", "p2"];
  const saves = [];
  const p = mount((url, init) => {
    if (url.endsWith("/api/home")) return home(order);
    if (url.endsWith("/api/home/order")) return new Promise((resolve) => saves.push({ resolve, ids: JSON.parse(init.body).projectIds }));
    return others(url);
  });
  const names = { p1: "Northstar", p2: "Atlas" };
  const arrow = (id, dir) => p.doc.querySelector(`[aria-label="Move ${names[id]} ${dir}"]`);
  try {
    p.w.renderHome("ws");
    await until(() => p.doc.querySelectorAll("[data-glance-project]").length === 2, "two projects");
    [...p.doc.querySelectorAll(".home-header-tools button")].find((b) => b.textContent.includes("Reorder")).click();
    await until(() => arrow("p1", "down"), "the arrows");
    assert.equal(arrow("p1", "up").getAttribute("aria-disabled"), "true", "the top project's Up says it is unavailable");
    assert.equal(arrow("p1", "up").disabled, false, "and stays focusable");
    arrow("p1", "down").focus();
    arrow("p1", "down").click();
    await until(() => saves.length === 1, "the order sent");
    assert.equal(p.doc.activeElement, arrow("p1", "down"), "focus stays on the arrow pressed as its project moves");
    assert.equal([...p.doc.querySelectorAll(".home-reorder button")].every((b) => b.getAttribute("aria-disabled") === "true" && !b.disabled), true,
      "while it saves every arrow is unavailable, none disabled");
    arrow("p1", "down").click();
    assert.equal(saves.length, 1, "and pressing one meanwhile sends nothing");
    order = ["p2", "p1"];
    saves[0].resolve({});
    await until(() => arrow("p1", "down").getAttribute("aria-disabled") === "true" && !arrow("p2", "down").hasAttribute("aria-disabled"), "the order saved");
    assert.equal(p.doc.activeElement, arrow("p1", "down"), "and after, now at the end");
    // Up again, refused: the projects go back, the focus with its arrow.
    arrow("p1", "up").focus();
    arrow("p1", "up").click();
    await until(() => saves.length === 2, "the second order sent");
    saves[1].resolve({ status: 409, body: { error: "the order changed" } });
    await until(() => p.doc.querySelector(".home-error-banner"), "the refusal said");
    assert.deepEqual([...p.doc.querySelectorAll("[data-glance-project]")].map((el) => el.dataset.glanceProject), ["p2", "p1"], "the order put back");
    assert.equal(p.doc.activeElement, arrow("p1", "up"), "the focus with the arrow pressed");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("a reply's project no longer on Home: the note saying so is brought into view (nearest) and settles (T-19 HM:H15)", async () => {
  const p = mount((url) => (url.endsWith("/api/home") ? home() : others(url)));
  try {
    const arrival = { origin: { projectId: "p-gone", key: "card-x", version: 2, workspaceId: "ws" },
      back: { workspaceId: "ws", agentId: "a", turnId: "t1", itemId: "i1" }, n: 1 };
    p.w.renderHome("ws", 0, arrival);
    await until(() => p.doc.querySelector(".home-projects > .home-reply-arrival"), "the note");
    const note = p.doc.querySelector(".home-projects > .home-reply-arrival");
    assert.match(note.textContent, /not on Home/);
    assert.equal(await came(() => note.hasAttribute("data-home-highlight")), true, "the note settles");
    const scrolled = p.scrolls.find((s) => s.el === note);
    assert.equal(!!scrolled, true, "brought into view");
    assert.equal(scrolled.options?.block, "nearest", "as near as it is");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("a kept reply's Copy text says it copied, or that it could not (T-19 HM:S11)", async () => {
  for (const clipboard of [true, false]) {
    const p = mount((url) => (url.endsWith("/api/home") ? home() : others(url)));
    try {
      const copied = [];
      if (clipboard) Object.defineProperty(p.w.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
      const slot = p.w.cardReplySlot("ws", "p1", "card-gone");
      p.w.localStorage.setItem("yuzuno.home-card-drafts.v1", JSON.stringify({
        [slot]: { key: "card-gone", text: "Keep the old export", version: 2, title: "Old card", agentId: "a", at: new Date().toISOString() },
      }));
      // Kept on its project's page (YN-86), where its card was.
      p.w.renderHome("ws", 0, null, "p1");
      await until(() => p.doc.querySelector(".home-kept-reply"), "the kept reply");
      const button = [...p.doc.querySelectorAll(".home-kept-reply button")].find((b) => b.textContent.includes("Copy text"));
      assert.equal(!!button, true, "Copy text");
      button.click();
      await came(() => !button.textContent.includes("Copy text"));
      if (clipboard) {
        assert.match(button.textContent, /Copied/, "copied");
        assert.deepEqual(copied, ["Keep the old export"]);
      } else assert.match(button.textContent, /Copy unavailable/, "and, with no clipboard, that it could not");
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

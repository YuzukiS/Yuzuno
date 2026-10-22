import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-85: a Project panel's repository activity. The real RepoActivity in
// JSDOM; Core is a fetch stub and visibility a stub IntersectionObserver.
// No Core, GitHub, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "repo-activity-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {RepoActivity} from ${JSON.stringify(path.join(root, "src/home/RepoActivity.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderActivity=(props)=>flushSync(()=>root.render(<RepoActivity {...props}/>));
window.unmountActivity=()=>flushSync(()=>root.unmount());`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "RepoActivityTest", formats: ["iife"] } },
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

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const sha = (c) => c.repeat(40);
const repo = (extra = {}) => ({
  id: 7,
  fullName: "owner/repo",
  url: "https://github.com/owner/repo",
  defaultBranch: "main",
  observedAt: ago(3),
  commits: [
    { sha: sha("a"), title: "Fix 中文 parsing", author: "mori", at: ago(60), url: `https://github.com/owner/repo/commit/${sha("a")}` },
    { sha: sha("b"), title: "Sneaky link", author: null, at: null, url: "javascript:alert(1)" },
  ],
  pulls: [
    { number: 12, title: "Add Home", author: "hana", url: "https://github.com/owner/repo/pull/12", draft: false, ci: { state: "success" } },
    { number: 13, title: "Draft work", author: null, url: "https://github.com/owner/repo/pull/13", draft: true },
  ],
  pullsTotal: 9,
  runs: [
    { id: 901, name: "CI", branch: "main", status: "completed", conclusion: "failure", at: ago(5), url: "https://github.com/owner/repo/actions/runs/901" },
    { id: 902, name: "Release", branch: "feat/x", status: "in_progress", conclusion: null, at: ago(1), url: "https://evil.test/actions/runs/902" },
  ],
  stale: false,
  ...extra,
});
const linked = [{ id: 7, fullName: "owner/repo", url: "https://github.com/owner/repo" }];

/**
 * `respond(url)` answers a fetch, or returns a promise to hold it. Timers of
 * a minute or more are kept for the test to fire; shorter ones run.
 */
function mount(respond, { observer = false } = {}) {
  const errors = [];
  const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const long = [];
  const setTimer = window.setTimeout.bind(window);
  const clearTimer = window.clearTimeout.bind(window);
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (ms < 60_000) return setTimer(fn, ms, ...args);
    long.push({ fn, ms, cleared: false });
    return 1_000_000 + long.length - 1;
  };
  window.clearTimeout = (id) => {
    if (id >= 1_000_000) {
      if (long[id - 1_000_000]) long[id - 1_000_000].cleared = true;
    } else clearTimer(id);
  };
  const observers = [];
  if (observer)
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(element) {
        this.element = element;
      }
      disconnect() {
        this.disconnected = true;
      }
    };
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", signal: init.signal });
    const { status = 200, body = {} } = (await respond(String(url))) ?? {};
    if (init.signal?.aborted) throw new window.DOMException("aborted", "AbortError");
    const raw = JSON.stringify(body);
    return { ok: status < 400, status, json: async () => body, text: async () => raw };
  };
  window.eval(bundle);
  const document = window.document;
  const pending = () => long.filter((t) => !t.cleared && !t.fired);
  return {
    window,
    document,
    errors,
    requests,
    pending,
    /** Fires the due refresh timers, as if two minutes passed. */
    fire() {
      for (const timer of pending()) {
        timer.fired = true;
        timer.fn();
      }
    },
    see(visible) {
      for (const o of observers.filter((o) => !o.disconnected))
        o.callback([{ isIntersecting: visible, target: o.element }]);
    },
    close: () => window.close(),
  };
}
const text = (page) => page.document.getElementById("root").textContent;

test("each linked repository shows commits, PRs and runs with safe GitHub links", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const page = mount(async () => {
    await held;
    return { body: { observedAt: ago(0), repositories: [repo()] } };
  });
  try {
    page.window.renderActivity({ projectId: "p/app", linked });
    const block = page.document.querySelector(".repo-activity");
    // While loading, the same frame holds the place: name, three lists.
    await until(() => page.requests.length === 1, "one read");
    assert.equal(page.requests[0].url, "/api/projects/p%2Fapp/repo-activity");
    assert.equal(page.requests[0].method, "GET");
    assert.equal(block.getAttribute("aria-busy"), "true");
    assert.ok(block.querySelector(".repo-activity-repo.is-loading"));
    assert.equal(block.querySelectorAll(".repo-activity-lists ul").length, 3);
    assert.equal(block.querySelectorAll(".repo-skeleton").length, 9);
    assert.match(text(page), /owner\/repo/);
    release();
    await until(() => block.querySelector(".repo-row code")?.textContent === "aaaaaaa", "the first commit");
    assert.equal(block.getAttribute("aria-busy"), "false");
    assert.equal(block.querySelectorAll(".repo-activity-lists ul").length, 3, "the same three lists");
    assert.match(text(page), /Fix 中文 parsing/);
    assert.match(text(page), /mori · 1 h ago/);
    assert.match(text(page), /as of 3 min ago/);
    assert.match(text(page), /9 open/);
    assert.match(text(page), /main/);
    const links = [...block.querySelectorAll("a")];
    for (const link of links) {
      assert.match(link.href, /^https:\/\/github\.com\//);
      assert.equal(link.target, "_blank");
      assert.equal(link.rel, "noopener noreferrer");
    }
    assert.deepEqual(
      links.map((a) => a.getAttribute("href")),
      [
        "https://github.com/owner/repo",
        `https://github.com/owner/repo/commit/${sha("a")}`,
        "https://github.com/owner/repo/pull/12",
        "https://github.com/owner/repo/pull/13",
        "https://github.com/owner/repo/actions/runs/901",
      ],
      "a link that is not a safe GitHub page stays plain text",
    );
    const plain = [...block.querySelectorAll("span.repo-row")].map((row) => row.textContent);
    assert.ok(plain.some((t) => t.includes("Sneaky link")));
    assert.ok(plain.some((t) => t.includes("Release")));
    // PR checks only when GitHub reported them; drafts are marked.
    assert.ok(block.querySelector('[aria-label="Checks passed"]'));
    assert.equal(block.querySelectorAll(".repo-state[role=img]").length, 1);
    assert.equal(block.querySelector(".repo-draft")?.textContent, "draft");
    // Runs say what GitHub said, in one word.
    const states = [...block.querySelectorAll("section[aria-label='Actions runs'] .repo-state")].map((s) => s.textContent.trim());
    assert.deepEqual(states, ["failed", "running"]);
    assert.ok(block.querySelector(".repo-state.is-attention"));
    assert.equal(block.querySelector(".repo-activity-problem"), null, "fresh data has no error line");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a stale repository keeps its data under a muted error line", async () => {
  const page = mount(() => ({
    body: {
      observedAt: ago(0),
      repositories: [
        repo({ stale: true, error: "rate_limited: GitHub rate limit reached; retry later", observedAt: ago(20) }),
        repo({ id: 8, fullName: "owner/empty", url: "https://github.com/owner/empty", defaultBranch: undefined, observedAt: null, commits: [], pulls: [], pullsTotal: 0, runs: [], stale: true, error: "not_found: gone" }),
      ],
    },
  }));
  try {
    page.window.renderActivity({ projectId: "p", linked });
    await until(() => page.document.querySelectorAll(".repo-activity-problem").length === 2, "two error lines");
    const [first, second] = page.document.querySelectorAll(".repo-activity-repo");
    assert.match(first.querySelector(".repo-activity-problem").textContent, /Last known data · rate_limited: GitHub rate limit reached/);
    assert.match(first.textContent, /Fix 中文 parsing/, "last good data stays");
    assert.match(first.textContent, /as of 20 min ago/);
    assert.match(second.textContent, /not read yet/);
    assert.match(second.textContent, /No commits/);
    assert.match(second.textContent, /No open pull requests/);
    assert.match(second.textContent, /No recent runs/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("reads only while on screen, then every two minutes", async () => {
  const page = mount(() => ({ body: { observedAt: ago(0), repositories: [repo()] } }), { observer: true });
  try {
    page.window.renderActivity({ projectId: "p", linked });
    await tick(50);
    assert.equal(page.requests.length, 0, "off screen: no read");
    page.see(true);
    await until(() => page.requests.length === 1, "a read once on screen");
    await until(() => page.pending().length === 1, "the next refresh");
    assert.equal(page.pending()[0].ms, 120_000);
    page.fire();
    await until(() => page.requests.length === 2, "the two-minute refresh");
    await until(() => page.pending().length === 1, "another refresh");
    // Off screen: the refresh stops. Back on screen before it is due: no extra read.
    page.see(false);
    await tick(30);
    assert.equal(page.pending().length, 0);
    page.see(true);
    await tick(50);
    assert.equal(page.requests.length, 2);
    assert.equal(page.pending().length, 1);
    assert.ok(page.pending()[0].ms > 100_000, "it waits for the remainder");
    // Hidden page: also no refresh.
    Object.defineProperty(page.document, "visibilityState", { value: "hidden", configurable: true });
    page.document.dispatchEvent(new page.window.Event("visibilitychange"));
    await tick(30);
    assert.equal(page.pending().length, 0);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("no linked repositories, no block; an unreachable Core says so in place", async () => {
  const empty = mount(() => ({ body: { observedAt: ago(0), repositories: [] } }));
  try {
    empty.window.renderActivity({ projectId: "p", linked });
    await until(() => empty.requests.length === 1, "one read");
    await until(() => empty.document.getElementById("root").childElementCount === 0, "nothing shown");
  } finally {
    empty.close();
  }
  const down = mount(() => ({ status: 404, body: { error: "Not Found" } }));
  try {
    down.window.renderActivity({ projectId: "p", linked });
    await until(() => down.document.querySelector(".repo-activity-problem"), "the problem line");
    assert.match(down.document.querySelector(".repo-activity-problem").textContent, /Repository activity is unavailable · Not Found/);
    assert.equal(down.document.querySelector(".repo-activity-repo.is-loading"), null, "no loading pulse after a failure");
    assert.equal(down.document.querySelectorAll(".repo-activity-lists ul").length, 3, "the frame keeps its height");
  } finally {
    down.close();
  }
});

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
const fixture = await mkdtemp(path.join(cache, "home-return-overview-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(web, "src/home/Home.tsx"))};
import {HomeReturnOverview} from ${JSON.stringify(path.join(web, "src/home/HomeReturnOverview.tsx"))};
import {BriefDensity} from ${JSON.stringify(path.join(web, "src/home/home-density.ts"))};
const root=createRoot(document.getElementById('root'));
window.renderOverview=(data,scope='one',density='low',failed=false)=>root.render(<BriefDensity.Provider value={density}><div><textarea id="preserved-draft" defaultValue="Unsent draft"/><HomeReturnOverview key={scope} data={data} readFailed={failed} onSection={(...args)=>window.actions.push(['section',...args])} onNavigate={target=>window.actions.push(['navigate',target])} onNeedsYou={()=>window.actions.push(['needs'])}/></div></BriefDensity.Provider>);
window.renderHome=(workspaceId,revision=0)=>root.render(<Home workspaceId={workspaceId} revision={revision} jobsRevision={0} agents={window.fixtureAgents||[]} projects={[]} readOnly={false} onNavigate={()=>{}} onChanged={()=>{}}/>);`,
  );
  const result = await build({
    root: web,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      lib: { entry, name: "HomeReturn", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (x) => x.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((r) => setTimeout(r, 20));
async function until(predicate, label = "Expected UI") {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(label);
}
const owner = { agentId: "a", name: "Mina", state: "active" };
const body = {
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: ["summary"] },
    summary: { type: "Markdown", props: { text: "A compact, useful result." } },
  },
};
const section = (id, title, extra = {}) => ({
  id,
  key: `card-${id}`,
  kind: "report",
  title,
  version: 1,
  owner,
  updatedAt: "2026-10-30T14:20:00Z",
  updatedTurnId: null,
  body,
  attachments: [],
  refs: {},
  seen: null,
  history: false,
  ...extra,
});
function data(name = "Northstar") {
  return {
    generatedAt: "2026-10-30T14:30:00Z",
    order: ["p1"],
    needsYou: [],
    projects: [
      {
        project: { id: "p1", name },
        agents: {
          working: 0,
          idle: 0,
          waiting: 0,
          error: 0,
          offline: 0,
          total: 0,
        },
        errors: [],
        pending: [],
        jobs: [],
        unseen: 1,
        missing: [],
        brief: {
          version: 1,
          sections: [
            section(1, `${name} result`),
            section(2, "Keep the cards", {
              kind: "ask",
              ask: {
                question: "Keep cards?",
                reply: { freeText: true },
                state: "replied",
                replyText: "Yes, keep the cards",
                repliedAt: "2026-10-30T14:24:00Z",
              },
            }),
          ],
          history: [
            section(3, "Resolved choice", {
              kind: "ask",
              history: true,
              historyReason: "resolved",
              ask: {
                question: "Which view?",
                reply: { freeText: true },
                state: "resolved",
                replyText: "Compact",
                repliedAt: "2026-10-30T14:00:00Z",
              },
            }),
          ],
        },
      },
    ],
  };
}
function mount({ blockedStorage = false, fetcher } = {}) {
  const errors = [],
    requests = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://fixture.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  w.actions = [];
  w.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (blockedStorage)
    Object.defineProperty(w, "localStorage", {
      get() {
        throw new w.DOMException("Blocked", "SecurityError");
      },
    });
  w.fetch = async (url, init = {}) => {
    requests.push({ url, method: init.method || "GET" });
    const value = fetcher ? await fetcher(url, init) : {};
    return {
      ok: true,
      status: 200,
      json: async () => structuredClone(value),
      text: async () => JSON.stringify(value),
    };
  };
  w.eval(bundle);
  return { w, doc: w.document, errors, requests, close: () => w.close() };
}
const click = (p, selector) => {
  const el = p.doc.querySelector(selector);
  assert.ok(el, selector);
  el.click();
};

test("reply states are honest, show original text, and read-only views send nothing", async () => {
  const p = mount();
  try {
    p.w.renderOverview(data());
    await until(() => p.doc.querySelector(".home-return-overview"));
    assert.match(
      p.doc.querySelector(".home-return-receipt").textContent,
      /Replied · awaiting handling/,
    );
    assert.doesNotMatch(p.doc.body.textContent, /taken over|completed|已接手/);
    click(p, ".home-return-receipt");
    await until(() => p.doc.querySelector(".home-return-dialog"));
    const text = p.doc.querySelector(".home-return-dialog").textContent;
    assert.match(text, /Your recorded replyYes, keep the cards/);
    assert.match(text, /Owner at this reading: Mina/);
    assert.match(text, /Marked resolved/);
    assert.equal(p.requests.length, 0);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a background reading preserves focus and the held overview while requests and errors stay live", async () => {
  const p = mount();
  try {
    const first = data();
    p.w.renderOverview(first);
    await until(() => p.doc.querySelector(".home-return-overview"));
    const draft = p.doc.querySelector("textarea");
    draft.focus();
    draft.value = "Keep this unsent reply";
    const next = structuredClone(first);
    next.generatedAt = "2026-10-30T15:00:00Z";
    next.projects[0].brief.sections.push(section(4, "Second result"));
    next.needsYou.push({
      kind: "ask",
      projectId: "p1",
      agentId: "a",
      agentName: "Mina",
      sectionKey: "question",
      title: "A new decision",
      since: next.generatedAt,
    });
    next.projects[0].errors.push({
      agentId: "a",
      agentName: "Mina",
      message: "Runtime disconnected",
      at: next.generatedAt,
    });
    p.w.renderOverview(next);
    await until(() => p.doc.querySelector(".home-return-refresh.has-update"));
    assert.equal(p.doc.activeElement, draft);
    assert.equal(draft.value, "Keep this unsent reply");
    assert.equal(
      p.doc.querySelector(".home-return-tiles strong").textContent,
      "1 card",
    );
    assert.equal(
      p.doc.querySelector(".home-return-tile.is-live strong").textContent,
      "1 item",
    );
    assert.match(
      p.doc.querySelector(".home-return-errors").textContent,
      /1 Agent error/,
    );
    click(p, ".home-return-refresh");
    await until(
      () =>
        p.doc.querySelector(".home-return-tiles strong").textContent ===
        "2 cards",
    );
    assert.equal(draft.value, "Keep this unsent reply");
    assert.equal(p.requests.length, 0);
  } finally {
    p.close();
  }
});

test("workspace keys and storage rejection cannot reuse another workspace's snapshot", async () => {
  const p = mount({ blockedStorage: true });
  try {
    p.w.renderOverview(data("First"), "first");
    await until(() => p.doc.body.textContent.includes("First result"));
    p.w.renderOverview(data("Second"), "second");
    await until(() => p.doc.body.textContent.includes("Second result"));
    assert.doesNotMatch(p.doc.body.textContent, /First result/);
    p.w.renderOverview(data("Second"), "second", "high");
    await until(
      () => p.doc.querySelectorAll(".home-return-receipt").length === 2,
    );
    assert.equal(p.requests.length, 0);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("failed refresh keeps the reading, exposes its age, and disables applying it", async () => {
  const p = mount();
  try {
    p.w.renderOverview(data());
    await until(() => p.doc.querySelector(".home-return-overview"));
    const next = data();
    next.projects[0].brief.sections.push(section(4, "Unconfirmed new result"));
    p.w.renderOverview(next, "one", "low", true);
    await until(() => p.doc.querySelector(".home-return-stale"));
    assert.equal(p.doc.querySelector(".home-return-refresh").disabled, true);
    assert.equal(
      p.doc.querySelector(".home-return-overview").dataset.overviewAt,
      "2026-10-30T14:30:00Z",
    );
  } finally {
    p.close();
  }
});

test("a held receipt does not claim the current owner or bind its question to the reply", async () => {
  const p = mount();
  try {
    const first = data();
    p.w.renderOverview(first);
    await until(() => p.doc.querySelector(".home-return-overview"));
    const next = structuredClone(first);
    const changed = next.projects[0].brief.sections[1];
    changed.owner = { agentId: "b", name: "Iris", state: "active" };
    changed.version = 2;
    changed.ask.question = "A revised question after your reply";
    p.w.renderOverview(next);
    await until(() => p.doc.querySelector(".home-return-refresh.has-update"));
    click(p, ".home-return-receipt");
    await until(() => p.doc.querySelector(".home-return-dialog"));
    const receipt = p.doc.querySelector(".home-return-reply-detail");
    assert.match(receipt.textContent, /Owner at this reading: Mina/);
    assert.match(receipt.textContent, /Card version at this reading: 1/);
    assert.match(receipt.textContent, /Card question at this reading/);
    assert.match(
      receipt.textContent,
      /not a verified copy of the question when you replied/,
    );
    assert.doesNotMatch(
      receipt.textContent,
      /Current owner|Replied to version|A revised question/,
    );
    click(p, '[aria-label="Close overview"]');
    await until(() => !p.doc.querySelector(".home-return-dialog"));
    click(p, ".home-return-refresh");
    click(p, ".home-return-receipt");
    await until(() =>
      p.doc
        .querySelector(".home-return-dialog")
        ?.textContent.includes("Owner at this reading: Iris"),
    );
    assert.match(
      p.doc.querySelector(".home-return-dialog").textContent,
      /A revised question after your reply/,
    );
    assert.match(
      p.doc.querySelector(".home-return-dialog").textContent,
      /Your recorded replyYes, keep the cards/,
    );
  } finally {
    p.close();
  }
});

test("actual Home drops a previous workspace response and late failure", async () => {
  const homeReads = [];
  const p = mount({
    fetcher: (url) => {
      if (url === "/api/home")
        return new Promise((resolve, reject) =>
          homeReads.push({ resolve, reject }),
        );
      if (url === "/api/machine-load")
        return {
          at: "2026-10-30T14:30:00Z",
          cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: 0, otherPct: 0 },
          memory: {
            totalMiB: 4096,
            usedMiB: 0,
            availableMiB: 4096,
            jobsMiB: 0,
            agentsMiB: 0,
          },
          gpus: null,
          jobs: [],
        };
      return { repositories: [], links: [] };
    },
  });
  try {
    p.w.renderHome("old");
    await until(() => homeReads.length === 1);
    p.w.renderHome("new");
    await until(() => homeReads.length === 2);
    homeReads[1].resolve(data("New workspace"));
    await until(() => p.doc.body.textContent.includes("New workspace result"));
    homeReads[0].resolve(data("Old workspace"));
    await tick();
    await tick();
    assert.doesNotMatch(p.doc.body.textContent, /Old workspace/);
    p.w.renderHome("new", 1);
    await until(() => homeReads.length === 3);
    p.w.renderHome("last", 2);
    await until(() => homeReads.length === 4);
    assert.equal(
      p.doc.querySelector(".home-return-overview"),
      null,
      "clear previous snapshot before the new read arrives",
    );
    homeReads[3].resolve(data("Last workspace"));
    await until(() => p.doc.body.textContent.includes("Last workspace result"));
    homeReads[2].reject(new Error("Old request failed late"));
    await tick();
    await tick();
    assert.doesNotMatch(
      p.doc.body.textContent,
      /Old request failed late|New workspace result/,
    );
    assert.ok(
      p.requests.every(
        (r) =>
          r.method === "GET" ||
          r.url === "/api/collaboration/github_repositories",
      ),
      "Only reads are allowed: repository discovery is a read-only POST; no Seen, reply, order or action writes",
    );
  } finally {
    p.close();
  }
});

test("a failure already shown in one workspace is absent while another workspace loads", async () => {
  const reads = [];
  const p = mount({
    fetcher: (url) =>
      url === "/api/home"
        ? new Promise((resolve, reject) => reads.push({ resolve, reject }))
        : { repositories: [], links: [] },
  });
  try {
    p.w.renderHome("failed-workspace");
    await until(() => reads.length === 1);
    reads[0].reject(new Error("Failure belonging to the old workspace"));
    await until(() => p.doc.querySelector(".home-error-banner"));
    p.w.renderHome("fresh-workspace");
    await until(() => reads.length === 2);
    assert.equal(p.doc.querySelector(".home-error-banner"), null);
    assert.equal(p.doc.querySelector(".home-return-stale"), null);
    assert.doesNotMatch(p.doc.body.textContent, /Failure belonging to the old/);
  } finally {
    p.close();
  }
});

test("ordinary revisions preserve the actual Home reply field, its draft and focus", async () => {
  const reads = [];
  const p = mount({
    fetcher: (url) => {
      if (url === "/api/home")
        return new Promise((resolve) => reads.push(resolve));
      if (url === "/api/machine-load")
        return {
          at: "2026-10-30T14:30:00Z",
          cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: 0, otherPct: 0 },
          memory: {
            totalMiB: 4096,
            usedMiB: 0,
            availableMiB: 4096,
            jobsMiB: 0,
            agentsMiB: 0,
          },
          gpus: null,
          jobs: [],
        };
      return { repositories: [], links: [] };
    },
  });
  try {
    p.w.fixtureAgents = [{ id: "a", name: "Mina", projectId: "p1" }];
    const first = data();
    first.projects[0].brief.sections.push(
      section(4, "A new question", {
        kind: "ask",
        ask: {
          question: "Choose a reading view?",
          state: "open",
          reply: { freeText: true },
        },
      }),
    );
    p.w.renderHome("same");
    await until(() => reads.length === 1);
    reads[0](first);
    await until(() =>
      p.doc.querySelector('[data-section-key="card-4"] textarea'),
    );
    const draft = p.doc.querySelector('[data-section-key="card-4"] textarea');
    Object.getOwnPropertyDescriptor(
      p.w.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(draft, "Keep my unsent decision");
    draft.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    draft.focus();
    const overview = p.doc.querySelector(".home-return-overview");
    const next = structuredClone(first);
    next.projects[0].brief.sections[0].version++;
    p.w.renderHome("same", 1);
    await until(() => reads.length === 2);
    reads[1](next);
    await until(() => p.doc.querySelector(".home-return-refresh.has-update"));
    assert.equal(p.doc.querySelector(".home-return-overview"), overview);
    assert.equal(
      p.doc.querySelector('[data-section-key="card-4"] textarea'),
      draft,
    );
    assert.equal(draft.value, "Keep my unsent decision");
    assert.equal(p.doc.activeElement, draft);
    p.doc.querySelectorAll(".home-density-option")[1].click();
    await until(
      () => p.doc.querySelector(".home-view").dataset.density === "high",
    );
    assert.equal(
      p.doc.querySelector('[data-section-key="card-4"] textarea'),
      draft,
    );
    assert.equal(draft.value, "Keep my unsent decision");
  } finally {
    p.close();
  }
});

for (const scenario of [
  {
    name: "report project rename",
    kind: "report",
    before: "Northstar",
    after: "Renamed project",
    change: (project) => {
      project.project.name = "Renamed project";
    },
  },
  {
    name: "reply project rename",
    kind: "ask",
    before: "Northstar",
    after: "Renamed project",
    change: (project) => {
      project.project.name = "Renamed project";
    },
  },
  {
    name: "report owner rename",
    kind: "report",
    before: "Owner at this reading: Mina",
    after: "Owner at this reading: Iris",
    change: (project) => {
      project.brief.sections[0].owner = {
        ...project.brief.sections[0].owner,
        name: "Iris",
      };
    },
  },
]) {
  test(`R1 ${scenario.name} enables explicit refresh and preserves the held reading, focus and draft`, async () => {
    const p = mount();
    try {
      const first = data();
      first.projects[0].brief.sections =
        first.projects[0].brief.sections.filter(
          (s) => s.kind === scenario.kind,
        );
      first.projects[0].brief.history = [];
      p.w.renderOverview(first);
      await until(() => p.doc.querySelector(".home-return-overview"));
      const draft = p.doc.querySelector("#preserved-draft");
      draft.value = "My unsent decision";
      draft.focus();
      assert.equal(p.doc.querySelector(".home-return-refresh").disabled, true);
      const next = structuredClone(first);
      scenario.change(next.projects[0]);
      assert.deepEqual(
        next.projects[0].brief.sections.map((s) => s.version),
        first.projects[0].brief.sections.map((s) => s.version),
      );
      p.w.renderOverview(next);
      await until(
        () => !p.doc.querySelector(".home-return-refresh").disabled,
        scenario.name,
      );
      assert.equal(p.doc.activeElement, draft);
      assert.equal(draft.value, "My unsent decision");
      const showDetails = () =>
        p.doc
          .querySelectorAll(".home-return-tile")
          [scenario.kind === "ask" ? 1 : 0].click();
      showDetails();
      await until(() => p.doc.querySelector(".home-return-dialog"));
      assert.ok(
        p.doc
          .querySelector(".home-return-dialog")
          .textContent.includes(scenario.before),
      );
      assert.ok(
        !p.doc
          .querySelector(".home-return-dialog")
          .textContent.includes(scenario.after),
      );
      click(p, '[aria-label="Close overview"]');
      await until(() => !p.doc.querySelector(".home-return-dialog"));
      click(p, ".home-return-refresh");
      await until(() => p.doc.querySelector(".home-return-refresh").disabled);
      assert.equal(p.doc.querySelector("#preserved-draft"), draft);
      assert.equal(draft.value, "My unsent decision");
      showDetails();
      await until(() =>
        p.doc
          .querySelector(".home-return-dialog")
          ?.textContent.includes(scenario.after),
      );
      assert.equal(p.requests.length, 0);
      assert.deepEqual(p.errors, []);
    } finally {
      p.close();
    }
  });
}

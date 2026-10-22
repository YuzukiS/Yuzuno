import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// Which project group the grouped Agent list opens (T-92): choosing another
// Agent opens its group, another Agent in the same project too, wherever it
// was chosen from; a group folded by hand stays folded while the chosen
// Agent stays the same, through refreshes, a list that was not grouped for
// a while, and reloads.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/project-groups-ui-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {flushSync} from 'react-dom';import {createRoot} from 'react-dom/client';
import {GroupedAgents} from ${JSON.stringify(path.join(root, "src/ProjectGroups.tsx"))};
const root=createRoot(document.getElementById('root'));
// grouped: false shows the plain list App shows when not grouping.
window.show=({groups,selectedId,grouped=true,workspaceId='w1'})=>flushSync(()=>root.render(grouped
  ?<GroupedAgents groups={groups} style="headers" workspaceId={workspaceId} selectedId={selectedId} searching={false}
     renderAgent={(a)=><div key={a.id} data-agent={a.id}>{a.name}</div>} onCreate={()=>{}}/>
  :<div>{groups.flatMap((g)=>g.agents).map((a)=><div key={a.id} data-agent={a.id}>{a.name}</div>)}</div>));`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, lib: { entry, name: "ProjectGroupsUiTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = (id, projectId, extra = {}) => ({
  id, name: id, projectId, status: "idle", pendingCount: 0, unreadCount: 0, closedAt: null, ...extra,
});
const group = (key, agents) => ({ key, projectId: key, name: `Project ${key}`, agents, colour: null, creatable: true });
// Fresh objects each time, as App makes them on every refresh.
const groupsOf = (...lists) => lists.map(([key, ids]) => group(key, ids.map((id) => agent(id, key))));
const twoProjects = () => groupsOf(["A", ["a1", "a2"]], ["B", ["b1"]]);

// A page: its own storage, so what was folded survives a reload of it.
function page(storage = null) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  w.eval(bundle);
  const toggle = (key) => w.document.querySelector(`[data-group="${key}"] .project-group-toggle`);
  return {
    w,
    close: () => dom.window.close(),
    storage: () => Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)])),
    folded: (key) => {
      // A group that is not shown is neither folded nor open.
      assert.ok(toggle(key), `group ${key} is shown`);
      return toggle(key).getAttribute("aria-expanded") === "false";
    },
    fold: (key) => {
      assert.equal(toggle(key).getAttribute("aria-expanded"), "true", `${key} is open before folding it`);
      toggle(key).click();
    },
  };
}
// Effects settle after a render.
const settle = () => sleep(20);

test("choosing another Agent in the same project opens the group folded by hand", async () => {
  const p = page();
  try {
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    p.fold("A");
    await settle();
    assert.equal(p.folded("A"), true);
    // Chosen elsewhere, e.g. from Machines: a2 is in the same project.
    p.w.show({ groups: twoProjects(), selectedId: "a2" });
    await settle();
    assert.equal(p.folded("A"), false, "a2's row is shown");
  } finally {
    p.close();
  }
});

test("choosing an Agent in another project opens its group and leaves the others as they were", async () => {
  const p = page();
  try {
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    p.fold("B");
    await settle();
    p.fold("A");
    await settle();
    p.w.show({ groups: twoProjects(), selectedId: "b1" });
    await settle();
    assert.equal(p.folded("B"), false);
    assert.equal(p.folded("A"), true, "the group folded by hand stays folded");
  } finally {
    p.close();
  }
});

test("while the chosen Agent stays the same, refreshes, a list not grouped for a while and a reload keep a hand fold", async () => {
  const p = page();
  let storage;
  try {
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    p.fold("A");
    await settle();
    // Refreshes bring fresh lists and new Agents; the choice is unchanged.
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    p.w.show({ groups: groupsOf(["A", ["a1", "a2", "a3"]], ["B", ["b1"]]), selectedId: "a1" });
    await settle();
    assert.equal(p.folded("A"), true);
    // One project's list (not grouped), then All projects again.
    p.w.show({ groups: twoProjects(), selectedId: "a1", grouped: false });
    await settle();
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    assert.equal(p.folded("A"), true, "still folded after the list was not grouped");
    // Home open (nothing chosen), then closed on the same Agent: no choice.
    p.w.show({ groups: twoProjects(), selectedId: null });
    await settle();
    assert.equal(p.folded("A"), true);
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    assert.equal(p.folded("A"), true, "still folded after Home");
    // An Agent not listed opens nothing; back to a1 after it is a choice.
    p.w.show({ groups: twoProjects(), selectedId: "gone" });
    await settle();
    assert.equal(p.folded("A"), true);
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    assert.equal(p.folded("A"), false);
    p.fold("A");
    await settle();
    storage = p.storage();
  } finally {
    p.close();
  }
  // A reload with the same Agent chosen.
  const again = page(storage);
  try {
    again.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    assert.equal(again.folded("A"), true, "folded after the reload");
  } finally {
    again.close();
  }
});

test("an Agent chosen from Home opens its group; Home itself opens nothing", async () => {
  const p = page();
  try {
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    p.fold("A");
    await settle();
    p.w.show({ groups: twoProjects(), selectedId: null });
    await settle();
    assert.equal(p.folded("A"), true);
    // Home's Brief opens a2.
    p.w.show({ groups: twoProjects(), selectedId: "a2" });
    await settle();
    assert.equal(p.folded("A"), false);
  } finally {
    p.close();
  }
});

test("an Agent chosen while the list was not grouped opens its group when the groups come back", async () => {
  const p = page();
  try {
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    p.fold("A");
    await settle();
    // One project's list, or No grouping: a2 is chosen there.
    p.w.show({ groups: twoProjects(), selectedId: "a1", grouped: false });
    await settle();
    p.w.show({ groups: twoProjects(), selectedId: "a2", grouped: false });
    await settle();
    p.w.show({ groups: twoProjects(), selectedId: "a2" });
    await settle();
    assert.equal(p.folded("A"), false);
  } finally {
    p.close();
  }
});

test("a closed Agent chosen opens its group once the Closed list shows it", async () => {
  const p = page();
  try {
    p.w.show({ groups: twoProjects(), selectedId: "a1" });
    await settle();
    p.fold("B");
    await settle();
    // c1 is closed: chosen first, then App switches the rail to Closed.
    p.w.show({ groups: twoProjects(), selectedId: "c1" });
    await settle();
    assert.equal(p.folded("B"), true, "nothing opens before c1 is listed");
    const closed = groupsOf(["A", ["a0"]], ["B", ["c1"]]);
    closed[1].agents[0].closedAt = "2026-10-17T00:00:00Z";
    p.w.show({ groups: closed, selectedId: "c1" });
    await settle();
    assert.equal(p.folded("B"), false, "c1's row is shown");
  } finally {
    p.close();
  }
});

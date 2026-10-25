import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const dir = await mkdtemp(path.join(cache, "delivery-ui-"));
let bundle;
try {
  const entry = path.join(dir, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react'; import {createRoot} from 'react-dom/client'; import {DeliveryFlow} from ${JSON.stringify(path.join(root, "src/DeliveryFlow.tsx"))}; const root=createRoot(document.getElementById('root')); window.renderFlow=(props)=>root.render(<DeliveryFlow {...props} onCandidate={c=>window.candidate=c}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry, name: "TestDelivery", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (x) => x.type === "chunk",
  ).code;
} finally {
  await rm(dir, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const candidate = {
  flowId: "flow",
  round: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};
const settings = { harness: "codex", model: "gpt-6.1-sol" };
const linked = {
  id: "7:pull:1",
  kind: "pull",
  number: 1,
  repository: "o/r",
  url: "https://github.com/o/r/pull/1",
  stale: false,
  error: null,
  snapshot: {
    title: "Change",
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
  },
};
function flow(state = "awaiting_result") {
  return {
    id: "flow",
    enabled: true,
    linkId: linked.id,
    url: linked.url,
    maxRounds: 2,
    state,
    reason: "Explicit delivery candidate",
    candidate,
    rounds: [
      {
        number: 1,
        baseSha: candidate.baseSha,
        headSha: candidate.headSha,
        settings,
        resultId: null,
        review: {
          id: null,
          requestId: "fixed-review",
          attempts: 0,
          error: null,
        },
        ci: { id: null, requestId: "fixed-ci", attempts: 0, error: null },
      },
    ],
    reviewEvidence: null,
    ciEvidence: null,
  };
}
function mount(handler) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://isolated.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const calls = [];
  dom.window.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const value = await handler(url, body);
    return {
      ok: true,
      status: 200,
      json: async () => structuredClone(value),
      text: async () => JSON.stringify(value),
    };
  };
  dom.window.eval(bundle);
  return {
    dom,
    calls,
    render: (revision = 1) =>
      dom.window.renderFlow({ taskId: "T-1", revision }),
    text: () => dom.window.document.body.textContent,
    button: (s) =>
      [...dom.window.document.querySelectorAll("button")].find((b) =>
        b.textContent.includes(s),
      ),
  };
}
test("viewing does not enable; explicit enable captures revision, actual settings and cap", async () => {
  let enabled = false;
  const h = mount((url, body) => {
    if (url.endsWith("/github_links")) return { links: [linked] };
    if (url.endsWith("/delivery_enable")) {
      enabled = true;
      assert.deepEqual(body.settings, settings);
      assert.equal(body.headSha, candidate.headSha);
      assert.equal(body.maxRounds, 1);
      return { flow: flow() };
    }
    return { settings, flow: enabled ? flow() : null };
  });
  try {
    h.render();
    await tick();
    await tick();
    assert.equal(
      h.calls.filter((c) => c.url.endsWith("delivery_enable")).length,
      0,
    );
    h.button("Set up delivery").click();
    await tick();
    h.button("Enable this delivery").click();
    await tick();
    await tick();
    assert.equal(
      h.calls.filter((c) => c.url.endsWith("delivery_enable")).length,
      1,
    );
    assert.equal(h.dom.window.candidate.headSha, candidate.headSha);
  } finally {
    h.dom.window.close();
  }
});
test("new revision withdraws the submit binding and read errors never retain green readiness", async () => {
  let current = flow();
  let fail = false;
  const h = mount((url) => {
    if (fail) throw new h.dom.window.Error("Core unavailable");
    return url.endsWith("/github_links")
      ? { links: [linked] }
      : { settings, flow: current };
  });
  try {
    h.render();
    await tick();
    await tick();
    assert.equal(h.dom.window.candidate.headSha, candidate.headSha);
    current = flow("candidate_changed");
    h.render(2);
    await tick();
    await tick();
    assert.equal(h.dom.window.candidate, null);
    assert.match(h.text(), /Revision changed/);
    current = flow("ready_to_merge");
    h.render(3);
    await tick();
    await tick();
    assert.match(h.text(), /Ready for merge decision/);
    fail = true;
    h.render(4);
    await tick();
    await tick();
    assert.doesNotMatch(h.text(), /Ready for merge decision/);
    assert.match(h.text(), /Core unavailable/);
  } finally {
    h.dom.window.close();
  }
});
test("original review opens the existing review UI and unknown cannot authorize another round", async () => {
  const f = flow("infrastructure_error");
  f.reviewEvidence = {
    id: "original",
    status: "unknown",
    conclusion: "unknown",
    actualModel: null,
    finishedAt: null,
  };
  const h = mount((url) =>
    url.endsWith("/github_links") ? { links: [linked] } : { settings, flow: f },
  );
  try {
    let opened;
    h.dom.window.addEventListener(
      "yuzuno:open-task-review",
      (e) => (opened = e.detail),
    );
    h.render();
    await tick();
    await tick();
    assert.equal(h.button("Authorize next candidate"), undefined);
    h.button("Original review evidence").click();
    assert.equal(opened.reviewId, "original");
    assert.equal(opened.taskId, "T-1");
  } finally {
    h.dom.window.close();
  }
});

test("terminal flows retain evidence and offer no new candidate or stop action", async () => {
  for (const [state, label] of [
    ["completed", "Task completed"],
    ["cancelled", "Task cancelled"],
    ["archived", "Task archived"],
    ["merged", "Merged"],
    ["stopped", "Delivery stopped"],
  ]) {
    const f = flow(state);
    f.enabled = false;
    f.reviewEvidence = {
      id: "retained",
      status: "completed",
      conclusion: "no_findings",
    };
    const h = mount((url) =>
      url.endsWith("/github_links")
        ? { links: [linked] }
        : { settings, flow: f },
    );
    try {
      h.render();
      await tick();
      await tick();
      assert.ok(h.text().includes(label));
      assert.equal(h.button("Authorize next candidate"), undefined);
      assert.equal(h.button("Stop automatic delivery"), undefined);
      assert.ok(h.button("Original review evidence"));
      assert.equal(h.dom.window.candidate, null);
      assert.ok(
        h.calls.every(
          (c) =>
            c.url.endsWith("delivery_get") || c.url.endsWith("github_links"),
        ),
      );
    } finally {
      h.dom.window.close();
    }
  }
});

// T-189: delivery follows the interface language, changed in another window.
const speak = (h, language) => {
  h.dom.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  h.dom.window.dispatchEvent(new h.dom.window.StorageEvent("storage", { key: "yuzuno.language" }));
};
const select = (h, label) =>
  [...h.dom.window.document.querySelectorAll("label")].find((l) => l.textContent.startsWith(label)).querySelector("select");
const choose = (h, element, value) => {
  element.value = value;
  element.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
};
test("a language change keeps the chosen PR, the cap, the open setup and the request identity, and starts nothing", async () => {
  const second = {
    ...linked,
    id: "7:pull:2",
    number: 2,
    url: "https://github.com/o/r/pull/2",
    snapshot: { title: "第二个 change", baseSha: "c".repeat(40), headSha: "d".repeat(40) },
  };
  const enables = [];
  const h = mount((url, body) => {
    if (url.endsWith("/github_links")) return { links: [linked, second] };
    if (url.endsWith("/delivery_enable")) {
      enables.push(body);
      if (enables.length === 1) throw new h.dom.window.Error("Core is busy: try again");
      return { flow: flow() };
    }
    return { settings, flow: enables.length > 1 ? flow() : null };
  });
  try {
    h.render();
    await tick();
    await tick();
    h.button("Set up delivery").click();
    await tick();
    choose(h, select(h, "Pull request"), second.id);
    choose(h, select(h, "Maximum paid review attempts"), "2");
    await tick();
    h.button("Enable this delivery").click();
    await tick();
    await tick();
    assert.equal(enables.length, 1);
    assert.match(h.text(), /Core is busy: try again/);
    const before = h.calls.length;
    speak(h, "zh-Hans");
    await tick();
    await tick();
    const text = h.text();
    for (const words of ["自动交付", "拉取请求", "付费审查次数上限", "最多 2 次审查 · 需要明确继续", "在提交匹配的结果后开始。", "启用此交付"])
      assert.ok(text.includes(words), words);
    // As written: Core's reason, the PR's title, harness and model, commits.
    assert.ok(text.includes("Core is busy: try again"));
    assert.ok(text.includes("#2 · 第二个 change"));
    assert.ok(text.includes("为 cccccccc → dddddddd 授权 codex / gpt-6.1-sol。"));
    assert.equal(select(h, "拉取请求").value, second.id);
    assert.equal(select(h, "付费审查次数上限").value, "2");
    // Nothing asked of Core: no delivery_get, github_links or delivery_enable.
    assert.deepEqual(h.calls.slice(before).map((c) => c.url), []);
    h.button("启用此交付").click();
    await tick();
    await tick();
    assert.equal(enables.length, 2);
    assert.equal(enables[1].requestId, enables[0].requestId, "the same request, asked again");
    assert.equal(enables[1].linkId, second.id);
    assert.equal(enables[1].maxRounds, 2);
    assert.match(h.text(), /等待结果/);
  } finally {
    h.dom.window.close();
  }
});
test("a running flow follows the language; Core's reason, the review's outcome, CI runs and identities stay as written", async () => {
  const f = flow("ready_to_merge");
  f.reviewEvidence = { id: "original", status: "completed", conclusion: "no_findings", actualModel: "gpt-6.1-sol", finishedAt: null };
  f.ciEvidence = {
    watch: { observedAt: new Date().toISOString(), error: null },
    runs: [{ id: "run-1", name: "CI", conclusion: "success", status: "completed", url: "https://github.com/o/r/actions/runs/1" }],
  };
  f.rounds[0].review.id = "review-1";
  const h = mount((url) => (url.endsWith("/github_links") ? { links: [linked] } : { settings, flow: f }));
  try {
    h.dom.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
    h.render();
    await tick();
    await tick();
    const text = h.text();
    for (const words of ["可以决定是否合并", "已链接的 PR ↗", "审查 1 / 2", "审查模型：gpt-6.1-sol", "原始审查证据 ↗", "CI 观察于", "授权与操作标识", "第 1 轮 · codex / gpt-6.1-sol", "结果：未提交", "审查：review-1", "CI：未订阅", "授权下一个候选…", "停止自动交付"])
      assert.ok(text.includes(words), words);
    for (const kept of ["Explicit delivery candidate", "completed · no findings", "CI · success ↗", "fixed-review", "fixed-ci", "aaaaaaaa", "bbbbbbbb"])
      assert.ok(text.includes(kept), kept);
    assert.equal(h.dom.window.document.querySelector(".delivery-flow").getAttribute("aria-label"), "任务交付");
    h.button("授权下一个候选").click();
    await tick();
    assert.ok(h.button("授权下一个审查候选"));
    speak(h, "en");
    await tick();
    assert.ok(h.button("Authorize next review candidate"), "the open setup stays open");
    assert.ok(h.text().includes("Ready for merge decision"));
    assert.ok(h.calls.every((c) => c.url.endsWith("delivery_get") || c.url.endsWith("github_links")));
  } finally {
    h.dom.window.close();
  }
});

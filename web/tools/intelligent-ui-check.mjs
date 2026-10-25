import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, idleJobsBudget, noCiRuns, noJobs, unmanagedUpdates } from "./browser-fixtures.mjs";
import {
  comparisonExample,
  reportExample,
} from "../src/intelligent-ui/examples.ts";
import {
  VIEW_PREFIX,
  VIEW_MAX_BYTES,
  VIEW_MAX_ENTRIES,
  resultFingerprint,
} from "../src/intelligent-ui/view-storage.ts";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated production build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve("../acceptance/intelligent-ui/browser");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], mutations: [] };
const spec = structuredClone(comparisonExample);
Object.assign(spec.elements, {
  metrics: reportExample.elements.metrics,
  chart: reportExample.elements.chart,
});
// A model may reuse a real navigation ID; it must never become a bar's SVG ID.
spec.elements.chart = structuredClone(spec.elements.chart);
spec.elements.chart.props.data[0].id = "turn-current";
spec.elements.result.children = [
  "options",
  "metrics",
  "chart",
  "sources",
  "continue",
];
const resultText = `A **sample** result for browser acceptance.\n\n\`\`\`yuzuno-ui\n${JSON.stringify(spec)}\n\`\`\`\n\n[Ordinary file link](notes.md:42).`;
const base = {
  cwd: "/fixture",
  model: "fixture-model",
  color: "sage",
  status: "working",
  harness: "codex",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 2,
  lastSeq: 3,
  reviewedSeq: 3,
};
const agents = [
  { ...base, id: "a", name: "Mori" },
  { ...base, id: "b", name: "Hana" },
];
const turn = {
  id: "current",
  status: "inProgress",
  items: [
    {
      id: "user",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "Compare the options and let me choose what to explore.",
        },
      ],
    },
    { id: "result", type: "agentMessage", text: resultText },
  ],
};
const details = {
  a: {
    agent: agents[0],
    turns: [
      {
        id: "old",
        status: "completed",
        items: [
          {
            id: "old-reply",
            type: "agentMessage",
            text: "Earlier conversation.\n\n".repeat(40),
          },
        ],
      },
      turn,
    ],
    pending: [],
    artifacts: [],
  },
  b: {
    agent: agents[1],
    turns: [
      {
        id: "other",
        status: "inProgress",
        items: [{ id: "result", type: "agentMessage", text: resultText }],
      },
    ],
    pending: [],
    artifacts: [],
  },
};
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.on("pageerror", (error) => report.errors.push(error.message));
await page.addInitScript(() => {
  window.EventSource = class {
    constructor() {
      window.testEvents = this;
    }
    close() {}
  };
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem(
      "yuzuno.appearance",
      JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }),
    );
  // A draft is saved under the Workspace and the Agent it was written in
  // (T-195); this fixture's /api/workspace says "fixture".
  for (const [agent, text] of [["a", "保留这段原草稿。"], ["b", "Hana's own draft."]]) {
    const key = `yuzuno.composer.v1:${JSON.stringify(["fixture", agent])}`;
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text }] }),
      );
  }
});
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(url.hostname, "yuzuno-intelligent.test");
  if (request.method() !== "GET") {
    report.mutations.push({ path: url.pathname, body: request.postDataJSON() });
    return route.fulfill({ json: {} });
  }
  if (url.pathname === "/api/workspace")
    return route.fulfill({
      json: {
        workspace: { id: "fixture" },
        agents,
        runtime: { connected: true },
        defaultCwd: "/fixture",
      },
    });
  if (/^\/api\/agents\/[ab]$/.test(url.pathname))
    return route.fulfill({ json: details[url.pathname.at(-1)] });
  if (url.pathname === "/api/artifact")
    return route.fulfill({
      contentType: "text/plain",
      body: Array.from({ length: 60 }, (_, i) => `Source line ${i + 1}`).join(
        "\n",
      ),
    });
  if (url.pathname === "/api/updates")
    return route.fulfill({ json: unmanagedUpdates });
  if (url.pathname === "/api/jobs/budget")
    return route.fulfill({ json: idleJobsBudget });
  if (url.pathname === "/api/jobs") return route.fulfill({ json: noJobs });
  if (url.pathname === "/api/ci") return route.fulfill({ json: noCiRuns });
  assert.ok(
    !url.pathname.startsWith("/api/"),
    `Unexpected API: ${url.pathname}`,
  );
  const file = resolve(
    dist,
    `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
  );
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".woff2": "font/woff2",
    }[extname(file)],
  });
});
const check = (name) => report.checks.push(name);
const refresh = async () => {
  await page.evaluate(() =>
    window.testEvents.onmessage?.({ data: JSON.stringify({ agentId: "a" }) }),
  );
  await page.waitForTimeout(350);
};
try {
  await page.goto("https://yuzuno-intelligent.test/");
  await page.locator(".interactive-result").waitFor();
  const latest = page.getByRole("button", {
    name: "Back to latest",
    exact: true,
  });
  if (await latest.isVisible()) await latest.click();
  await page
    .getByRole("button", { name: "Ask for an interactive result", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  turn.items.push({
    id: "live-follow-probe",
    type: "agentMessage",
    text: "Live follow after cancelling the composer dialog.\n\n".repeat(12),
  });
  await refresh();
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 3;
  });
  check("opening and cancelling the request dialog preserves live follow");
  await page
    .getByRole("textbox", { name: "Filter Options", exact: true })
    .fill("DOCK");
  assert.equal(
    await page
      .locator('.result-table-section[aria-label="Options"] tbody tr')
      .count(),
    1,
  );
  await page
    .getByRole("checkbox", { name: "Select Turn dock", exact: true })
    .check();
  await page
    .getByRole("textbox", { name: "Filter Options", exact: true })
    .fill("不存在");
  await page.getByText("No matches. Try another filter.").waitFor();
  await page
    .getByRole("textbox", { name: "Filter Options", exact: true })
    .fill("");
  await page.getByRole("button", { name: "Option", exact: true }).click();
  assert.match(
    await page
      .locator('.result-table-section[aria-label="Options"] tbody tr')
      .first()
      .innerText(),
    /Chapter markers/,
  );
  check(
    "case-insensitive filtering, Chinese empty state, sorting, hidden selections retained",
  );

  await page
    .getByRole("button", { name: "Continue with selection", exact: true })
    .click();
  const draft = await composerDraft(
    page.getByRole("textbox", { name: "Message Mori", exact: true }),
  );
  assert.ok(draft.startsWith("保留这段原草稿。\n\n"));
  assert.match(draft, /Selected:\n- Options: Option: Turn dock/);
  assert.equal(report.mutations.length, 0);
  check("explicit continuation preserves existing draft and sends no request");

  await page
    .getByRole("textbox", { name: "Filter Options", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Ask for an interactive result", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(report.mutations.length, 0);
  check("Escape in result controls and template dialog never interrupts");

  await page
    .getByRole("button", { name: "Turn navigator source", exact: true })
    .last()
    .click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await composerDraft(
      page.getByRole("textbox", { name: "Message Mori", exact: true }),
    ),
    draft,
  );
  check("file source uses existing preview; Escape retains draft");

  await page
    .getByRole("checkbox", { name: "Select Snapshot", exact: true })
    .focus();
  await page.keyboard.press("Space");
  assert.ok(
    await page
      .getByRole("checkbox", { name: "Select Snapshot", exact: true })
      .isChecked(),
  );
  assert.ok((await page.locator(".recharts-bar-rectangle").count()) >= 3);
  await page.locator(".recharts-bar-rectangle").first().click();
  assert.equal(await page.locator("svg [id='turn-current']").count(), 0);
  assert.equal(await page.locator("#turn-current").count(), 1);
  assert.ok(
    await page
      .getByRole("checkbox", { name: "Select Queue", exact: true })
      .isChecked(),
  );
  await page
    .getByRole("button", { name: "Continue with selection", exact: true })
    .click();
  assert.match(
    await composerDraft(
      page.getByRole("textbox", { name: "Message Mori", exact: true }),
    ),
    /Update latency: Snapshot — 120 ms/,
  );
  check(
    "chart clicks and keyboard table selection work; model IDs do not reach SVG",
  );

  await page.reload();
  await page
    .getByRole("checkbox", { name: "Select Snapshot", exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("checkbox", { name: "Select Turn dock", exact: true })
      .isChecked(),
  );
  assert.ok(
    await page
      .getByRole("checkbox", { name: "Select Snapshot", exact: true })
      .isChecked(),
  );
  check("reload restores result, selected rows and existing draft");
  await page.getByRole("button", { name: "Open Hana", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message Hana", exact: true })
    .waitFor();
  assert.equal(
    await composerDraft(
      page.getByRole("textbox", { name: "Message Hana", exact: true }),
    ),
    "Hana's own draft.",
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Select Turn dock", exact: true })
      .isChecked(),
    false,
  );
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select Turn dock", exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("checkbox", { name: "Select Turn dock", exact: true })
      .isChecked(),
  );
  check(
    "Agent switches isolate drafts and selection even with repeated item IDs",
  );

  await page
    .getByRole("textbox", { name: "Filter Options", exact: true })
    .focus();
  const position = await page
    .locator(".conversation-scroll")
    .evaluate((el) => el.scrollTop);
  agents[0].lastSeq = 6;
  agents[0].unreadCount = 1;
  turn.items.push({
    id: "more",
    type: "agentMessage",
    text: "Further progress.\n\n".repeat(20),
  });
  await refresh();
  assert.ok(
    Math.abs(
      (await page
        .locator(".conversation-scroll")
        .evaluate((el) => el.scrollTop)) - position,
    ) < 3,
  );
  assert.equal(agents[0].pendingCount, 2);
  assert.equal(report.mutations.length, 0);
  check("new execution events preserve reading position, unread and Pending");

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page.locator(".interactive-result").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${theme}-20px-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".interactive-result").scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    assert.ok(
      await page
        .locator(".interactive-result")
        .evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
    );
    await page.screenshot({ path: `${output}/${theme}-20px-narrow.png` });
    assert.ok(
      await page
        .getByRole("button", {
          name: "Ask for an interactive result",
          exact: true,
        })
        .isVisible(),
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page.locator(".recharts-bar-rectangle animate").count(),
    0,
  );
  check("light/dark at 20px, 390px width, reduced motion; no page overflow");

  await page
    .getByRole("button", { name: "Ask for an interactive result", exact: true })
    .click();
  await page.getByRole("radio", { name: /Explore data/ }).check();
  await page
    .getByRole("button", { name: "Add request to draft", exact: true })
    .click();
  assert.match(
    await composerDraft(
      page.getByRole("textbox", { name: "Message Mori", exact: true }),
    ),
    /Please include an interactive data report/,
  );
  assert.equal(report.mutations.length, 0);
  check(
    "discoverable template appends to source Agent draft without auto-send",
  );

  const storageDraft =
    "存储压力后的新草稿。" + "Please retain this text. ".repeat(200);
  const storageArgs = {
    prefix: VIEW_PREFIX,
    fingerprint: resultFingerprint(JSON.stringify(spec)),
    maxBytes: VIEW_MAX_BYTES,
    maxEntries: VIEW_MAX_ENTRIES,
  };
  const protectedOutbox = JSON.stringify({
    "a:composer": {
      clientMessageId: "storage-pressure-unsent",
      text: "Keep this delivery protection",
      expectedTurnId: "current",
      question: null,
    },
  });
  await page.evaluate(
    ({ prefix, fingerprint, outbox }) => {
      localStorage.setItem("yuzuno.outbox", outbox);
      localStorage.setItem("unrelated-feature", "preserve this too");
      for (const key of Object.keys(localStorage))
        if (key.startsWith(prefix)) localStorage.removeItem(key);
      for (let i = 0; i < 140; i++)
        localStorage.setItem(
          prefix + "seed" + i,
          JSON.stringify({
            version: 2,
            fingerprint,
            touched: i,
            views: {
              options: {
                selected: Array.from(
                  { length: 100 },
                  (_, j) => "row" + j + "x".repeat(45),
                ),
                filter: "",
                sort: [],
              },
            },
          }),
        );
    },
    { ...storageArgs, outbox: protectedOutbox },
  );
  await page.reload();
  await page.locator(".interactive-result").waitFor();
  const evicted = await page.evaluate(({ prefix }) => {
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith(prefix),
    );
    return {
      count: keys.length,
      bytes: keys.reduce(
        (n, key) => n + 2 * (key.length + localStorage.getItem(key).length),
        0,
      ),
      oldest: localStorage.getItem(prefix + "seed0"),
      newest: !!localStorage.getItem(prefix + "seed139"),
    };
  }, storageArgs);
  assert.ok(evicted.count <= VIEW_MAX_ENTRIES && evicted.count < 140);
  assert.ok(evicted.bytes <= VIEW_MAX_BYTES);
  assert.equal(evicted.oldest, null);
  assert.ok(evicted.newest);
  check(
    "real browser startup evicts oldest preferences within count and byte budgets",
  );

  const beforePressure = await composerDraft(
    page.getByRole("textbox", { name: "Message Mori", exact: true }),
  );
  const pressure = await page.evaluate(({ prefix }) => {
    let added = 0,
      exception = "";
    for (let i = 0; i < 200; i++) {
      try {
        localStorage.setItem(
          prefix + "legacy" + i,
          JSON.stringify({ raw: "x".repeat(64000), views: {} }),
        );
        added++;
      } catch (error) {
        exception = error.name;
        break;
      }
    }
    return { added, exception };
  }, storageArgs);
  assert.ok(pressure.added > 0);
  assert.equal(pressure.exception, "QuotaExceededError");
  report.storage = {
    eviction: evicted,
    quota: pressure,
    maxBytes: VIEW_MAX_BYTES,
    maxEntries: VIEW_MAX_ENTRIES,
  };
  // No reload-time fixture restores these values: they must survive cleanup.
  // Cover startup cleanup even when no interactive result is initially loaded.
  turn.items[1].text = "Ordinary reply while legacy preferences are reclaimed.";
  await page.reload();
  const composer = page.getByRole("textbox", {
    name: "Message Mori",
    exact: true,
  });
  await composer.waitFor();
  assert.equal(await composerDraft(composer), beforePressure);
  assert.equal(
    await page.evaluate(
      (prefix) =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith(prefix + "legacy"),
        ).length,
      VIEW_PREFIX,
    ),
    0,
  );
  turn.items[1].text = resultText;
  await refresh();
  await page.locator(".interactive-result").waitFor();
  await composer.fill(storageDraft);
  await page
    .getByRole("checkbox", { name: "Select Turn dock", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Continue with selection", exact: true })
    .click();
  const afterPressure = await composerDraft(composer);
  assert.ok(afterPressure.startsWith(storageDraft + "\n\n"));
  // Saved where the composer keeps drafts since T-33, paste blocks included,
  // under the Workspace and the Agent it was written in (T-195); this
  // fixture's /api/workspace says "fixture".
  const mine = JSON.stringify(["fixture", "a"]);
  await page.waitForFunction(({ text, identity }) => {
    const saved = localStorage.getItem("yuzuno.composer.v1:" + identity);
    return (
      !!saved &&
      JSON.parse(saved)
        .parts.map((part) =>
          part.kind === "text"
            ? part.text
            : localStorage.getItem("yuzuno.paste.v1:" + identity + ":" + part.bodyId),
        )
        .join("") === text
    );
  }, { text: afterPressure, identity: mine });
  await page.reload();
  await page.locator(".interactive-result").waitFor();
  assert.equal(await composerDraft(composer), afterPressure);
  assert.ok(
    await page
      .getByRole("checkbox", { name: "Select Turn dock", exact: true })
      .isChecked(),
  );
  const protectedValues = await page.evaluate(
    ({ prefix }) => ({
      outbox: localStorage.getItem("yuzuno.outbox"),
      other: localStorage.getItem("unrelated-feature"),
      legacy: Object.keys(localStorage).filter((key) =>
        key.startsWith(prefix + "legacy"),
      ).length,
      raw: Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .some((key) => "raw" in JSON.parse(localStorage.getItem(key))),
    }),
    storageArgs,
  );
  assert.equal(protectedValues.outbox, protectedOutbox);
  assert.equal(protectedValues.other, "preserve this too");
  assert.equal(protectedValues.legacy, 0);
  assert.equal(protectedValues.raw, false);
  check(
    "actual Chromium quota exhaustion recovers; new draft, selection and untouched outbox survive reload",
  );

  // Also exercise a smaller/custom quota: failure must remain interactive and
  // discard only result preferences, with draft writes continuing normally.
  await page.evaluate(({ prefix }) => {
    const original = Storage.prototype.setItem;
    window.restoreStorageWrites = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix))
        throw new DOMException("Small device quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  }, storageArgs);
  await page
    .getByRole("checkbox", { name: "Select Turn dock", exact: true })
    .uncheck();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Select Turn dock", exact: true })
      .isChecked(),
    false,
  );
  await composer.fill(storageDraft + " After a failed preference write.");
  assert.equal(
    await page.evaluate(
      (prefix) =>
        Object.keys(localStorage).filter((key) => key.startsWith(prefix))
          .length,
      VIEW_PREFIX,
    ),
    0,
  );
  await page.evaluate(() => window.restoreStorageWrites());
  await page.reload();
  await page.locator(".interactive-result").waitFor();
  assert.equal(
    await composerDraft(composer),
    storageDraft + " After a failed preference write.",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("yuzuno.outbox")),
    protectedOutbox,
  );
  check(
    "failed cache writes keep controls usable, release only own preferences and preserve draft refresh",
  );

  agents[0].closedAt = "2026-10-13T06:00:00Z";
  await refresh();
  await page.getByRole("button", { name: "Reopen", exact: true }).waitFor();
  assert.ok(await page.locator(".result-primary").isDisabled());
  assert.equal(
    await page
      .getByRole("button", {
        name: "Ask for an interactive result",
        exact: true,
      })
      .count(),
    0,
  );
  delete agents[0].closedAt;
  await refresh();
  check(
    "closed Agent results cannot append a draft or expose a generation entry",
  );

  turn.items[1].text =
    'Original Markdown remains.\n\n```yuzuno-ui\n{"root":"unknown"}\n```';
  await refresh();
  // T-36: a local note; the JSON is kept, folded, not spread over the reply.
  await page.locator('[data-result-state="format"]').waitFor();
  assert.equal(await page.locator(".interactive-result").count(), 0);
  assert.match(
    await page.locator('[data-item-id="result"] .result-state-details pre').textContent(),
    /unknown/,
  );
  assert.equal(await page.locator('[data-item-id="result"] .result-state-details').getAttribute("open"), null);
  check("invalid result preserves original Markdown and keeps its JSON folded");
  turn.items[1].text = resultText;
  await page.route("**/assets/InteractiveResult-*.js", (route) =>
    route.abort("failed"),
  );
  await page.reload();
  await page.locator('[data-result-state="load"]').waitFor();
  assert.match(
    await page.locator('[data-item-id="result"] .result-state-details pre').textContent(),
    /Conversation navigation/,
  );
  assert.match(
    await composerDraft(
      page.getByRole("textbox", { name: "Message Mori", exact: true }),
    ),
    /存储压力后的新草稿/,
  );
  check(
    "failed lazy result asset preserves the original reply and working conversation",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

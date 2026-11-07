// What the workbench spends above the conversation, and on whom (T-15, V4).
//
// On a middle-sized screen the two rows above the conversation — the
// workspace toolbar and the conversation's own header — cost 122px of a
// 669px-tall window to carry contents 32px and 40px tall. This asks two
// questions at once, because they pull against each other: is the head
// shorter on a short or touched screen (V4), and are its buttons still big
// enough for a finger (V3)? A head that shrank by taking the targets with it
// would pass one and fail the other, so both are read in the same pass.
// A tall screen with a mouse is read too, and must NOT be compacted: the
// desktop keeps the head it had.
//
// The numbers here come from a fixture built to the user's screenshot
// (951x669 with an 84px system column on the right), NOT from a Duo. d6's
// own figure of 92 is a reference under those same conditions; it is printed
// for comparison and never asserted, and no part of it is in the product.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-chrome.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import {
  idleJobsBudget,
  noLiveJobs,
  noReviews,
  unmanagedUpdates,
} from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

const agent = {
  id: "a",
  name: "Dev 8 · Mac / iOS",
  status: "working",
  harness: "claude",
  cwd: "/Users/yuzuki/work",
  model: "claude-opus-5",
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 9,
  reviewedSeq: 9,
  connectionState: "connected",
  goal: "",
  projectId: null,
};
const agents = [agent, { ...agent, id: "b", name: "Dev 3 · public" }];
const detail = {
  agent,
  pending: [],
  messageReceipts: [],
  artifacts: [],
  turns: Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`,
    status: "completed",
    startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      {
        id: `u${i}`,
        type: "userMessage",
        content: [{ type: "text", text: `第 ${i + 1} 轮` }],
      },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(40) },
    ],
  })),
};
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const browser = await launchBrowser();
const errors = [];

// One pass of the app, as a screen of this size and this way of pointing.
async function read({ width, height, coarse, inset }) {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: coarse,
    isMobile: coarse,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript((right) => {
    window.EventSource = class {
      close() {}
    };
    if (right)
      addEventListener("DOMContentLoaded", () =>
        document.documentElement.style.setProperty(
          "--safe-right",
          `${right}px`,
        ),
      );
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem(
        "yuzuno.appearance",
        JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }),
      );
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, inset || 0);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET")
      return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({
        json: {
          workspace: { id: "ws" },
          projects: [],
          projectUsage: {},
          agents,
          runtime: { connected: true },
          defaultCwd: "/work",
        },
      });
    if (/^\/api\/agents\/[ab]$/.test(path))
      return route.fulfill({ json: detail });
    if (path === "/api/updates")
      return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs")
      return route.fulfill({
        json: { jobs: [], liveJobs: [], hasMore: false, nextBefore: null },
      });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget")
      return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci")
      return route.fulfill({
        json: { runs: [], subscriptions: [], hasMore: false, nextBefore: null },
      });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup")
      return route.fulfill({
        json: {
          items: [],
          generatedAt: "",
          source: "records",
          coverage: { fromSeq: 0, toSeq: 0 },
        },
      });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try {
      return route.fulfill({
        body: await readFile(file),
        contentType: types[extname(file)],
      });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  page.on("pageerror", (error) =>
    errors.push(`${width}x${height}: ${error.message}`),
  );
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const out = await page.evaluate(() => {
    const h = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height) : 0;
    };
    const header = document.querySelector(".conversation-header");
    return {
      toolbar: h(".toolbar"),
      header: h(".conversation-header"),
      strip: h(".preview-strip"),
      // Where the panel's three bands actually sit, so an overlap shows as
      // one rather than hiding inside a sum.
      bands: ["conversation-header", "conversation-body", "composer-area"].map(
        (cls) => {
          const el = document.querySelector(`.main-panel > .${cls}`);
          if (!el) return { cls, missing: true };
          const r = el.getBoundingClientRect();
          return { cls, top: Math.round(r.top), bottom: Math.round(r.bottom) };
        },
      ),
      panel: (() => {
        const el = document.querySelector(".main-panel");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      })(),
      statusbar: h(".statusbar"),
      body: h(".conversation-body"),
      composer: h(".composer-area"),
      main: h(".main-panel"),
      // A target is only as big as the part of it a finger can reach: the
      // middle and the four points just inside its edges all have to come
      // back to the button itself, not to something lying over it.
      actions: [...document.querySelectorAll(".conversation-action")].map(
        (el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return { hidden: true };
          const hits = [
            [r.left + r.width / 2, r.top + r.height / 2],
            [r.left + 2, r.top + r.height / 2],
            [r.right - 2, r.top + r.height / 2],
            [r.left + r.width / 2, r.top + 2],
            [r.left + r.width / 2, r.bottom - 2],
          ];
          const lands = hits.every(([x, y]) => {
            const at = document.elementFromPoint(x, y);
            return (
              at === el ||
              el.contains(at) ||
              el.contains(at?.parentElement ?? null)
            );
          });
          return {
            w: Math.round(r.width),
            h: Math.round(r.height),
            min: Math.round(Math.min(r.width, r.height)),
            lands,
            name: (el.getAttribute("aria-label") || el.textContent || "")
              .trim()
              .slice(0, 20),
          };
        },
      ),
      // A keyboard's focus ring is part of the target. This codebase draws it
      // at outline-offset 3px + 2px wide (styles.css), so it reaches 5px past
      // the button, and `.app` clips at its padding box: a row too shallow
      // for 40px plus that ring shows a cut ring to whoever is on a keyboard.
      rings: (() => {
        const app = document.querySelector(".app");
        if (!app) return [];
        const ar = app.getBoundingClientRect();
        const st = getComputedStyle(app);
        const pad = (v) => parseFloat(v || "0") || 0;
        const clipTop = ar.top + pad(st.paddingTop);
        const clipBottom = ar.bottom - pad(st.paddingBottom);
        return [
          [".toolbar", "toolbar"],
          [".conversation-header", "conversation head"],
        ].flatMap(([sel, where]) => {
          const row = document.querySelector(sel);
          if (!row) return [];
          const rr = row.getBoundingClientRect();
          return [...row.querySelectorAll("button")]
            .map((el) => {
              const r = el.getBoundingClientRect();
              if (r.height === 0) return null;
              // Focused, because the ring is drawn by :focus-visible: reading
              // an unfocused button gives the offset it is NOT about to use.
              el.focus();
              const es = getComputedStyle(el);
              const ring =
                es.outlineStyle === "none"
                  ? 0
                  : (parseFloat(es.outlineWidth) || 0) + Math.max(0, parseFloat(es.outlineOffset) || 0);
              el.blur();
              const reach = ring;
              return {
                where,
                h: Math.round(r.height),
                reach: Math.round(reach),
                room: Math.round(Math.min(r.top - rr.top, rr.bottom - r.bottom)),
                cut: Math.round(
                  Math.max(0, clipTop - (r.top - reach)) +
                    Math.max(0, r.bottom + reach - clipBottom),
                ),
                what: el.className?.toString?.().trim().split(/\s+/)[0] || el.tagName,
              };
            })
            .filter(Boolean);
        });
      })(),
      // Nothing in the head may hang out of it: a shorter head that merely
      // clips its own contents is not a shorter head.
      spill: (() => {
        if (!header) return 0;
        const hr = header.getBoundingClientRect();
        let worst = 0;
        for (const el of header.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.height === 0) continue;
          worst = Math.max(
            worst,
            Math.max(0, hr.top - r.top) + Math.max(0, r.bottom - hr.bottom),
          );
        }
        return Math.round(worst);
      })(),
    };
  });
  await context.close();
  return out;
}

// The workbench the task is about, and the desktop it must not disturb.
const bench = await read({ width: 951, height: 669, coarse: true, inset: 84 });
const desk = await read({ width: 1400, height: 900, coarse: false, inset: 0 });
const chrome = (m) => m.toolbar + m.header + m.strip;

for (const [name, m] of [
  ["workbench 951x669 touch", bench],
  ["desktop 1400x900 mouse", desk],
]) {
  console.log(`\n--- ${name} ---`);
  console.log(
    `  toolbar ${m.toolbar} + header ${m.header}${m.strip ? ` + strip ${m.strip}` : ""} = top chrome ${chrome(m)}`,
  );
  console.log(
    `  status bar ${m.statusbar}   reading body ${m.body}   input area ${m.composer}   panel ${m.main}`,
  );
  console.log(
    `  header buttons: ${m.actions.map((a) => (a.hidden ? "hidden" : `${a.w}x${a.h}${a.lands ? "" : " MISSED"}`)).join(" ")}`,
  );
}
console.log("");

// V4: the head gives back room on a short or touched screen.
check(
  chrome(bench) < chrome(desk) - 15,
  `the workbench head is shorter than the desktop's (${chrome(bench)} vs ${chrome(desk)})`,
);
check(chrome(bench) <= 110, `and stays compact (${chrome(bench)} <= 110)`);
// The same rule must not reach the desktop: its head is the taller one, and
// its buttons are the ones it had.
check(
  desk.toolbar > bench.toolbar && desk.header > bench.header,
  `the desktop keeps its own head (toolbar ${desk.toolbar} > ${bench.toolbar}, header ${desk.header} > ${bench.header})`,
);

// V3, for the buttons this item moved: a finger has to be able to hit them.
const shown = bench.actions.filter((a) => !a.hidden);
check(shown.length > 0, `the head has buttons to check (${shown.length})`);
const small = shown.filter((a) => a.min < 40);
check(
  small.length === 0,
  small.length
    ? `every header button is at least 40px, but ${small.map((a) => `${a.name} ${a.w}x${a.h}`).join(", ")}`
    : "every header button is at least 40px across",
);
const missed = shown.filter((a) => !a.lands);
check(
  missed.length === 0,
  missed.length
    ? `a press lands on the button, but missed ${missed.map((a) => a.name).join(", ")}`
    : "a press in the middle or just inside any edge lands on the button",
);

// A shorter head that clips itself is not shorter.
check(
  bench.spill === 0,
  `nothing in the head hangs out of it${bench.spill ? ` (by ${bench.spill}px)` : ""}`,
);

// The room the head gave up belongs to the conversation: the panel's three
// bands sit one under the next, inside it, none over another. (The toolbar
// is not one of them — it spans the window above both the rail and the
// panel, which is why it is not in this sum.)
const bands = bench.bands;
check(
  bands.every((b) => !b.missing),
  `the panel has its three bands (${bands.map((b) => b.cls).join(", ")})`,
);
const order = bands.slice(1).every((b, i) => b.top >= bands[i].bottom - 1);
check(
  order,
  `head, conversation and input area follow one another without overlapping (${bands.map((b) => `${b.top}-${b.bottom}`).join(" ")})`,
);
check(
  bands[0].top >= bench.panel.top - 1 &&
    bands[2].bottom <= bench.panel.bottom + 1,
  `and all three stay inside the panel (${bench.panel.top}-${bench.panel.bottom})`,
);

check(
  errors.length === 0,
  `no page errors${errors.length ? `: ${errors[0]}` : ""}`,
);

// What the rows leave around a 40px target, and whether the window's own
// clipping cuts a focus ring off at the top.
{
  const worst = bench.rings.reduce((a, b) => (b.cut > (a?.cut ?? -1) ? b : a), null);
  console.log(`\n--- room around the targets, and the focus ring ---`);
  for (const [screen, m] of [["workbench", bench], ["desktop", desk]])
  for (const where of ["toolbar", "conversation head"]) {
    const list = m.rings.filter((r) => r.where === where);
    if (!list.length) continue;
    const room = [...new Set(list.map((r) => r.room))].sort((a, b) => a - b).join("/");
    const tall = [...new Set(list.map((r) => r.h))].join("/");
    const cut = list.filter((r) => r.cut > 0);
    // Per row, not across the screen: the toolbar and the head draw different
    // rings here, and one number for both hid which was which.
    const need = [...new Set(list.map((r) => r.reach))].sort((a, b) => a - b).join("/");
    console.log(
      `  ${screen} ${where}: ${list.length} buttons ${tall}px tall, ${room}px around them, the ring needs ${need}px` +
        `${cut.length ? `, ${cut.length} cut (worst ${Math.max(...cut.map((c) => c.cut))}px)` : ", none cut"}`,
    );
  }
  const deskWorst = desk.rings.reduce((a, b) => (b.cut > (a?.cut ?? -1) ? b : a), null);
  check(
    !worst || worst.cut === 0,
    worst && worst.cut
      ? `no focus ring is cut on the workbench, but ${worst.what} loses ${worst.cut}px` +
          `${deskWorst?.cut ? ` (the desktop loses ${deskWorst.cut}px too, so this is not only the short screen)` : " (the desktop loses none)"}`
      : "no focus ring is cut on the workbench",
  );
}

console.log(
  `\nnote (synthetic, from the screenshot — not a Duo): top chrome ${chrome(bench)}px at 951x669,`,
);
console.log(`  was 122 (toolbar 57 + header 65). The conversation reads ${bench.body}px, was 408.`);
console.log(
  `  d6's reference is 92 — a 44px toolbar row and a 48px head, with 40px targets in both`,
);
console.log(
  `  (duo6.html \`.toolbar .ic, .chead .ic { width: 40px; height: 40px }\`, which overrides the`,
);
console.log(
  `  32px \`.ic\` above it; d6's own capture records "m-top": "44 + 48 = 92"). So the ${chrome(bench) - 92}px above`,
);
console.log(
  `  it is room inside the rows, not the targets: this toolbar row is 48 against 44 and this head`,
);
console.log(`  is ${bench.header} against 48. What that room is for is measured just above.`);

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

// The status bar's fit (YN-75): which form each item shows for the room
// there is. Pure; no browser. statusbar-check.mjs checks the real bar.
import test from "node:test";
import assert from "node:assert/strict";
import { fitForms, giveWaySteps, importance } from "../src/statusbar-fit.ts";

// The items as StatusBar.tsx gives them for statusbar-check's 940 px step
// (a review, a failed CI run's notice, Codex, Claude, machines, RAM).
const items = [
  { id: "reviews", side: "start", tier: "work", rank: 2, forms: ["icon"] },
  { id: "notice", side: "start", tier: "news", rank: 7, forms: ["compact", "icon"] },
  { id: "codex", side: "end", tier: "metric", rank: 2, forms: ["compact", "icon"] },
  { id: "claude", side: "end", tier: "metric", rank: 3, forms: ["compact", "icon"] },
  { id: "machines", side: "end", tier: "metric", rank: 1, forms: ["compact"] },
  { id: "ram", side: "end", tier: "metric", rank: 4, forms: ["compact", "icon"] },
];
// Full widths as Chromium measured them at 11 px in English in the YN-75
// preview (Job 121c42cd: 944 px in all with the gaps); the short forms the
// same way where it measured them, near them where it did not.
const measured = {
  reviews: { full: 97.7, icon: 23 },
  notice: { full: 76.3, compact: 74, icon: 14 },
  codex: { full: 136.3, compact: 89.2, icon: 39 },
  claude: { full: 139.3, compact: 92, icon: 39 },
  machines: { full: 182.7, compact: 55.9 },
  ram: { full: 239.7, compact: 140, icon: 72 },
};
const width = (id, form) => measured[id][form] ?? measured[id].full;
const room = (available) => ({ available, gap: 14, sideGap: 16, overflow: 24 });
const changed = (forms) => Object.fromEntries(Object.entries(forms).filter(([, f]) => f !== "full"));

test("with room, everything is said in full", () => {
  assert.deepEqual(changed(fitForms(items, width, room(1407))), {});
});

test("at 940 px only the least important metric shortens; the notice stays whole", () => {
  // 940 px less 2 × 16 px padding and the pixel kept back.
  assert.deepEqual(changed(fitForms(items, width, room(907))), { machines: "compact" });
  // 820 px: the next metric up shortens too (as the preview measured).
  assert.deepEqual(changed(fitForms(items, width, room(787))), { machines: "compact", codex: "compact" });
});

test("metrics shorten before work, work before metrics move out, and news last", () => {
  const order = giveWaySteps(items).map(([id, form]) => `${id}:${form}`);
  assert.deepEqual(order, [
    "machines:compact",
    "codex:compact",
    "claude:compact",
    "ram:compact",
    "codex:icon",
    "claude:icon",
    "ram:icon",
    "reviews:icon",
    "machines:hidden",
    "codex:hidden",
    "claude:hidden",
    "ram:hidden",
    "notice:compact",
    "reviews:hidden",
    "notice:icon",
  ]);
  // News never moves out.
  assert.ok(!order.includes("notice:hidden"));
});

test("a metric at its limit is news: it gives way after work and never moves out", () => {
  const limited = items.map((i) => (i.id === "claude" ? { ...i, tier: "news", rank: 3 } : i));
  const order = giveWaySteps(limited).map(([id, form]) => `${id}:${form}`);
  assert.ok(!order.includes("claude:hidden"));
  assert.ok(order.indexOf("claude:compact") > order.indexOf("reviews:icon"));
  assert.ok(order.indexOf("claude:compact") > order.indexOf("ram:hidden"));
});

test("the overflow button counts only once something is behind it", () => {
  // Just wide enough for work and metrics at their shortest, the notice
  // whole and nothing behind "⋯".
  const m = measured;
  const spare = m.reviews.icon + 14 + m.notice.full + 16 + m.codex.icon + m.claude.icon + m.machines.compact + m.ram.icon + 14 * 3;
  const forms = fitForms(items, width, room(spare));
  assert.ok(Object.values(forms).every((f) => f !== "hidden"), JSON.stringify(forms));
  // One pixel less: something moves out, and room is made for "⋯" too.
  const tight = fitForms(items, width, room(spare - 1));
  assert.deepEqual(changed(tight), { reviews: "icon", codex: "icon", claude: "icon", machines: "hidden", ram: "icon" });
});

test("giving back never lets a narrower, less important item say more", () => {
  // Reviews (work) cannot get its words back, CI (less important work) could:
  // CI stays short too (the inversion the YN-75 preview's r2 had).
  const two = [
    { id: "ci", side: "start", tier: "work", rank: 1, forms: ["icon"] },
    { id: "reviews", side: "start", tier: "work", rank: 2, forms: ["icon"] },
    { id: "ram", side: "end", tier: "metric", rank: 4, forms: [] },
  ];
  const w = { ci: { full: 40, icon: 20 }, reviews: { full: 120, icon: 20 }, ram: { full: 200 } };
  const forms = fitForms(two, (id, f) => w[id][f] ?? w[id].full, { available: 20 + 20 + 24 + 10 * 2 + 10 + 15, gap: 10, sideGap: 10, overflow: 24 });
  assert.equal(forms.ram, "hidden");
  assert.equal(forms.reviews, "icon");
  assert.equal(forms.ci, "icon");
});

test("without enough room even at the shortest, the result is the last step's, not an error", () => {
  const forms = fitForms(items, width, room(10));
  assert.equal(forms.notice, "icon");
  for (const id of ["reviews", "codex", "claude", "machines", "ram"]) assert.equal(forms[id], "hidden");
});

// Any items, any widths, any room: while an item has given way, every step
// before its own, for any less important item, has been taken (so a less
// important item never says more than a more important one); news never
// moves out; what is not "full" is a form the item has.
test("priority holds for any widths and room (property, 2000 cases)", () => {
  let seed = 75;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let n = 0; n < 2000; n++) {
    const set = [];
    const count = 1 + Math.floor(random() * 7);
    for (let i = 0; i < count; i++) {
      const tier = pick(["news", "work", "metric"]);
      const forms = pick([[], ["compact"], ["icon"], ["compact", "icon"]]);
      set.push({ id: `i${i}`, side: pick(["start", "end"]), tier, rank: i + 1, forms });
    }
    const widths = Object.fromEntries(
      set.map((i) => {
        const full = 20 + random() * 200;
        const compact = full * (0.3 + random() * 0.6);
        return [i.id, { full, compact, icon: compact * (0.2 + random() * 0.6) }];
      }),
    );
    const forms = fitForms(set, (id, f) => widths[id][f], { available: random() * 900, gap: 10 + random() * 6, sideGap: 16, overflow: 24 });
    const steps = giveWaySteps(set);
    const depth = { full: 0, compact: 1, icon: 2, hidden: 3 };
    const byId = Object.fromEntries(set.map((i) => [i.id, i]));
    for (const a of set) {
      if (forms[a.id] !== "full" && forms[a.id] !== "hidden") assert.ok(a.forms.includes(forms[a.id]), `${a.id} ${forms[a.id]}`);
      if (a.tier === "news") assert.notEqual(forms[a.id], "hidden");
      if (forms[a.id] === "full") continue;
      const at = steps.findIndex(([id, f]) => id === a.id && f === forms[a.id]);
      assert.ok(at >= 0, `${a.id} ${forms[a.id]} is a step`);
      for (const [id, f] of steps.slice(0, at)) {
        if (!(importance(a) > importance(byId[id]))) continue;
        assert.ok(depth[forms[id]] >= depth[f], JSON.stringify({ n, a: a.id, step: [id, f], forms }));
      }
    }
  }
});

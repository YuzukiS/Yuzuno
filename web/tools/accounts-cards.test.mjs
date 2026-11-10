// YN-84 S3: Accounts & keys draws a card per provider, each listing which
// Workspace settings reference its logins, accounts and keys (design v3 §3.2).
// The provider of an OpenCode candidate comes from its model, which may be
// missing; every slot; what can't be told apart or read; which cards show, and
// that the same final reads give the same cards whatever order they finish in.
import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN_PROVIDERS, OPENCODE_DEFAULT, cardSlots, countRefs, modelProvider, providerCards, usesOf } from "../src/accounts-cards.ts";

const nameOf = (c) => c.label ?? c.id;
const cand = (id, harness, credential, more = {}) => ({ id, enabled: true, harness, model: "m", credential, conditions: [], unknown: "skip", ...more });
const read = (cswapAccounts = 0, codexHomes = []) => ({ current: "read", last: { cswapAccounts, codexHomes } });
const refs = (over = {}) => usesOf({ candidates: [], routingOn: true, agentHarness: "codex", reviewer: { harness: "codex", model: "gpt-6.1-sol" }, keyIds: [], ...over }, nameOf);
const shown = (result) => result.cards.map((c) => c.id);

test("the known providers are Core's three, Claude's first", () => {
  assert.deepEqual([...KNOWN_PROVIDERS], ["anthropic", "openai", "deepseek"]);
});

test("a model's provider is its prefix; missing, null, empty or no slash leaves it to OpenCode", () => {
  assert.equal(modelProvider(undefined), null);
  assert.equal(modelProvider(null), null);
  assert.equal(modelProvider(""), null);
  assert.equal(modelProvider("  "), null);
  assert.equal(modelProvider("noslash"), null);
  assert.equal(modelProvider("/leading"), null);
  assert.equal(modelProvider("deepseek/deepseek-flash"), "deepseek");
  assert.equal(modelProvider("openrouter/a/b"), "openrouter");
});

test("every slot, from candidates, the new Agent defaults and review", () => {
  const candidates = [
    cand("cl", "claude", { kind: "login" }),
    cand("pool", "claude", { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }),
    cand("cx", "codex", { kind: "login" }),
    cand("home", "codex", { kind: "codexHome", id: "work" }),
    cand("key", "opencode", { kind: "apiKey", keyId: "deepseek-main" }, { model: "deepseek/deepseek-flash" }),
    cand("gone", "claude", { kind: "apiKey", keyId: "anthropic-old" }),
    cand("oc", "opencode", { kind: "login" }, { model: "deepseek/deepseek-v4-pro" }),
    cand("or", "opencode", { kind: "login" }, { model: "openrouter/a/b" }),
    cand("nomodel", "opencode", { kind: "login" }, { model: undefined }),
    cand("nullmodel", "opencode", { kind: "login" }, { model: null }),
  ];
  const r = usesOf({ candidates, routingOn: true, agentHarness: "claude", reviewer: { harness: "codex", model: "gpt-6.1-sol" }, keyIds: ["deepseek-main"] }, nameOf);
  const slots = Object.fromEntries([...r.uses].map(([slot, list]) => [slot, list.map((u) => (u.kind === "candidate" ? `${u.place}:${u.id}` : u.kind))]));
  assert.deepEqual(slots, {
    claudeHost: ["1:cl", "agentDefaults"],
    cswap: ["2:pool"],
    codexHost: ["3:cx", "review"],
    "home:work": ["4:home"],
    "key:deepseek-main": ["5:key"],
    "opencode:deepseek": ["7:oc"],
    "opencode:openrouter": ["8:or"],
    "opencode:*": ["9:nomodel", "10:nullmodel"],
  });
  // A key the Workspace doesn't have is the routing page's to fix: not here, and not unmapped.
  assert.deepEqual(r.unmapped, []);
  assert.deepEqual(r.missing, []);
  assert.equal(r.complete, true);
  assert.deepEqual(r.uses.get("codexHost")[1], { kind: "review", model: "gpt-6.1-sol" });
  assert.deepEqual(r.uses.get("cswap")[0], { kind: "candidate", place: 2, id: "pool", name: "pool", active: true });
});

test("a credential or harness this version can't tell is unmapped, and the references aren't complete", () => {
  const r = usesOf({
    candidates: [cand("a", "claude", { kind: "login" }), cand("odd", "claude", { kind: "passkey" }), cand("tool", "gemini", { kind: "login" }, { label: "Gemini" }),
      cand("nohome", "codex", { kind: "codexHome" }), cand("nokey", "claude", { kind: "apiKey" }), cand("nocred", "claude", null)],
    routingOn: true, agentHarness: "gemini", reviewer: { harness: "x", model: "y" }, keyIds: [],
  }, nameOf);
  assert.deepEqual(r.unmapped, [
    { kind: "candidate", place: 2, name: "odd" }, { kind: "candidate", place: 3, name: "Gemini" }, { kind: "candidate", place: 4, name: "nohome" },
    { kind: "candidate", place: 5, name: "nokey" }, { kind: "candidate", place: 6, name: "nocred" },
    { kind: "agentDefaults", harness: "gemini" }, { kind: "review", harness: "x" }]);
  assert.deepEqual([...r.uses.keys()], ["claudeHost"]);
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, []);
});

test("a read that failed is missing, and then nothing is complete", () => {
  const r = usesOf({ candidates: null, routingOn: false, agentHarness: null, reviewer: null, keyIds: [] }, nameOf);
  assert.deepEqual(r.missing, ["policy", "agentDefaults", "review"]);
  assert.equal(r.complete, false);
  assert.equal(r.uses.size, 0);
  assert.deepEqual(refs({ reviewer: null }).missing, ["review"]);
  assert.equal(refs().complete, true);
});

test("on is a candidate enabled with routing on; off ones and every one while routing is off are counted apart", () => {
  const candidates = [cand("on", "claude", { kind: "login" }), cand("off", "claude", { kind: "login" }, { enabled: false })];
  const on = refs({ candidates, agentHarness: "claude", reviewer: { harness: "claude", model: "opus" } });
  assert.deepEqual(on.uses.get("claudeHost").map((u) => u.active ?? "setting"), [true, false, "setting", "setting"]);
  assert.deepEqual(countRefs(["claudeHost"], on.uses), { active: 3, off: 1 });
  const routingOff = refs({ candidates, routingOn: false, agentHarness: "claude", reviewer: { harness: "claude", model: "opus" } });
  assert.deepEqual(routingOff.uses.get("claudeHost").filter((u) => u.kind === "candidate").map((u) => u.active), [false, false]);
  assert.deepEqual(countRefs(["claudeHost"], routingOff.uses), { active: 2, off: 2 }, "the Agent defaults and review still count");
});

test("counting: a candidate once whatever slots it is in, the defaults and review once each", () => {
  const uses = new Map([
    ["claudeHost", [{ kind: "candidate", place: 1, id: "a", name: "a", active: true }, { kind: "agentDefaults" }, { kind: "review", model: "opus" }]],
    ["cswap", [{ kind: "candidate", place: 1, id: "a", name: "a", active: true }, { kind: "candidate", place: 2, id: "b", name: "b", active: false }]],
    ["codexHost", [{ kind: "agentDefaults" }]],
  ]);
  assert.deepEqual(countRefs(["claudeHost", "cswap", "codexHost", "claudeHost"], uses), { active: 3, off: 1 });
  assert.deepEqual(countRefs(["nothing"], uses), { active: 0, off: 0 });
});

test("all read: a known provider shows with a key, a reference (an off one too) or its accounts; the rest are hidden", () => {
  const nothing = providerCards({ keys: [], accounts: read(), uses: refs().uses, complete: true, revealed: new Set() });
  assert.deepEqual(shown(nothing), ["openai"], "review and the defaults use Codex's host login");
  assert.deepEqual(nothing.hidden, ["anthropic", "deepseek"]);
  const bare = providerCards({ keys: [], accounts: read(), uses: new Map(), complete: true, revealed: new Set() });
  assert.deepEqual([shown(bare), bare.hidden], [[], ["anthropic", "openai", "deepseek"]]);
  const key = providerCards({ keys: [{ id: "deepseek-main", provider: "deepseek" }], accounts: read(), uses: new Map(), complete: true, revealed: new Set() });
  assert.deepEqual(key.cards, [{ id: "deepseek", known: true, keys: ["deepseek-main"] }]);
  const offRef = refs({ candidates: [cand("p", "claude", { kind: "pool" }, { enabled: false })] });
  assert.deepEqual(shown(providerCards({ keys: [], accounts: read(), uses: offRef.uses, complete: true, revealed: new Set() })), ["anthropic", "openai"]);
  const viaOpencode = refs({ candidates: [cand("o", "opencode", { kind: "login" }, { model: "anthropic/claude-x" })], agentHarness: "codex" });
  assert.deepEqual(shown(providerCards({ keys: [], accounts: read(), uses: viaOpencode.uses, complete: true, revealed: new Set() })), ["anthropic", "openai"]);
  assert.deepEqual(shown(providerCards({ keys: [], accounts: read(2), uses: new Map(), complete: true, revealed: new Set() })), ["anthropic"]);
  assert.deepEqual(shown(providerCards({ keys: [], accounts: read(0, ["work"]), uses: new Map(), complete: true, revealed: new Set() })), ["openai"]);
  // Any Codex home referenced shows OpenAI, even one the accounts don't list.
  const gone = refs({ candidates: [cand("h", "codex", { kind: "codexHome", id: "old" })], agentHarness: "claude", reviewer: { harness: "claude", model: "opus" } });
  assert.deepEqual(shown(providerCards({ keys: [], accounts: read(), uses: gone.uses, complete: true, revealed: new Set() })), ["anthropic", "openai"]);
});

test("claude-swap unavailable is no account: Claude shows only by its other rules", () => {
  // The page counts an unavailable claude-swap as 0 accounts.
  const r = providerCards({ keys: [], accounts: read(0), uses: new Map(), complete: true, revealed: new Set() });
  assert.deepEqual(r.hidden, ["anthropic", "openai", "deepseek"]);
  assert.deepEqual(shown(providerCards({ keys: [{ id: "anthropic", provider: "anthropic" }], accounts: read(0), uses: new Map(), complete: true, revealed: new Set() })), ["anthropic"]);
});

test("accounts reading or failed: every known card shows, whatever the last read found, and nothing is hidden", () => {
  for (const accounts of [{ current: "reading" }, { current: "failed" }, { current: "reading", last: { cswapAccounts: 0, codexHomes: [] } },
    { current: "failed", last: { cswapAccounts: 0, codexHomes: [] } }, { current: "failed", last: { cswapAccounts: 3, codexHomes: ["work"] } }]) {
    const r = providerCards({ keys: [], accounts, uses: new Map(), complete: true, revealed: new Set() });
    assert.deepEqual([shown(r), r.hidden], [["anthropic", "openai", "deepseek"], []], JSON.stringify(accounts));
  }
});

test("references not all read: no card is hidden", () => {
  const r = providerCards({ keys: [], accounts: read(), uses: new Map(), complete: false, revealed: new Set() });
  assert.deepEqual([shown(r), r.hidden], [["anthropic", "openai", "deepseek"], []]);
});

test("revealed shows a known card the rules would hide", () => {
  const r = providerCards({ keys: [], accounts: read(), uses: new Map(), complete: true, revealed: new Set(["deepseek"]) });
  assert.deepEqual([shown(r), r.hidden], [["deepseek"], ["anthropic", "openai"]]);
});

test("other OpenCode providers follow the known ones by id, read-only; OpenCode's default model last", () => {
  const r = refs({ candidates: [
    cand("z", "opencode", { kind: "login" }, { model: "zai/glm" }), cand("d", "opencode", { kind: "login" }, { model: null }),
    cand("a", "opencode", { kind: "login" }, { model: "openrouter/x/y", enabled: false })] });
  const cards = providerCards({ keys: [], accounts: read(), uses: r.uses, complete: true, revealed: new Set() }).cards;
  assert.deepEqual(cards, [{ id: "openai", known: true, keys: [] }, { id: "openrouter", known: false, keys: [] }, { id: "zai", known: false, keys: [] },
    { id: OPENCODE_DEFAULT, known: false, keys: [] }]);
});

test("a card's head counts its own slots: a Codex home only when the accounts list it", () => {
  const accounts = read(1, ["work"]);
  assert.deepEqual(cardSlots({ id: "anthropic", known: true, keys: ["anthropic"] }, accounts), ["claudeHost", "cswap", "opencode:anthropic", "key:anthropic"]);
  assert.deepEqual(cardSlots({ id: "openai", known: true, keys: [] }, accounts), ["codexHost", "home:work", "opencode:openai"]);
  assert.deepEqual(cardSlots({ id: "openai", known: true, keys: [] }, { current: "failed" }), ["codexHost", "opencode:openai"]);
  assert.deepEqual(cardSlots({ id: "deepseek", known: true, keys: ["d1", "d2"] }, accounts), ["opencode:deepseek", "key:d1", "key:d2"]);
  assert.deepEqual(cardSlots({ id: "*", known: false, keys: [] }, accounts), ["opencode:*"]);
});

// The page's reads finish in any order; each step draws the cards from what has arrived so far, and nothing is
// written into `revealed` by them (only the user's opening is). The final cards are the same for every order.
test("the same final reads give the same cards whatever order they finish in", () => {
  const arrivals = {
    keys: (s) => ({ ...s, keys: [{ id: "anthropic", provider: "anthropic" }] }),
    accounts: (s) => ({ ...s, accounts: read(0, []) }),
    policy: (s) => ({ ...s, candidates: [cand("cl", "claude", { kind: "apiKey", keyId: "anthropic" })], routingOn: true }),
    agentDefaults: (s) => ({ ...s, agentHarness: "claude" }),
    review: (s) => ({ ...s, reviewer: { harness: "claude", model: "opus" } }),
  };
  const draw = (s) => {
    const r = usesOf({ candidates: s.candidates, routingOn: s.routingOn, agentHarness: s.agentHarness, reviewer: s.reviewer, keyIds: s.keys.map((k) => k.id) }, nameOf);
    return providerCards({ keys: s.keys, accounts: s.accounts, uses: r.uses, complete: r.complete, revealed: s.revealed });
  };
  const orders = (list) => (list.length <= 1 ? [list] : list.flatMap((x, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest])));
  const finals = new Set();
  let forced = 0;
  for (const order of orders(Object.keys(arrivals))) {
    let s = { keys: [], accounts: { current: "reading" }, candidates: null, routingOn: false, agentHarness: null, reviewer: null, revealed: new Set() };
    for (const name of order) {
      s = arrivals[name](s);
      if (draw(s).cards.length > 1) forced++;
    }
    assert.equal(s.revealed.size, 0, "no read writes revealed");
    finals.add(JSON.stringify(draw(s)));
  }
  assert.ok(forced > 0, "some steps show cards only while unsure");
  assert.deepEqual([...finals], [JSON.stringify({ cards: [{ id: "anthropic", known: true, keys: ["anthropic"] }], hidden: ["openai", "deepseek"] })]);
});

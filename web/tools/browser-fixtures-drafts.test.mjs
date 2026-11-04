// The browser checks' draft helpers (browser-fixtures.mjs) read a draft as the composer saves it, by its
// Workspace and its Agent (T-195). Drafts are written here by the app's own DraftStorage into a storage of
// this test's, and read back through the helpers as a check's page would run them.
import test from "node:test";
import assert from "node:assert/strict";
import { DraftStorage, draftIdentity, emptyDraft, pastedText, textDraft } from "../src/composer-draft.ts";
import { composerDraft, draftIdentityInPage, savedDraft } from "./browser-fixtures.mjs";

/** A Storage over a Map, as `localStorage` in the page the helpers run in. */
function storage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}
/** A page whose evaluate runs the function here, with `localStorage` as given. */
function page(local) {
  return { evaluate: async (fn, arg) => { globalThis.localStorage = local; return fn(arg); } };
}
/** The composer's locator: a CodeMirror editor (no value), or a form field with one. */
function composer(local, value = null) {
  const element = { matches: () => value !== null, value };
  return {
    page: () => page(local),
    evaluate: async (fn, arg) => { globalThis.localStorage = local; return fn(element, arg); },
  };
}
const save = (local, workspace, agent, draft) => new DraftStorage(local).save(draftIdentity(workspace, agent), draft);
const withPaste = (before, body) => ({ ...textDraft(before), parts: [{ kind: "text", text: before }, pastedText(body, 1)], nextNumber: 2 });

test("the identity is spelled as the app spells it, from both its parts", () => {
  assert.equal(draftIdentityInPage(["ws-1", "a"]), draftIdentity("ws-1", "a"));
  for (const parts of [[], ["", "a"], ["ws-1", ""], [undefined, "a"], ["ws-1"]])
    assert.throws(() => draftIdentityInPage(parts), /found by its Workspace and its Agent/, JSON.stringify(parts));
});

test("the open Agent's draft is read under that Workspace's key; the older unscoped key is not used", async () => {
  const local = storage({ "yuzuno.selected": JSON.stringify("a") });
  save(local, "ws-1", "a", textDraft("Mori's draft"));
  // Only the older key names the open Agent: that is no answer, and says so.
  await assert.rejects(composerDraft(composer(local), "ws-1"), /No open Agent is saved for Workspace ws-1/);
  local.setItem("yuzuno.selected.ws-1", JSON.stringify("a"));
  assert.equal(await composerDraft(composer(local), "ws-1"), "Mori's draft");
});

test("the same Agent id in two Workspaces has two drafts, each read only in its own", async () => {
  const local = storage({ "yuzuno.selected.ws-1": JSON.stringify("a"), "yuzuno.selected.ws-2": JSON.stringify("a") });
  save(local, "ws-2", "a", textDraft("the other Workspace's"));
  // ws-1 has none: its draft is empty, not ws-2's found by the Agent id.
  assert.equal(await savedDraft(page(local), "ws-1", "a"), null);
  assert.equal(await composerDraft(composer(local), "ws-1"), "");
  save(local, "ws-1", "a", textDraft("this Workspace's"));
  assert.equal(await savedDraft(page(local), "ws-1", "a"), "this Workspace's");
  assert.equal(await savedDraft(page(local), "ws-2", "a"), "the other Workspace's");
  assert.equal(await composerDraft(composer(local), "ws-2"), "the other Workspace's");
});

test("an emptied draft reads as empty", async () => {
  const local = storage({ "yuzuno.selected.ws-1": JSON.stringify("a") });
  const drafts = new DraftStorage(local);
  drafts.save(draftIdentity("ws-1", "a"), textDraft("typed"));
  drafts.save(draftIdentity("ws-1", "a"), emptyDraft());
  assert.equal(await savedDraft(page(local), "ws-1", "a") ?? "", "");
  assert.equal(await composerDraft(composer(local), "ws-1"), "");
});

test("a pasted block is read from its body, under the same identity", async () => {
  const local = storage({ "yuzuno.selected.ws-1": JSON.stringify("a") });
  const body = "line\n".repeat(12);
  save(local, "ws-1", "a", withPaste("Before ", body));
  assert.equal(await savedDraft(page(local), "ws-1", "a"), "Before " + body);
  assert.equal(await composerDraft(composer(local), "ws-1"), "Before " + body);
});

test("a read without its Workspace or Agent fails rather than reading as empty", async () => {
  const local = storage({ "yuzuno.selected.ws-1": JSON.stringify("a") });
  save(local, "ws-1", "a", textDraft("kept"));
  await assert.rejects(composerDraft(composer(local)), /needs the Workspace the page is in/);
  await assert.rejects(composerDraft(composer(local), ""), /needs the Workspace the page is in/);
  await assert.rejects(savedDraft(page(local), "", "a"), /found by its Workspace and its Agent/);
  await assert.rejects(savedDraft(page(local), "ws-1", undefined), /found by its Workspace and its Agent/);
});

test("a real form field reads as its value, whatever is saved", async () => {
  assert.equal(await composerDraft(composer(storage(), "typed here")), "typed here");
});

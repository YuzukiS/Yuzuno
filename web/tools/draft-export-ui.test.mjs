// T-193 slice 3: Settings → Draft storage. The list reads draft manifests only;
// one draft is opened only when chosen, shown whole and saved as a text file
// only when asked; nothing is written, and drafts of Agents this Workspace
// doesn't list are only counted. A draft now says which Workspace it was
// written in (T-195): another Workspace's is not shown or counted here, and
// one saved before that was recorded is shown as exactly that. Synthetic
// drafts only.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(root, ".draft-export-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {DraftExport} from ${JSON.stringify(path.join(root, "src/DraftExport.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderDrafts = props => root.render(<DraftExport {...props}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "DraftExportTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally { await rm(temporary, { recursive: true, force: true }); }

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check, what = "Expected draft state") {
  for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail(`${what} did not appear`);
}
const image = { id: `${"a".repeat(64)}.png`, agentId: "a1", name: "screen.png", width: 10, height: 10, bytes: 100 };
const WORKSPACE = "ws-1";
/** The key a draft of this Workspace's Agent is saved under (T-195). */
const mine = (agent) => JSON.stringify([WORKSPACE, agent]);
const seed = {
  [`yuzuno.composer.v1:${mine("a1")}`]: JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "text", text: "Hello there " }, { kind: "paste", id: "p1", number: 1, bodyId: "b1" }], images: [image] }),
  [`yuzuno.paste.v1:${mine("a1")}:b1`]: "PASTED BODY line one\nline two",
  // Saved before Workspaces were recorded: the Agent only, in the string map.
  "yuzuno.drafts": JSON.stringify({ a2: "legacy words" }),
  [`yuzuno.composer.v1:${mine("a3")}`]: "{damaged",
  [`yuzuno.composer.v1:${mine("a4")}`]: JSON.stringify({ version: 1, nextNumber: 1, parts: [] }),
  [`yuzuno.composer.v1:${mine("a5")}`]: JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "paste", id: "p9", number: 1, bodyId: "gone" }] }),
  // This Workspace's, for an Agent it no longer lists: counted, not shown.
  [`yuzuno.composer.v1:${mine("zz")}`]: JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "an unlisted Agent's words" }] }),
  [`yuzuno.composer.v1:${mine("a7")}`]: JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "Willow's words" }] }),
  // Another Workspace at this address, for an Agent ID this one also uses:
  // neither shown nor counted here, and never read as this Workspace's.
  [`yuzuno.composer.v1:${JSON.stringify(["ws-other", "a1"])}`]: JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "another Workspace's words" }] }),
};
const agents = [
  { id: "a1", name: "Cedar" },
  { id: "a2", name: "Pine", closedAt: "2026-10-01T00:00:00Z" },
  { id: "a3", name: "Maple" },
  { id: "a4", name: "Birch" },
  { id: "a5", name: "Rowan" },
  { id: "a7", name: "Willow" },
];

function mount({ refuse = false, extra = {} } = {}) {
  const vc = new VirtualConsole();
  const errors = [], reads = [], writes = [], saves = { blobs: [], links: [], fail: null };
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  for (const [key, value] of Object.entries({ ...seed, ...extra })) w.localStorage.setItem(key, value);
  const proto = w.Storage.prototype, get = proto.getItem, set = proto.setItem;
  // Another window's write, past the page's own (which records and refuses them).
  const elsewhere = (key, value) => set.call(w.localStorage, key, value);
  // Keys whose read the browser refuses, as it may at any moment.
  const refusing = new Set();
  proto.getItem = function (key) {
    reads.push(key);
    if (refusing.has(key)) throw new w.DOMException("The operation is insecure.", "SecurityError");
    return get.call(this, key);
  };
  proto.setItem = function (key) { writes.push(`set ${key}`); };
  proto.removeItem = function (key) { writes.push(`remove ${key}`); };
  if (refuse) Object.defineProperty(w, "localStorage", { configurable: true, get() { throw new w.DOMException("The operation is insecure.", "SecurityError"); } });
  w.URL.createObjectURL = (blob) => { if (saves.fail) throw new w.Error(saves.fail); saves.blobs.push(blob); return "blob:http://isolated.test/fixture"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { saves.links.push(this.getAttribute("download")); };
  w.eval(bundle);
  // Every render is in a Workspace, as the page is; a test that needs another
  // one passes its own.
  const render = w.renderDrafts;
  w.renderDrafts = (props) => render({ workspaceId: WORKSPACE, ...props });
  const section = () => doc.querySelector("#settings-drafts");
  const row = (id) => doc.querySelector(`[data-agent="${id}"]:not([data-unattributed])`);
  /** A row for a draft that does not say which Workspace it was written in. */
  const stranded = (id) => doc.querySelector(`[data-agent="${id}"][data-unattributed]`);
  const shown = () => doc.querySelector("#settings-drafts textarea")?.value;
  const blobText = (blob) => new Promise((resolve) => { const r = new w.FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });
  const tick = (id) => row(id).querySelector('input[type="checkbox"]');
  const tickStranded = (id) => stranded(id).querySelector('input[type="checkbox"]');
  const button = (text) => [...section().querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  return { w, doc, errors, reads, writes, saves, section, row, stranded, shown, blobText, tick, tickStranded, button, elsewhere, refusing, close: () => w.close() };
}

test("the list reads manifests only, shows this Workspace's drafts as they are, and counts the others", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: false, agents });
  await tick(); await tick();
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.") && key !== "yuzuno.language"), [], "hidden, it reads no draft (only the language it is shown in)");
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a1"), "the list");
  assert.match(p.row("a1").textContent, /^Cedar12 characters of text, 1 pasted text, 1 image \(referenced; not saved in the file\) Show$/);
  assert.equal(p.row("a2") === null, true, "a draft that does not name a Workspace is not shown as this one's");
  assert.match(
    p.stranded("a2").textContent,
    /^Pine \(closed\)Workspace not recorded: Saved by an earlier version: 12 characters of text Show$/,
    "it is shown as exactly what it is, under the name of the Agent ID it does say",
  );
  assert.match(p.row("a3").textContent, /^MapleCan't be read \(.+\); left as it is\.$/, "a damaged draft is said, and offers nothing");
  assert.equal(p.row("a4") === null, true, "an empty saved draft is no draft");
  assert.equal(p.row("zz") === null, true, "a draft for an Agent this Workspace doesn't list is not shown");
  assert.match(p.section().textContent, /1 saved draft is for Agent IDs this Workspace doesn't list, so it is not shown here\./);
  assert.match(p.section().textContent, /1 saved draft does not say which Workspace it was written in, from before Yuzuno recorded that\./);
  assert.match(p.section().textContent, /A draft is saved under the Workspace and Agent it was written in, so another Workspace's drafts at this address are not shown here/);
  assert.ok(
    !p.section().textContent.includes("another Workspace's words"),
    "the other Workspace's draft is neither shown nor counted",
  );
  assert.deepEqual(
    p.reads.filter((key) => key.includes("ws-other")),
    [],
    "and it is not even read",
  );
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.paste.v1:")), [], "no pasted text is read for the list");
  assert.deepEqual(p.writes, [], "nothing is written");
  assert.deepEqual(p.errors, []);
});

test("a chosen draft is shown whole, pasted text included, and saved as a text file only when asked", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a1"));
  p.row("a1").querySelector("button").click();
  const text = await until(() => p.shown(), "the chosen draft");
  assert.match(text, /^Yuzuno draft for Cedar\nExported \S+ from the copy saved in this browser for this site\. Text typed since it was last saved is not included\.\nSaved under the Workspace and Agent it was written in\.\n/);
  assert.match(text, /^Images in the draft: 1 \(references only; the images themselves are not in this file\)$/m);
  assert.match(text, /Hello there \n\[Pasted text #1, 2 lines\]\nPASTED BODY line one\nline two\n\[End of pasted text #1\]\n$/);
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.paste.v1:")), ["yuzuno.paste.v1:a1:b1"], "only the chosen draft's pasted text is read");
  assert.deepEqual([p.saves.blobs.length, p.saves.links.length], [0, 0], "showing saves nothing");
  assert.match(p.section().textContent, /The whole saved draft for Cedar\. Nothing has been saved, copied or sent\./);
  [...p.section().querySelectorAll("button")].find((b) => b.textContent.trim() === "Download .txt").click();
  await until(() => p.saves.links.length === 1, "a download is asked for");
  assert.match(p.saves.links[0], /^yuzuno-draft-Cedar-[\dTZ-]+\.txt$/);
  assert.equal(await p.blobText(p.saves.blobs[0]), text, "the file holds the shown text");
  assert.match(p.section().textContent, /Your browser was asked to save yuzuno-draft-Cedar-[\dTZ-]+\.txt\./);
  // A draft that does not name a Workspace is shown the same way, and says so.
  p.stranded("a2").querySelector("button").click();
  await until(() => /legacy words$/.test(p.shown() || ""), "the draft saved before Workspaces were recorded");
  assert.match(
    p.shown(),
    /^Yuzuno draft for Pine\nExported \S+ from the copy saved in this browser for this site\. Text typed since it was last saved is not included\.\nSaved before Yuzuno recorded the Workspace a draft belongs to: it names this Agent ID only, so which Workspace it was written in is not known\.\n/,
  );
  // Another Agent joins the Workspace: the list is read again and the open draft stays.
  p.w.renderDrafts({ active: true, agents: [...agents, { id: "a6", name: "Elm" }] });
  await tick(); await tick();
  assert.match(p.shown() || "", /legacy words$/, "the open draft stays");
  // That Agent ID is no longer listed. The draft is still on this device and
  // was never this Workspace's to begin with, so it stays -- named by its ID.
  p.w.renderDrafts({ active: true, agents: agents.filter((agent) => agent.id !== "a2") });
  await until(() => p.stranded("a2")?.textContent.startsWith("a2"), "the row named by its Agent ID");
  assert.match(p.shown() || "", /legacy words$/);
  // An Agent this Workspace lists no longer: its draft is this Workspace's,
  // so the open draft is put away with the row.
  p.row("a1").querySelector("button").click();
  await until(() => /PASTED BODY/.test(p.shown() || ""), "this Workspace's draft");
  p.w.renderDrafts({ active: true, agents: agents.filter((agent) => agent.id !== "a1") });
  await until(() => p.shown() === undefined, "the draft of an Agent no longer listed is put away");
  assert.deepEqual(p.writes, [], "nothing is written");
});

test("a draft that can't be opened, or a download that can't start, is said and claims nothing", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a5"));
  p.row("a5").querySelector("button").click();
  await until(() => p.section().querySelector('[role="alert"]'), "the unreadable draft is said");
  assert.match(p.section().querySelector('[role="alert"]').textContent, /^The draft for Rowan can't be read \(Saved pasted text is missing\)\. It is left as it is\.$/);
  assert.equal(p.shown(), undefined);
  p.row("a1").querySelector("button").click();
  await until(() => p.shown());
  p.saves.fail = "Blob URLs are blocked here";
  [...p.section().querySelectorAll("button")].find((b) => b.textContent.trim() === "Download .txt").click();
  await until(() => /could not start/.test(p.section().textContent), "the failed download is said");
  assert.match(p.section().textContent, /The download could not start \(Blob URLs are blocked here\)\. Select the text below and copy it\./);
  assert.doesNotMatch(p.section().textContent, /asked to save/);
  assert.deepEqual(p.writes, []);
});

test("storage the browser refuses is said, and nothing is listed", async (t) => {
  const p = mount({ refuse: true }); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.section()?.querySelector('[role="alert"]'), "the refusal");
  assert.equal(p.section().querySelector('[role="alert"]').textContent, "Drafts can't be read: this browser gives Yuzuno no storage here.");
  assert.equal(p.doc.querySelectorAll("[data-agent]").length, 0);
});

// T-193: several drafts, ticked, saved together as one versioned file.
const second = { [`yuzuno.composer.v1:${mine("a6")}`]: JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "the other Cedar's words" }] }) };
const twins = [...agents, { id: "a6", name: "Cedar" }];

test("ticked drafts are read only when downloaded, kept apart by Agent ID under one name, and saved as one versioned file", async (t) => {
  const p = mount({ extra: second }); t.after(p.close);
  p.w.renderDrafts({ active: true, agents: twins });
  await until(() => p.row("a6"), "the list");
  assert.equal(p.tick("a3") === null, true, "a damaged draft can't be ticked");
  assert.equal(p.button("Download selected (.json)").disabled, true, "nothing ticked, nothing to save");
  for (const id of ["a6", "a1"]) p.tick(id).click();
  p.tickStranded("a2").click();
  await until(() => /3 drafts chosen/.test(p.section().textContent), "the choice");
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.paste.v1:")), [], "ticking reads no pasted text");
  p.button("Download selected (.json)").click();
  await until(() => p.saves.links.length === 1, "a download is asked for");
  assert.match(p.saves.links[0], /^yuzuno-drafts-[\dTZ-]+\.json$/);
  assert.equal(p.saves.blobs[0].type, "application/json;charset=utf-8");
  const file = JSON.parse(await p.blobText(p.saves.blobs[0]));
  assert.deepEqual({ format: file.format, version: file.version }, { format: "yuzuno-drafts", version: 1 });
  assert.match(file.exportedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(file.note, /text typed since it was last saved is not included\. Each draft says the Workspace and Agent it was written in, unless it was saved before Yuzuno recorded the Workspace \(workspace: notRecorded\)\./);
  // In list order, each its own, as saved: pasted text in place, images only counted.
  assert.deepEqual(file.drafts, [
    { agentId: "a1", name: "Cedar", closed: false, workspace: "thisWorkspace", savedBy: "thisVersion", images: 1, skills: [],
      parts: [{ kind: "text", text: "Hello there " }, { kind: "paste", number: 1, lines: 2, text: "PASTED BODY line one\nline two" }] },
    { agentId: "a6", name: "Cedar", closed: false, workspace: "thisWorkspace", savedBy: "thisVersion", images: 0, skills: [], parts: [{ kind: "text", text: "the other Cedar's words" }] },
    // Each draft says whether it names the Workspace it was written in, so a
    // file holding both cannot be mistaken for all one Workspace's (T-195).
    { agentId: "a2", name: "Pine", closed: true, workspace: "notRecorded", savedBy: "earlierVersion", images: 0, skills: [], parts: [{ kind: "text", text: "legacy words" }] },
  ]);
  assert.ok(!JSON.stringify(file).includes("screen.png"), "no image is in the file, not even by name");
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.paste.v1:")), [`yuzuno.paste.v1:${mine("a1")}:b1`], "only the ticked drafts' pasted text is read");
  assert.match(p.section().textContent, /Your browser was asked to save yuzuno-drafts-[\dTZ-]+\.json \(3 drafts\)\./);
  assert.deepEqual(p.writes, [], "nothing is written");
  // The one-draft text file is as before.
  p.row("a1").querySelector("button").click();
  await until(() => p.shown(), "the chosen draft");
  p.button("Download .txt").click();
  await until(() => p.saves.links.length === 2);
  assert.match(p.saves.links[1], /^yuzuno-draft-Cedar-[\dTZ-]+\.txt$/);
  assert.deepEqual(p.errors, []);
});

test("when a ticked draft can't be read, nothing is downloaded, it is named, the choice stays, and untick it saves the rest", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a5"));
  p.tick("a1").click();
  p.tick("a5").click();
  await until(() => /2 drafts chosen/.test(p.section().textContent));
  p.button("Download selected (.json)").click();
  const alert = await until(() => p.section().querySelector(".draft-export-many [role=\"alert\"]"), "the failure is said");
  assert.equal(alert.textContent, "Nothing was downloaded: 1 of 2 chosen drafts can't be read (Rowan: Saved pasted text is missing). Untick it to save the rest.");
  assert.equal(p.saves.links.length, 0, "no partial file");
  assert.deepEqual([p.tick("a1").checked, p.tick("a5").checked], [true, true], "the choice stays");
  assert.deepEqual(p.writes, [], "the drafts are left as they are");
  p.tick("a5").click();
  await until(() => /1 draft chosen/.test(p.section().textContent));
  p.button("Download selected (.json)").click();
  await until(() => p.saves.links.length === 1, "the rest is saved");
  assert.deepEqual(JSON.parse(await p.blobText(p.saves.blobs[0])).drafts.map((d) => d.agentId), ["a1"]);
  assert.deepEqual(p.writes, []);
});

test("ticked drafts are saved as they are when downloaded: one another window re-saved says so, one it emptied is named, not saved empty", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a7"));
  p.tick("a1").click();
  p.tick("a7").click();
  await until(() => /2 drafts chosen/.test(p.section().textContent));
  // Another window, after the list was read: Willow's draft re-saved, Cedar's emptied.
  p.elsewhere(`yuzuno.composer.v1:${mine("a7")}`, JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "re-saved words" }] }));
  p.elsewhere(`yuzuno.composer.v1:${mine("a1")}`, JSON.stringify({ version: 1, nextNumber: 1, parts: [] }));
  p.button("Download selected (.json)").click();
  const alert = await until(() => p.section().querySelector(".draft-export-many [role=\"alert\"]"), "the emptied draft is said");
  assert.equal(alert.textContent, "Nothing was downloaded: 1 of 2 chosen drafts can't be read (Cedar: it is no longer saved here). Untick it to save the rest.");
  assert.equal(p.saves.links.length, 0);
  p.tick("a1").click();
  await until(() => /1 draft chosen/.test(p.section().textContent));
  p.button("Download selected (.json)").click();
  await until(() => p.saves.links.length === 1);
  assert.deepEqual(JSON.parse(await p.blobText(p.saves.blobs[0])).drafts, [
    { agentId: "a7", name: "Willow", closed: false, workspace: "thisWorkspace", savedBy: "thisVersion", images: 0, skills: [], parts: [{ kind: "text", text: "re-saved words" }] },
  ]);
  assert.deepEqual(p.writes, [], "the page wrote nothing");
});

test("a ticked draft whose saved copy the browser refuses to read is named: nothing is downloaded, the choice stays, nothing is written", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a7"));
  p.tick("a1").click();
  p.tick("a7").click();
  await until(() => /2 drafts chosen/.test(p.section().textContent));
  p.refusing.add(`yuzuno.composer.v1:${mine("a1")}`);
  p.button("Download selected (.json)").click();
  const alert = await until(() => p.section().querySelector(".draft-export-many [role=\"alert\"]"), "the refused read is said");
  assert.match(alert.textContent, /^Nothing was downloaded: 1 of 2 chosen drafts can't be read \(Cedar: [^)]*insecure[^)]*\)\. Untick it to save the rest\.$/);
  assert.equal(p.saves.links.length, 0, "no partial file");
  assert.deepEqual([p.tick("a1").checked, p.tick("a7").checked], [true, true], "the choice stays");
  assert.deepEqual(p.writes, [], "nothing is written");
  assert.deepEqual(p.errors, [], "no error escapes the page");
});

// T-189: the language changed in another window. The page's own words
// change; the drafts, their names, the shown draft and its file name stay as
// they are, what is ticked stays ticked, and no draft is read, written or
// downloaded for it. What a draft's own check says is said in Chinese too.
test("switched to Chinese in another window, the page's words change and the choice, the shown draft and the asked-for file stay; nothing is read, written or downloaded", async (t) => {
  const p = mount(); t.after(p.close);
  const draftReads = () => p.reads.filter((key) => key !== "yuzuno.language");
  const language = (value) => {
    p.elsewhere("yuzuno.language", JSON.stringify({ language: value }));
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.language" }));
  };
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a7"));
  p.tick("a1").click();
  p.tick("a7").click();
  p.row("a1").querySelector("button").click();
  const text = await until(() => p.shown(), "the chosen draft");
  p.button("Download .txt").click();
  await until(() => p.saves.links.length === 1, "a download is asked for");
  const en = p.section().textContent, read = draftReads().length;
  language("zh-Hans");
  await until(() => p.section().querySelector("h3").textContent === "此设备上的草稿", "shown in Chinese");
  assert.match(p.row("a1").textContent, /^Cedar文本 12 个字符，粘贴的文本 1 段，图片 1 张（仅引用；不保存在文件中） 显示$/);
  assert.match(p.stranded("a2").textContent, /^Pine（已关闭）未记录 Workspace：由早期版本保存：文本 12 个字符 显示$/);
  assert.match(p.row("a3").textContent, /^Maple无法读取（.+）；保持原样。$/, "the browser's words for a damaged draft, as it gave them");
  assert.match(p.section().textContent, /已选择 2 份草稿。只有在下载时才会读取它们粘贴的文本。/);
  assert.match(p.section().textContent, /另有 1 份已保存的草稿属于此 Workspace 未列出的 Agent ID，因此不在这里显示。/);
  assert.match(p.section().textContent, /有 1 份已保存的草稿没有记录它写在哪个 Workspace（在 Yuzuno 开始记录之前保存）。/);
  assert.match(p.section().textContent, /已请求浏览器保存 yuzuno-draft-Cedar-[\dTZ-]+\.txt。如果没有出现文件，请选中下方文字并复制。/, "asked, not said to be saved");
  assert.equal(p.shown(), text, "the shown draft is as it was, its export text as written");
  assert.equal(p.section().querySelector("textarea").getAttribute("aria-label"), "Cedar 已保存的草稿");
  assert.deepEqual([p.tick("a1").checked, p.tick("a7").checked], [true, true], "the choice stays");
  assert.deepEqual([draftReads().length, p.writes, p.saves.links.length], [read, [], 1], "no draft read, nothing written or downloaded");
  language("en");
  await until(() => p.section().querySelector("h3").textContent === "Drafts on this device", "back in English");
  assert.equal(p.section().textContent, en, "as it was in English");
  // A ticked draft whose pasted text is missing: the check's words, in Chinese.
  language("zh-Hans");
  await until(() => p.section().querySelector("h3").textContent === "此设备上的草稿");
  p.tick("a5").click();
  p.button("下载所选（.json）").click();
  const alert = await until(() => p.section().querySelector(".draft-export-many [role=\"alert\"]"), "the failure is said");
  assert.equal(alert.textContent, "没有下载任何内容：所选的 3 份草稿中有 1 份无法读取（Rowan：保存的粘贴文本已丢失）。取消勾选它即可保存其余草稿。");
  assert.deepEqual([p.writes, p.saves.links.length], [[], 1], "no partial file");
  assert.deepEqual(p.errors, []);
});

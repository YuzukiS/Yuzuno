// Drive CodeMirror through its public view API in JSDOM. Native selection,
// clipboard and IME behavior are checked separately in Chromium.
import assert from "node:assert/strict";
import { EditorView } from "@codemirror/view";
import { DraftStorage, draftText } from "../src/composer-draft.ts";

export function composerView(element) {
  const view = EditorView.findFromDOM(element);
  assert.ok(view, "Composer editor is mounted");
  return view;
}
export const composerText = (element) =>
  composerView(element).state.doc.toString();
export const composerSelection = (element) =>
  composerView(element).state.selection.main.head;
export function setComposerText(element, text) {
  const view = composerView(element);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
  });
}
/**
 * The draft saved for `agent` in the one Workspace this page is in, or "" if
 * it has none. A draft is saved under the Workspace and the Agent (T-195),
 * and a fixture page is in exactly one Workspace, so the key is the one whose
 * identity names this Agent. A key saved before Workspaces were recorded is
 * not read, as the composer no longer reads one either.
 */
export const savedDraftText = (storage, agent) => {
  const prefix = "yuzuno.composer.v1:";
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const identity = key.slice(prefix.length);
    let parsed;
    try {
      parsed = JSON.parse(identity);
    } catch {
      continue;
    }
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[1] === agent)
      return draftText(new DraftStorage(storage).load(identity));
  }
  return "";
};

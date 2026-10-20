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
export const savedDraftText = (storage, agent) =>
  draftText(new DraftStorage(storage).load(agent));

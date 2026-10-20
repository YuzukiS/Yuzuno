import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type ChangeDesc,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  pastedText,
  type ComposerDraft,
  type DraftPart,
  type PastedText,
} from "./composer-draft.ts";

export const pasteMarker = "\ufffc";
export type PasteAnchor = { from: number; paste: PastedText };
function mapped(anchors: readonly PasteAnchor[], changes: ChangeDesc) {
  return anchors.flatMap((anchor) => {
    let removed = false;
    changes.iterChangedRanges((from, to) => {
      if (from <= anchor.from && to > anchor.from) removed = true;
    });
    return removed ? [] : [{ ...anchor, from: changes.mapPos(anchor.from, 1) }];
  });
}
export const setPasteAnchors = StateEffect.define<readonly PasteAnchor[]>({
  map: mapped,
});
export const pasteField = StateField.define<{
  anchors: readonly PasteAnchor[];
  nextNumber: number;
}>({
  create: () => ({ anchors: [], nextNumber: 1 }),
  update(value, tr) {
    let anchors = tr.docChanged
      ? mapped(value.anchors, tr.changes)
      : value.anchors;
    for (const effect of tr.effects)
      if (effect.is(setPasteAnchors)) anchors = effect.value;
    return {
      anchors,
      nextNumber: Math.max(
        value.nextNumber,
        ...anchors.map((a) => a.paste.number + 1),
      ),
    };
  },
});
export const pasteHistory = invertedEffects.of((tr) =>
  tr.docChanged || tr.effects.some((e) => e.is(setPasteAnchors))
    ? [setPasteAnchors.of(tr.startState.field(pasteField).anchors)]
    : [],
);

export function draftDocument(draft: ComposerDraft) {
  let doc = "";
  const anchors: PasteAnchor[] = [];
  for (const part of draft.parts) {
    if (part.kind === "text") doc += part.text.replace(/\r\n|\r/g, "\n");
    else {
      anchors.push({ from: doc.length, paste: part });
      doc += pasteMarker;
    }
  }
  return { doc, anchors, nextNumber: draft.nextNumber };
}
export function editorDraft(state: EditorState): ComposerDraft {
  const { anchors, nextNumber } = state.field(pasteField);
  const parts: DraftPart[] = [];
  let from = 0;
  for (const anchor of anchors) {
    if (anchor.from > from)
      parts.push({ kind: "text", text: state.sliceDoc(from, anchor.from) });
    parts.push(anchor.paste);
    from = anchor.from + 1;
  }
  if (from < state.doc.length)
    parts.push({ kind: "text", text: state.sliceDoc(from) });
  return { version: 1, nextNumber, parts };
}
export function textRange(state: EditorState, from: number, to: number) {
  let text = "",
    at = from;
  for (const anchor of state.field(pasteField).anchors) {
    if (anchor.from < from || anchor.from >= to) continue;
    text += state.sliceDoc(at, anchor.from) + anchor.paste.text;
    at = anchor.from + 1;
  }
  return text + state.sliceDoc(at, to);
}
export function insertPaste(
  state: EditorState,
  text: string,
  from = state.selection.main.from,
  to = state.selection.main.to,
) {
  const value = state.field(pasteField);
  const paste = pastedText(text, value.nextNumber);
  const changes = state.changes({ from, to, insert: pasteMarker });
  const anchors = [...mapped(value.anchors, changes), { from, paste }].sort(
    (a, b) => a.from - b.from,
  );
  return state.update({
    changes,
    effects: setPasteAnchors.of(anchors),
    selection: EditorSelection.cursor(from + 1),
    userEvent: "input.paste",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
}
export function editPaste(state: EditorState, id: string, text: string) {
  const value = state.field(pasteField);
  return state.update({
    effects: setPasteAnchors.of(
      value.anchors.map((a) =>
        a.paste.id === id
          ? { ...a, paste: pastedText(text, a.paste.number, id) }
          : a,
      ),
    ),
    userEvent: "input.paste.edit",
    annotations: isolateHistory.of("full"),
  });
}

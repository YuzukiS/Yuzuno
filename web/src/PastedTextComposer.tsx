import { textLabel } from "./message-content";
import { clipboardImages } from "./image-input";
import { touchKeyboard } from "./touch-input";
import { returnSends, type SendKey } from "./device-preferences";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  history,
  historyKeymap,
  insertNewline,
  isolateHistory,
  standardKeymap,
  transposeChars,
} from "@codemirror/commands";
import {
  Decoration,
  EditorView,
  WidgetType,
  closeHoverTooltips,
  hasHoverTooltips,
  hoverTooltip,
  keymap,
  placeholder,
  tooltips,
} from "@codemirror/view";
import { Modal } from "./components";
import {
  draftDocument,
  editPaste,
  editorDraft,
  insertPaste,
  pasteField,
  pasteHistory,
  textRange,
} from "./composer-editor";
import {
  shouldFoldPaste,
  type ComposerDraft,
  type PastedText,
} from "./composer-draft";
import { slashCommands, withCodexSkills, withModelControl, type CommandList, type SlashCommand } from "./slash-commands";
import { api } from "./api";
import "./pasted-text.css";
import "./slash-commands.css";

export type ComposerHandle = {
  focus: (options?: FocusOptions) => void;
  focusEnd: () => void;
  append: (text: string) => void;
};
type Props = {
  agentId: string;
  label: string;
  placeholder: string;
  draft: ComposerDraft;
  readOnly?: boolean;
  /** When the draft starts with "/": a Claude Agent's commands, or the
   * controls Yuzuno runs for a Codex Agent and the skills its Codex lists
   * (also after "$"). */
  slashCommands?: "claude" | "codex" | false;
  onChange: (draft: ComposerDraft) => void;
  /** A Codex skill chosen from the list: for the draft's chosen skills. */
  onSkill?: (skill: SlashCommand) => void;
  onSubmit: () => void;
  onImages?: (files: File[]) => void;
  /** Which key sends (device-preferences.ts); unset, as `auto`. */
  sendKey?: SendKey;
};

class PasteWidget extends WidgetType {
  constructor(
    readonly paste: PastedText,
    readonly open: (id: string, button: HTMLElement) => void,
  ) {
    super();
  }
  eq(other: PasteWidget) {
    return other.paste === this.paste;
  }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pasted-text-chip";
    button.dataset.pasteId = this.paste.id;
    button.textContent = `${textLabel(this.paste.text) || "Empty text"} · ${this.paste.lines} ${this.paste.lines === 1 ? "line" : "lines"}`;
    button.setAttribute("aria-label", `${button.textContent}. View and edit`);
    // The rule lives here rather than as a standing line under the draft.
    button.title = "Long pastes (12+ lines or 2,000+ characters) fold into a block. Open it to view or edit.";
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      this.open(this.paste.id, button);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        this.open(this.paste.id, button);
      }
    });
    return button;
  }
  ignoreEvent() {
    return true;
  }
}

export const PastedTextComposer = forwardRef<ComposerHandle, Props>(
  function PastedTextComposer(props, ref) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const callbacks = useRef(props);
    callbacks.current = props;
    const published = useRef(props.draft);
    const histories = useRef(
      new Map<string, { state: EditorState; draft: ComposerDraft }>(),
    );
    const options = useRef(new Compartment());
    const [opened, setOpened] = useState<{
      id: string;
      agent: string;
      paste: PastedText;
    } | null>(null);
    const [edited, setEdited] = useState("");
    const [didEdit, setDidEdit] = useState(false);
    const returnFocus = useRef<HTMLElement | null>(null);
    const dragSource = useRef<EditorView | null>(null);
    const open = (id: string, button: HTMLElement) => {
      const paste = view.current?.state
        .field(pasteField)
        .anchors.find((a) => a.paste.id === id)?.paste;
      if (!paste) return;
      returnFocus.current = button;
      setOpened({ id, agent: callbacks.current.agentId, paste });
      setEdited(paste.text);
      setDidEdit(false);
    };
    const openRef = useRef(open);
    openRef.current = open;
    const configure = () => [
      placeholder(callbacks.current.placeholder),
      EditorState.readOnly.of(!!callbacks.current.readOnly),
      EditorView.editable.of(!callbacks.current.readOnly),
      EditorView.contentAttributes.of({
        "aria-label": callbacks.current.label,
        "aria-multiline": "true",
        "data-composer-input": "true",
        spellcheck: "true",
      }),
      callbacks.current.slashCommands === "claude" && !callbacks.current.readOnly
        ? slashCommands(() =>
            api<CommandList>(
              `/agents/${encodeURIComponent(callbacks.current.agentId)}/claude/commands`,
            ).then(withModelControl),
          )
        : callbacks.current.slashCommands === "codex" && !callbacks.current.readOnly
          ? slashCommands(
              () =>
                api<CommandList>(
                  `/agents/${encodeURIComponent(callbacks.current.agentId)}/codex/skills`,
                ).then(withCodexSkills, () => withCodexSkills({ state: "failed", reason: "read_failed" })),
              "codex",
              (skill) => callbacks.current.onSkill?.(skill),
            )
          : [],
    ];
    function stateFor(draft: ComposerDraft) {
      const initial = draftDocument(draft);
      return EditorState.create({
        doc: initial.doc,
        extensions: [
          pasteField.init(() => ({
            anchors: initial.anchors,
            nextNumber: initial.nextNumber,
          })),
          pasteHistory,
          history(),
          keymap.of([
            {
              key: "Escape",
              run(v) {
                if (!hasHoverTooltips(v.state)) return false;
                v.dispatch({ effects: closeHoverTooltips });
                return true;
              },
            },
            ...historyKeymap,
            { key: "Shift-Enter", run: insertNewline },
            // Plain-text navigation/deletion only. Code editor line-copy/move
            // and transpose commands duplicate raw marker characters without
            // their bodies, so those commands must not be installed here.
            ...standardKeymap.filter(
              (binding) =>
                binding.key !== "Enter" && binding.run !== transposeChars,
            ),
          ]),
          options.current.of(configure()),
          EditorView.lineWrapping,
          EditorView.decorations.compute([pasteField], (state) =>
            Decoration.set(
              state.field(pasteField).anchors.map((a) =>
                Decoration.replace({
                  widget: new PasteWidget(a.paste, (id, button) =>
                    openRef.current(id, button),
                  ),
                  inclusive: false,
                }).range(a.from, a.from + 1),
              ),
            ),
          ),
          EditorView.atomicRanges.of(
            (v) =>
              v.state
                .facet(EditorView.decorations)
                .flatMap((source) =>
                  typeof source === "function" ? [] : [source],
                )[0] || Decoration.none,
          ),
          hoverTooltip(
            (v, pos) => {
              const anchor = v.state
                .field(pasteField)
                .anchors.find((a) => a.from <= pos && a.from + 1 >= pos);
              if (!anchor) return null;
              return {
                pos: anchor.from,
                end: anchor.from + 1,
                above: true,
                create() {
                  const dom = document.createElement("div");
                  dom.className = "pasted-text-preview";
                  const pre = document.createElement("pre");
                  pre.textContent = anchor.paste.preview;
                  const hint = document.createElement("small");
                  hint.textContent =
                    "Preview · open to view and edit the full text";
                  dom.append(pre, hint);
                  return {
                    dom,
                    mount() {
                      dom.parentElement?.classList.add(
                        "pasted-text-preview-container",
                      );
                    },
                  };
                },
              };
            },
            { hoverTime: 300 },
          ),
          tooltips({ parent: document.body, position: "fixed" }),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown(event, v) {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  !v.composing &&
                  event.target === v.contentDOM
                ) {
                  event.preventDefault();
                  // Ctrl/Cmd+Enter always sends, from a keyboard attached to
                  // a touch screen too; Return alone as this device's
                  // preference says.
                  if (event.ctrlKey || event.metaKey || returnSends(callbacks.current.sendKey ?? "auto", touchKeyboard()))
                    callbacks.current.onSubmit();
                  else insertNewline(v);
                  return true;
                }
                return false;
              },
              paste(event, v) {
                const files = clipboardImages(event.clipboardData);
                if (files.length && !v.state.readOnly) {
                  event.preventDefault();
                  const text = event.clipboardData?.getData("text/plain");
                  if (text) v.dispatch(shouldFoldPaste(text) ? insertPaste(v.state, text) : v.state.update(v.state.replaceSelection(text), { userEvent: "input.paste" }));
                  callbacks.current.onImages?.(files);
                  return true;
                }
                const text = event.clipboardData?.getData("text/plain");
                if (v.state.readOnly || !text || !shouldFoldPaste(text))
                  return false;
                event.preventDefault();
                v.dispatch(insertPaste(v.state, text));
                return true;
              },
              copy: (event, v) => copy(event, v, false),
              cut: (event, v) => copy(event, v, true),
              dragstart(event, v) {
                dragSource.current = null;
                const { from, to } = v.state.selection.main;
                if (
                  v.state
                    .field(pasteField)
                    .anchors.some((a) => a.from >= from && a.from < to)
                ) {
                  event.preventDefault();
                  return true;
                }
                dragSource.current = v;
                return false;
              },
              dragend() {
                dragSource.current = null;
                return false;
              },
              drop(event, v) {
                const internal = dragSource.current === v;
                dragSource.current = null;
                // Let CodeMirror move/copy ordinary text using its normal drag
                // semantics. Only external long text becomes a new paste block.
                if (internal) return false;
                const text = event.dataTransfer?.getData("text/plain");
                if (v.state.readOnly || !text || !shouldFoldPaste(text))
                  return false;
                const pos =
                  v.posAtCoords({ x: event.clientX, y: event.clientY }) ??
                  v.state.selection.main.head;
                event.preventDefault();
                v.dispatch(insertPaste(v.state, text, pos, pos));
                return true;
              },
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (
              !update.docChanged &&
              update.startState.field(pasteField).anchors ===
                update.state.field(pasteField).anchors
            )
              return;
            const next = { ...editorDraft(update.state), images: callbacks.current.draft.images, skills: callbacks.current.draft.skills };
            published.current = next;
            callbacks.current.onChange(next);
          }),
        ],
      });
    }
    function copy(event: ClipboardEvent, v: EditorView, cut: boolean) {
      if (!event.clipboardData) return false;
      const selection = v.state.selection.main;
      const line = v.state.doc.lineAt(selection.from);
      const from = selection.empty ? line.from : selection.from;
      const to = selection.empty
        ? Math.min(v.state.doc.length, line.to + 1)
        : selection.to;
      event.clipboardData.setData("text/plain", textRange(v.state, from, to));
      event.preventDefault();
      if (cut && !v.state.readOnly)
        v.dispatch({
          changes: { from, to },
          selection: { anchor: from },
          userEvent: "delete.cut",
          annotations: isolateHistory.of("full"),
        });
      return true;
    }
    useLayoutEffect(() => {
      const saved = histories.current.get(props.agentId);
      published.current = props.draft;
      const editor = new EditorView({
        parent: host.current!,
        state:
          saved?.draft === props.draft ? saved.state : stateFor(props.draft),
      });
      view.current = editor;
      editor.dispatch({ effects: options.current.reconfigure(configure()) });
      setOpened(null);
      return () => {
        histories.current.set(props.agentId, {
          state: editor.state,
          draft: published.current,
        });
        editor.destroy();
        dragSource.current = null;
        view.current = null;
      };
    }, [props.agentId]);
    useEffect(() => {
      const editor = view.current;
      if (!editor) return;
      if (props.draft !== published.current) {
        const textChanged = props.draft.parts !== published.current.parts || props.draft.nextNumber !== published.current.nextNumber;
        published.current = props.draft;
        if (textChanged) editor.setState(stateFor(props.draft));
      }
    }, [props.draft]);
    useEffect(() => {
      view.current?.dispatch({
        effects: options.current.reconfigure(configure()),
      });
    }, [props.label, props.placeholder, props.readOnly, props.slashCommands]);
    useImperativeHandle(ref, () => ({
      focus: () => view.current?.focus(),
      focusEnd() {
        const v = view.current;
        if (v) {
          v.focus();
          v.dispatch({
            selection: { anchor: v.state.doc.length },
            scrollIntoView: true,
          });
        }
      },
      append(text) {
        const v = view.current;
        if (!v || v.state.readOnly) return;
        const changes = v.state.changes({
          from: v.state.doc.length,
          insert: `${v.state.doc.length ? "\n\n" : ""}${text}`,
        });
        v.dispatch({
          changes,
          selection: { anchor: changes.newLength },
          userEvent: "input",
          annotations: isolateHistory.of("full"),
          scrollIntoView: true,
        });
        v.focus();
      },
    }));
    const active = opened?.agent === props.agentId ? opened : null;
    function save() {
      if (!active || !view.current || props.readOnly) return;
      // A block is byte-for-byte unchanged until edited. Editing uses the block's
      // uniform CRLF convention; mixed line endings become LF only after an edit.
      const crlf =
        active.paste.text.includes("\r\n") &&
        !/[\r\n]/.test(active.paste.text.replaceAll("\r\n", ""));
      const text = didEdit
        ? edited.replace(/\r\n|\r|\n/g, crlf ? "\r\n" : "\n")
        : active.paste.text;
      if (text !== active.paste.text)
        view.current.dispatch(editPaste(view.current.state, active.id, text));
      setOpened(null);
    }
    return (
      <>
        <div className="pasted-text-composer" ref={host} />
        <Modal
          open={!!active}
          onOpenChange={(value) => {
            if (!value) setOpened(null);
          }}
          title={active ? `Pasted text #${active.paste.number}` : "Pasted text"}
          description="View or edit the complete text. Saving changes does not send a message."
          wide
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
            else view.current?.focus();
          }}
        >
          <label className="pasted-text-source-label">
            Full pasted text
            <textarea
              className="pasted-text-source"
              aria-label="Full pasted text"
              value={edited}
              spellCheck={false}
              readOnly={props.readOnly}
              onChange={(event) => {
                setEdited(event.target.value);
                setDidEdit(true);
              }}
            />
          </label>
          <p className="pasted-text-edit-note">
            Original indentation and empty lines are kept.{" "}
            {active?.paste.text.includes("\r\n")
              ? "CRLF line endings are retained for CRLF text; mixed endings use LF after editing."
              : "Edits use LF line endings."}
          </p>
          <div className="pasted-text-dialog-actions">
            <button
              type="button"
              className="quiet-button danger"
              disabled={props.readOnly}
              onClick={() => {
                const v = view.current,
                  anchor = v?.state
                    .field(pasteField)
                    .anchors.find((a) => a.paste.id === active?.id);
                if (v && anchor)
                  v.dispatch({
                    changes: { from: anchor.from, to: anchor.from + 1 },
                    userEvent: "delete",
                    annotations: isolateHistory.of("full"),
                  });
                setOpened(null);
              }}
            >
              Remove block
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={props.readOnly}
              onClick={save}
            >
              Save changes
            </button>
          </div>
        </Modal>
      </>
    );
  },
);

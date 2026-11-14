import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Pencil } from "lucide-react";
import { Modal } from "./components";
import { errorText, renameAgent } from "./api";
import { coreLimits, overLimit } from "./core-limits";
import { FieldLength } from "./FieldLength";
import { langTag, strings, useLanguage } from "./i18n";
import type { Agent } from "./types";
import "./rename-agent.css";

// Renaming an Agent (YN-112): its own words. The Agent's name and Core's
// refusal are shown as they came.
const text = strings({
  title: "Rename agent",
  description: "Only the name it shows changes: its agent ID, tasks, mail and Home stay as they are.",
  name: "Name",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  // Not "Save …": the dialog's own Save, below, saves the settings.
  rename: "Rename",
  nameNote: "The name saves on its own, at once, without waiting for the models below.",
  close: "Close dialog",
  empty: "A name can’t be empty.",
  control: "A name can’t contain control characters, such as a tab.",
}, {
  title: "重命名 Agent",
  description: "只改显示的名字：Agent ID、任务、邮件和 Home 都不变。",
  name: "名称",
  cancel: "取消",
  save: "保存",
  saving: "正在保存…",
  rename: "重命名",
  nameNote: "名称单独保存，立即生效，不等下方的模型载入。",
  close: "关闭对话框",
  empty: "名称不能为空。",
  control: "名称不能包含控制字符（例如制表符）。",
});

/** C0 and C1 control characters: Rust's `char::is_control`, which Core's
 * rule (model.rs `agent_name`) refuses. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Why Core would refuse `value` as an Agent's name, by its rule: trimmed,
 * not empty, without control characters, and no longer than Core takes. */
export function agentNameProblem(value: string): "empty" | "control" | "long" | null {
  const name = value.trim();
  if (!name) return "empty";
  if (CONTROL.test(name)) return "control";
  if (overLimit(name, coreLimits.agentName)) return "long";
  return null;
}

/** The reason in place, under the field: Core's own length note for a name
 * that is too long, else what is wrong with it. Nothing for a good name. */
function NameProblem({ value }: { value: string }) {
  const t = text(useLanguage());
  const problem = agentNameProblem(value);
  if (problem === "long") return <FieldLength value={value} limit={coreLimits.agentName} />;
  if (!problem) return null;
  return (
    <p className="inline-error agent-name-problem" role="status">
      {problem === "empty" ? t.empty : t.control}
    </p>
  );
}

/** Saving a name for one Agent: what is typed, whether it is saving, and
 * Core's refusal. A result for another Agent never lands on this one. */
function useRename(agent: Agent | null, onRenamed: (name: string) => void) {
  const [value, setValue] = useState(agent?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(agent?.id ?? "");
  current.current = agent?.id ?? "";
  const problem = agentNameProblem(value);
  const unchanged = !!agent && value.trim() === agent.name;
  async function save(): Promise<boolean> {
    if (!agent || busy || problem || unchanged) return false;
    const target = agent.id;
    setBusy(true);
    setError("");
    try {
      const saved = await renameAgent(target, value.trim());
      if (current.current !== target) return false;
      setValue(saved.name);
      onRenamed(saved.name);
      return true;
    } catch (e) {
      if (current.current === target) setError(errorText(e));
      return false;
    } finally {
      if (current.current === target) setBusy(false);
    }
  }
  return { value, setValue, busy, error, problem, unchanged, save };
}

/**
 * The rename dialog (YN-112), from an Agent's actions menu: its row's
 * right-click, long-press or context-menu key, and its "…" button. It opens
 * with the name selected; Enter or Save renames, Escape, Cancel or the
 * backdrop leave it as it was. Nothing is saved implicitly. A name Core
 * would refuse cannot be sent, and the reason shows in place; a refusal from
 * Core keeps the dialog open with its words.
 */
export function RenameAgentDialog(props: {
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed: (name: string) => void;
}) {
  // Made afresh for each Agent it opens on, starting from its name now; it
  // has no Agent while closed.
  return props.agent && <RenameDialog key={props.agent.id} {...props} agent={props.agent} />;
}

function RenameDialog({
  agent,
  open,
  onOpenChange,
  onRenamed,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed: (name: string) => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const rename = useRename(agent, onRenamed);
  const field = useRef<HTMLInputElement>(null);
  // Where focus was as it opened: the row or button its menu opened from.
  const returnTo = useRef<HTMLElement | null>(null);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !rename.busy && onOpenChange(next)}
      // The name, selected, ready to be typed over.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        field.current?.focus();
        field.current?.select();
      }}
      // Closed, focus goes back there. A dialog with no trigger of its own
      // would otherwise leave it on the page itself.
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (returnTo.current?.isConnected) returnTo.current.focus();
      }}
      title={t.title}
      description={t.description}
      lang={langTag(language)}
      closeLabel={t.close}
    >
      <form
        className="create-form rename-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void rename.save().then((done) => done && onOpenChange(false));
        }}
      >
        <label>
          {t.name}
          <input
            ref={field}
            value={rename.value}
            readOnly={rename.busy}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!!rename.problem || undefined}
            onChange={(event) => rename.setValue(event.target.value)}
          />
        </label>
        <NameProblem value={rename.value} />
        {rename.error && (
          <p role="alert" className="recovery-error">
            {rename.error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={rename.busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="primary-button" disabled={rename.busy || !!rename.problem || rename.unchanged}>
            {rename.busy ? <LoaderCircle size={15} className="spin" /> : <Pencil size={15} />}
            {rename.busy ? t.saving : t.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The name in an Agent's settings (YN-112), first in the dialog: a field
 * with its own Rename button. The dialog's Save waits for the model catalog and, for
 * Codex, its runtime; a name never does, so it saves here on its own, even
 * when the Agent's machine is offline. Enter in the field saves the name
 * only, never the settings below. A name changed elsewhere (another page)
 * shows here while this field is not being edited.
 */
export function AgentNameSetting({ agent, onRenamed }: { agent: Agent; onRenamed: (name: string) => void }) {
  const t = text(useLanguage());
  const rename = useRename(agent, onRenamed);
  const id = useId();
  const shown = useRef(agent.name);
  useEffect(() => {
    if (rename.value === shown.current) rename.setValue(agent.name);
    shown.current = agent.name;
  }, [agent.name]);
  return (
    <div className="agent-setting agent-name-setting">
      <label htmlFor={id}>{t.name}</label>
      <div className="agent-name-row">
        <input
          id={id}
          value={rename.value}
          readOnly={rename.busy}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!rename.problem || undefined}
          onChange={(event) => rename.setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter saves the name alone; one that ends an IME composition
            // only ends it.
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            void rename.save();
          }}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={rename.busy || !!rename.problem || rename.unchanged}
          onClick={() => void rename.save()}
        >
          {rename.busy ? <LoaderCircle size={15} className="spin" /> : null}
          {rename.busy ? t.saving : t.rename}
        </button>
      </div>
      <NameProblem value={rename.value} />
      {rename.error && (
        <p role="alert" className="inline-error">
          {rename.error}
        </p>
      )}
      <small>{t.nameNote}</small>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { strings, useStrings } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";
import { useRevealIn } from "./surface";

type Style = "default" | "visual";
type Presentation = {
  style: Style;
  note: string;
  updatedAt: string | null;
  scope: "workspace";
  /** Exactly what Agents that write Home receive; null without a preference. */
  agentText: string | null;
};
const MAX_NOTE = 300;
/** As Core saves a note: whitespace collapsed, ends trimmed. */
const collapsed = (text: string) => text.trim().split(/\s+/).join(" ");

// The page's own words (T-189). The note, what Agents receive and Core's
// errors are shown as written.
const text = strings({
  section: "Home presentation settings",
  title: "Home",
  intro: "How Agents present results on Home. Saved in this Workspace, so every device that opens it uses the same choice.",
  inUse: "In use now",
  visual: "Visual first",
  standard: "Default",
  withNote: " · with your note",
  presentation: "Presentation",
  visualHelp: "A chart, screenshot or sketch first where the information suits it; long explanations after it.",
  standardHelp: "The form follows the information: a picture for a layout, a chart for numbers, a sentence for a single state.",
  presentationLabel: "Home presentation",
  note: "Your note (optional)",
  noteHelp: (count: number, max: number) => `In your own words, added to the preference. ${count}/${max}`,
  noteLabel: "Your note for Agents",
  receive: "What Agents receive now",
  nothing: "Nothing: Agents follow the general rule.",
  receiveHelp:
    "Agents that write this Workspace's Home get it with the next Brief they read or result they publish, including sessions already running. It never replaces exact figures, hides limits or risks, or changes what an Agent may do.",
  restore: "Restore default",
  restoreLabel: "Restore the Home default",
  restoreAsk: "Restore the default? What you changed here and haven't saved is discarded.",
  keepEditing: "Keep editing",
  saving: "Saving…",
  save: "Save Home preference",
  loading: "Loading…",
}, {
  section: "Home 展示设置",
  title: "Home",
  intro: "Agent 在 Home 上如何展示结果。保存在此 Workspace 中，因此打开它的每台设备都使用同一选择。",
  inUse: "当前使用",
  visual: "视觉优先",
  standard: "默认",
  withNote: " · 附你的备注",
  presentation: "展示方式",
  visualHelp: "在适合的地方先放图表、截图或草图，较长的说明放在其后。",
  standardHelp: "形式随信息而定：布局用图，数字用图表，单一状态用一句话。",
  presentationLabel: "Home 展示方式",
  note: "你的备注（可选）",
  noteHelp: (count, max) => `用你自己的话补充这项偏好。${count}/${max}`,
  noteLabel: "你给 Agent 的备注",
  receive: "Agent 现在收到的内容（按原文显示）",
  nothing: "无：Agent 遵循通用规则。",
  receiveHelp:
    "为此 Workspace 的 Home 撰写内容的 Agent，会在下一次读取 Brief 或发布结果时收到它，包括已在运行的会话。它从不替代确切数字、隐藏限制或风险，也不改变 Agent 可以做的事。",
  restore: "恢复默认",
  restoreLabel: "恢复 Home 默认设置",
  restoreAsk: "恢复默认？你在这里做了但尚未保存的更改将被丢弃。",
  keepEditing: "继续编辑",
  saving: "正在保存…",
  save: "保存 Home 偏好",
  loading: "正在加载…",
});

/**
 * Home, one category of Settings (T-175): how the user prefers Agents to
 * present results on Home. Core keeps it for this Workspace; Agents that may
 * write Home receive it beside their Home advice, and no Agent tool sets it.
 */
export function HomePresentationSettings({ active }: { active: boolean }) {
  const t = useStrings(text);
  const [saved, setSaved] = useState<Presentation | null>(null);
  const [style, setStyle] = useState<Style>("default");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Restore default with unsaved changes asks first, in a confirmation that
  // opens below the actions and takes focus; after a restore the
  // presentation's select has it, as the actions row goes (T-19 ST:SX-65).
  const [confirming, setConfirming] = useState(false);
  const revealBox = useRef<HTMLDivElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const restored = useRef(false);
  useRevealIn(revealBox, confirming || null);
  useLayoutEffect(() => {
    if (confirming) confirmBox.current?.focus({ preventScroll: true });
  }, [confirming]);
  useLayoutEffect(() => {
    if (restored.current && !saving) {
      restored.current = false;
      select.current?.focus();
    }
  }, [saving]);
  const adopt = (value: Presentation) => {
    setSaved(value);
    setStyle(value.style);
    setNote(value.note);
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    void api<Presentation>("/home/presentation", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) adopt(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [active]);
  async function save(next: { style: Style; note: string }): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    setError("");
    try {
      adopt(await api<Presentation>("/home/presentation", { method: "PUT", body: JSON.stringify(next) }));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  }
  const changed = !!saved && (style !== saved.style || collapsed(note) !== saved.note);
  // On Settings › Home the change joins the page's save bar (YN-8); Restore
  // the default stays a command here. Mounted alone it keeps its own Save.
  const inBar = useSaveBarPart("home-presentation", changed && saved ? {
    save: () => save({ style, note }),
    discard: () => { setError(""); setStyle(saved.style); setNote(saved.note); },
  } : null);
  const isDefault = !!saved && saved.style === "default" && !saved.note;
  function restore() {
    setConfirming(false);
    restored.current = true;
    void save({ style: "default", note: "" });
  }
  return (
    <section id="settings-home" className="settings-section home-presentation-settings" aria-label={t.section}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        {saved && (
          <span className="settings-current" title={t.inUse}>
            {saved.style === "visual" ? t.visual : t.standard}
            {saved.note ? t.withNote : ""}
          </span>
        )}
      </header>
      {saved && (
        <div className="settings-group">
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.presentation}</span>
              <span className="settings-row-help">{style === "visual" ? t.visualHelp : t.standardHelp}</span>
            </span>
            <select
              ref={select}
              className="settings-select"
              aria-label={t.presentationLabel}
              value={style}
              disabled={saving}
              onChange={(e) => setStyle(e.target.value as Style)}
            >
              <option value="default">{t.standard}</option>
              <option value="visual">{t.visual}</option>
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.note}</span>
              <span className="settings-row-help">{t.noteHelp(collapsed(note).length, MAX_NOTE)}</span>
              <textarea
                className="settings-textarea"
                aria-label={t.noteLabel}
                rows={2}
                maxLength={MAX_NOTE}
                value={note}
                disabled={saving}
                onChange={(e) => setNote(e.target.value)}
              />
            </span>
          </label>
          <div className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.receive}</span>
              <span className="settings-row-help home-presentation-text">{saved.agentText ?? t.nothing}</span>
              <span className="settings-row-help">{t.receiveHelp}</span>
            </span>
          </div>
          {(!isDefault || (!inBar && (changed || saving))) && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                {!isDefault && (
                  <button
                    ref={restoreButton}
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() => (changed ? setConfirming(true) : restore())}
                  >
                    {t.restore}
                  </button>
                )}
                {!inBar && (changed || saving) && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={saving || !changed}
                    onClick={() => void save({ style, note })}
                  >
                    {saving ? t.saving : t.save}
                  </button>
                )}
              </div>
            </div>
          )}
          {confirming && (
            <div className="reveal" ref={revealBox}>
              <div className="settings-confirm" role="group" aria-label={t.restoreLabel} ref={confirmBox} tabIndex={-1}>
                <p>{t.restoreAsk}</p>
                <span className="settings-confirm-actions">
                  <button type="button" className="secondary-button" disabled={saving} onClick={restore}>
                    {t.restore}
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      setConfirming(false);
                      restoreButton.current?.focus();
                    }}
                  >
                    {t.keepEditing}
                  </button>
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {!saved && !error && (
        <p className="settings-row-help" role="status">
          {t.loading}
        </p>
      )}
      {error && (
        <p className="updates-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

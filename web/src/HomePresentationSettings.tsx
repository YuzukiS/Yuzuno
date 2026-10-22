import { useEffect, useState } from "react";
import { api, errorText } from "./api";

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

/**
 * Home, one category of Settings (T-175): how the user prefers Agents to
 * present results on Home. Core keeps it for this Workspace; Agents that may
 * write Home receive it beside their Home advice, and no Agent tool sets it.
 */
export function HomePresentationSettings({ active }: { active: boolean }) {
  const [saved, setSaved] = useState<Presentation | null>(null);
  const [style, setStyle] = useState<Style>("default");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
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
  async function save(next: { style: Style; note: string }) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      adopt(await api<Presentation>("/home/presentation", { method: "PUT", body: JSON.stringify(next) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const changed = !!saved && (style !== saved.style || collapsed(note) !== saved.note);
  const isDefault = !!saved && saved.style === "default" && !saved.note;
  return (
    <section id="settings-home" className="settings-section home-presentation-settings" aria-label="Home presentation settings">
      <header className="settings-section-heading">
        <div>
          <h3>Home</h3>
          <p>
            How Agents present results on Home. Saved in this Workspace, so every device that opens it uses the same
            choice.
          </p>
        </div>
        {saved && (
          <span className="settings-current" title="In use now">
            {saved.style === "visual" ? "Visual first" : "Default"}
            {saved.note ? " · with your note" : ""}
          </span>
        )}
      </header>
      {saved && (
        <div className="settings-group">
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Presentation</span>
              <span className="settings-row-help">
                {style === "visual"
                  ? "A chart, screenshot or sketch first where the information suits it; long explanations after it."
                  : "The form follows the information: a picture for a layout, a chart for numbers, a sentence for a single state."}
              </span>
            </span>
            <select
              className="settings-select"
              aria-label="Home presentation"
              value={style}
              disabled={saving}
              onChange={(e) => setStyle(e.target.value as Style)}
            >
              <option value="default">Default</option>
              <option value="visual">Visual first</option>
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Your note (optional)</span>
              <span className="settings-row-help">
                In your own words, added to the preference. {collapsed(note).length}/{MAX_NOTE}
              </span>
              <textarea
                className="settings-textarea"
                aria-label="Your note for Agents"
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
              <span className="settings-row-title">What Agents receive now</span>
              <span className="settings-row-help home-presentation-text">
                {saved.agentText ?? "Nothing: Agents follow the general rule."}
              </span>
              <span className="settings-row-help">
                Agents that write this Workspace's Home get it with the next Brief they read or result they publish,
                including sessions already running. It never replaces exact figures, hides limits or risks, or changes
                what an Agent may do.
              </span>
            </span>
          </div>
          {(changed || saving || !isDefault) && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                {!isDefault && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() => void save({ style: "default", note: "" })}
                  >
                    Restore default
                  </button>
                )}
                {(changed || saving) && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={saving || !changed}
                    onClick={() => void save({ style, note })}
                  >
                    {saving ? "Saving…" : "Save Home preference"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {!saved && !error && (
        <p className="settings-row-help" role="status">
          Loading…
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

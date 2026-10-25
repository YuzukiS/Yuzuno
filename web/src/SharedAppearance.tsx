import { useEffect, useRef, useState } from "react";
import { errorText, NetworkError } from "./api";
import { importAppearance, useAppearance } from "./appearance";
import { appearanceFields, fieldValue, importedAppearance, type AppearanceField } from "./appearance-file";
import { fetchPreset, savePreset, type PresetRead } from "./appearance-preset";
import { AppearanceChoices } from "./AppearanceSettings";
import "./appearance.css";

const via = { local: " through Core’s own address", remote: " through the remote entry" };
const short = (workspaceId: string) => workspaceId.slice(0, 8);
const when = (at: string | null) => (at ? `, saved ${new Date(at).toLocaleString()}` : "");

/**
 * The Workspace's shared Appearance preset (T-194), beside this device's own
 * Appearance. It is read when this editor opens and dropped when it closes;
 * nothing is saved to the Workspace or applied here unless the user presses
 * it, and nothing follows along afterwards. Applying asks Core again first,
 * so a preset read before a disconnect, or from another Workspace, or since
 * replaced, is never applied: it must be read and previewed again.
 */
export function SharedAppearanceSection({ active }: { active: boolean }) {
  const appearance = useAppearance();
  const [read, setRead] = useState<PresetRead | null>(null);
  const [reading, setReading] = useState<"reading" | { error: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [chosen, setChosen] = useState<AppearanceField[]>([]);
  const [busy, setBusy] = useState<"save" | "apply" | null>(null);
  const [said, setSaid] = useState<{ error: boolean; text: string; n: number } | null>(null);
  // An answer to a read or save from before the editor closed is not used.
  const generation = useRef(0);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said?.error) line.current?.scrollIntoView?.({ block: "nearest" });
  }, [said]);
  const say = (error: boolean, text: string) => setSaid((old) => ({ error, text, n: (old?.n ?? 0) + 1 }));
  const forget = () => {
    setRead(null);
    setPreview(false);
  };

  function load() {
    const n = ++generation.current;
    setReading("reading");
    setPreview(false);
    fetchPreset().then(
      (next) => {
        if (n !== generation.current) return;
        setRead(next);
        setReading(null);
      },
      (error) => {
        if (n !== generation.current) return;
        setRead(null);
        setReading({ error: errorText(error) });
      },
    );
  }
  useEffect(() => {
    if (active) {
      setSaid(null);
      load();
      return;
    }
    generation.current++;
    forget();
    setReading(null);
    setBusy(null);
    setSaid(null);
  }, [active]);

  const contents = read?.kind === "preset" ? read.contents : null;
  const differs = (field: AppearanceField) => {
    const value = contents?.values[field];
    return value !== undefined && value !== fieldValue(appearance, field);
  };
  const selected = contents ? chosen.filter(differs) : [];

  async function save() {
    if (!read || busy) return;
    const n = generation.current;
    setBusy("save");
    setSaid(null);
    try {
      const outcome = await savePreset(read, appearance);
      if (n !== generation.current) return;
      if ("conflict" in outcome) {
        forget();
        say(
          true,
          outcome.conflict === "preset_changed"
            ? "Not saved: another device changed the shared preset after this one read it. Nothing was changed. Read it again to see that preset before saving over it."
            : "Not saved: this page read the preset from another Workspace than the one it is connected to now. Nothing was changed. Read it again.",
        );
        return;
      }
      setRead(outcome);
      setPreview(false);
      say(false, `Saved this device’s Appearance as this Workspace’s shared preset (revision ${outcome.revision}).`);
    } catch (error) {
      if (n !== generation.current) return;
      if (error instanceof NetworkError) {
        forget();
        say(true, "No answer from Core, so this device doesn’t know whether the preset was saved. Nothing is retried; read it again to see.");
      } else say(true, `Not saved: ${errorText(error)}. Nothing was changed.`);
    } finally {
      if (n === generation.current) setBusy(null);
    }
  }

  async function apply() {
    if (!read || read.kind !== "preset" || busy || !selected.length) return;
    const n = generation.current;
    const fields = selected;
    setBusy("apply");
    setSaid(null);
    let now: PresetRead;
    try {
      now = await fetchPreset();
    } catch (error) {
      if (n !== generation.current) return;
      setBusy(null);
      forget();
      say(true, `Not applied: this Workspace’s Core couldn’t confirm the preset (${errorText(error)}). Nothing changed on this device. Read it again once connected.`);
      return;
    }
    if (n !== generation.current) return;
    setBusy(null);
    if (now.workspaceId !== read.workspaceId) {
      forget();
      say(true, "Not applied: this page is now connected to another Workspace, whose preset this isn’t. Nothing changed on this device. Read it again.");
      return;
    }
    if (now.revision !== read.revision) {
      setRead(now);
      setPreview(false);
      say(true, "Not applied: the shared preset changed after you previewed it. Nothing changed on this device. Preview it again.");
      return;
    }
    const outcome = importAppearance(importedAppearance(appearance, read.contents, fields));
    if (!outcome.saved) {
      say(true, `Not applied: ${outcome.detail}. Nothing was changed; your Appearance stays as it is.`);
      return;
    }
    setPreview(false);
    say(false, `Applied ${fields.length} ${fields.length === 1 ? "setting" : "settings"} from the shared preset; saved on this device.`);
  }

  let status: string;
  if (reading === "reading") status = "Reading this Workspace’s shared preset…";
  else if (reading) status = `Couldn’t read this Workspace’s shared preset: ${reading.error}. Nothing here changed.`;
  else if (!read) status = "Not read. Read it again to see this Workspace’s shared preset.";
  else if (read.kind === "none") status = `Workspace ${short(read.workspaceId)}: no preset shared yet.`;
  else if (read.kind === "refused")
    status = `Workspace ${short(read.workspaceId)}: the shared preset (revision ${read.revision}) can’t be applied here: ${read.reason}.`;
  else
    status = `Workspace ${short(read.workspaceId)}: shared preset revision ${read.revision}${when(read.savedAt)}${read.savedVia ? via[read.savedVia] : ""}.`;

  return (
    <section
      id="settings-appearance-preset"
      className="settings-section appearance-preset"
      aria-labelledby="settings-appearance-preset-title"
    >
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-appearance-preset-title">Shared Appearance preset</h3>
          <p>
            One Appearance preset this Workspace’s Core keeps for the devices you use with it. Saving puts this device’s
            Appearance there; another device previews it beside its own and applies the settings you pick, on itself.
            Nothing is saved or applied until you press it, and nothing follows along afterwards: it is a shared preset,
            not sync. Only Appearance is in it, never how messages are sent, time display, language, accounts,
            permissions or folders.
          </p>
        </div>
      </header>
      <div className="settings-group appearance-file" aria-label="Shared preset">
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">In this Workspace</span>
            <span className="settings-row-help appearance-preset-status">
              {status}
            </span>
          </span>
          <span className="settings-row-action appearance-file-buttons">
            <button type="button" disabled={!read || !!busy} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : read?.kind === "none" ? "Save this device’s Appearance here" : "Replace it with this device’s Appearance"}
            </button>
            <button
              type="button"
              disabled={!contents || !!busy || preview}
              onClick={() => {
                setSaid(null);
                setChosen(appearanceFields.filter(differs));
                setPreview(true);
              }}
            >
              Preview…
            </button>
            <button
              type="button"
              disabled={reading === "reading" || !!busy}
              onClick={() => {
                setSaid(null);
                load();
              }}
            >
              Read again
            </button>
          </span>
        </div>
        {preview && read?.kind === "preset" && (
          <div className="appearance-file-preview" role="group" aria-label="Shared preset preview">
            <p>
              Revision {read.revision}
              {when(read.savedAt)}. Ticked settings are taken from the shared preset and saved on this device only; the
              others stay as they are.
            </p>
            <AppearanceChoices appearance={appearance} contents={read.contents} chosen={chosen} onChosen={setChosen} from="Shared" />
            {read.contents.unknown.length > 0 && (
              <p className="settings-row-help">
                Not Appearance settings this version knows, so left out: {read.contents.unknown.join(", ")}
              </p>
            )}
            <div className="appearance-file-buttons">
              <button type="button" disabled={!selected.length || !!busy} onClick={() => void apply()}>
                {busy === "apply" ? "Applying…" : selected.length ? `Apply ${selected.length} selected` : "Nothing to apply"}
              </button>
              <button type="button" disabled={!!busy} onClick={() => setPreview(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {said && (
          <p
            ref={line}
            className={said.error ? "appearance-file-error" : "appearance-file-done"}
            role={said.error ? "alert" : "status"}
          >
            {said.text}
          </p>
        )}
      </div>
    </section>
  );
}

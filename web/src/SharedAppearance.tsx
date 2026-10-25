import { useEffect, useRef, useState } from "react";
import { errorText, NetworkError } from "./api";
import { importAppearance, useAppearance, type Appearance } from "./appearance";
import {
  appearanceFields,
  fieldValue,
  importedAppearance,
  type AppearanceField,
  type AppearanceFileContents,
} from "./appearance-file";
import { catchUp, startFollowing, stopFollowing, useFollow } from "./appearance-follow";
import { fetchPreset, savePreset, type PresetRead } from "./appearance-preset";
import { fieldLabels, fieldText } from "./AppearanceSettings";
import "./appearance.css";

const via = { local: " through Core’s own address", remote: " through the remote entry" };
const short = (workspaceId: string) => workspaceId.slice(0, 8);
const when = (at: string | null) => (at ? `, saved ${new Date(at).toLocaleString()}` : "");

/** Each setting the preset holds beside the one in effect, ticked in
 * `chosen` where they differ, as the Appearance file's import shows a file;
 * `fixed` when all of them are taken, as following takes them. */
function PresetChoices({
  appearance,
  contents,
  chosen,
  onChosen,
  fixed = false,
}: {
  appearance: Appearance;
  contents: AppearanceFileContents;
  chosen: readonly AppearanceField[];
  onChosen: (update: (old: AppearanceField[]) => AppearanceField[]) => void;
  fixed?: boolean;
}) {
  return (
    <ul>
      {appearanceFields.map((field) => {
        const value = contents.values[field];
        const bad = contents.invalid.find((item) => item.field === field);
        if (value === undefined && !bad) return null;
        const now = fieldText(field, fieldValue(appearance, field));
        if (value === undefined)
          return (
            <li key={field} data-state="invalid">
              <span className="appearance-file-name">{fieldLabels[field]}</span>
              <span>Now: {now}</span>
              <span>Shared: {bad!.value}, not a value Yuzuno accepts; kept as now</span>
            </li>
          );
        const same = value === fieldValue(appearance, field);
        if (fixed)
          return (
            <li key={field} data-state={same ? "same" : "differs"}>
              <span className="appearance-file-name">{fieldLabels[field]}</span>
              <span>Now: {now}</span>
              <span>{same ? "Shared: the same" : `Shared: ${fieldText(field, value)}`}</span>
            </li>
          );
        return (
          <li key={field} data-state={same ? "same" : "differs"}>
            <label className="appearance-file-name">
              <input
                type="checkbox"
                disabled={same}
                checked={!same && chosen.includes(field)}
                onChange={(event) =>
                  onChosen((old) => (event.target.checked ? [...old, field] : old.filter((f) => f !== field)))
                }
              />
              {fieldLabels[field]}
            </label>
            <span>Now: {now}</span>
            <span>{same ? "Shared: the same" : `Shared: ${fieldText(field, value)}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Workspace's shared Appearance preset (T-194), beside this device's own
 * Appearance. It is read when this editor opens and dropped when it closes;
 * nothing is saved to the Workspace or applied here unless the user presses
 * it, and nothing follows along afterwards. Applying asks Core again first,
 * so a preset read before a disconnect, or from another Workspace, or since
 * replaced, is never applied: it must be read and previewed again. Here too
 * this device can follow the preset, one way, once the user turns that on
 * after a preview (appearance-follow.ts), and stop following.
 */
export function SharedAppearanceSection({ active }: { active: boolean }) {
  const appearance = useAppearance();
  const [read, setRead] = useState<PresetRead | null>(null);
  // Opened active, it is reading from the start, never "not read" first.
  const [reading, setReading] = useState<"reading" | { error: string } | null>(active ? "reading" : null);
  // Picking settings to apply once, or seeing what following takes.
  const [preview, setPreview] = useState<false | "apply" | "follow">(false);
  const [chosen, setChosen] = useState<AppearanceField[]>([]);
  const [busy, setBusy] = useState<"save" | "apply" | "follow" | null>(null);
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

  /** Asks Core again whether the preset previewed is still this Workspace's,
   * at that revision; says why not otherwise. */
  async function confirmed(target: PresetRead, n: number, what: string): Promise<boolean> {
    let now: PresetRead;
    try {
      now = await fetchPreset();
    } catch (error) {
      if (n !== generation.current) return false;
      forget();
      say(true, `Not ${what}: this Workspace’s Core couldn’t confirm the preset (${errorText(error)}). Nothing changed on this device. Read it again once connected.`);
      return false;
    }
    if (n !== generation.current) return false;
    if (now.workspaceId !== target.workspaceId) {
      forget();
      say(true, `Not ${what}: this page is now connected to another Workspace, whose preset this isn’t. Nothing changed on this device. Read it again.`);
      return false;
    }
    if (now.revision !== target.revision) {
      setRead(now);
      setPreview(false);
      say(true, `Not ${what}: the shared preset changed after you previewed it. Nothing changed on this device. Preview it again.`);
      return false;
    }
    return true;
  }

  async function apply() {
    if (!read || read.kind !== "preset" || busy || !selected.length) return;
    const n = generation.current;
    const fields = selected;
    setBusy("apply");
    setSaid(null);
    const ok = await confirmed(read, n, "applied");
    if (n !== generation.current) return;
    setBusy(null);
    if (!ok) return;
    const outcome = importAppearance(importedAppearance(appearance, read.contents, fields));
    if (!outcome.saved) {
      say(true, `Not applied: ${outcome.detail}. Nothing was changed; your Appearance stays as it is.`);
      return;
    }
    setPreview(false);
    say(false, `Applied ${fields.length} ${fields.length === 1 ? "setting" : "settings"} from the shared preset; saved on this device.`);
  }

  /** Applies all the preset holds, as following does, and only once that is
   * saved here turns following on, at this revision. */
  async function follow() {
    if (!read || read.kind !== "preset" || busy) return;
    const n = generation.current;
    setBusy("follow");
    setSaid(null);
    const ok = await confirmed(read, n, "following");
    if (n !== generation.current) return;
    setBusy(null);
    if (!ok) return;
    const fields = appearanceFields.filter((field) => read.contents.values[field] !== undefined);
    const outcome = importAppearance(importedAppearance(appearance, read.contents, fields), { followed: true });
    if (!outcome.saved) {
      say(true, `Not following: ${outcome.detail}. Nothing was changed; your Appearance stays as it is.`);
      return;
    }
    const kept = startFollowing(read.workspaceId, read.revision);
    setPreview(false);
    if (!kept.saved) {
      say(true, `Revision ${read.revision} is applied and saved on this device, but this device couldn’t save that it follows the preset (${kept.detail}), so it doesn’t follow it.`);
      return;
    }
    say(false, `This device now follows this Workspace’s shared preset: revision ${read.revision} is applied and saved here, and a newer one will be once it is saved.`);
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

  const following = useFollow(read?.workspaceId ?? null);
  const changes = contents ? appearanceFields.filter(differs).length : 0;
  let device: string | null = null;
  if (read && following.revision !== null) {
    const c = following.condition;
    if (c?.kind === "offline")
      device = `Follows this Workspace’s shared preset (revision ${following.revision} applied), but isn’t connected to Core now: the Appearance in effect stays, and the latest preset is read once connected.`;
    else if (c?.kind === "paused") device = `Following is paused: ${c.reason}. The Appearance in effect stays.`;
    else {
      const applied = c?.kind === "following" && c.appliedAt ? `, applied ${new Date(c.appliedAt).toLocaleString()}` : "";
      const note = c?.kind === "following" && c.note ? ` Note: ${c.note}.` : "";
      device = `Follows this Workspace’s shared preset: revision ${following.revision}${applied}. A newer revision is applied once it is saved; changing Appearance here stops following.${note}`;
    }
  } else if (read) device = "Uses its own Appearance; it doesn’t follow this Workspace’s preset.";
  const stop = following.stop;
  const stopText = stop
    ? `${stop.why === "edited" ? "Stopped following this Workspace’s shared preset: Appearance was changed on this device, and stays as set here." : "Stopped following. This device keeps the Appearance in effect; nothing changed on Core."}${stop.unsaved ? ` This device couldn’t save that it stopped (${stop.unsaved}), so it stops for this visit only.` : ""}`
    : null;

  return (
    <section
      id="settings-appearance-preset"
      className="settings-section appearance-preset"
      aria-labelledby="settings-appearance-preset-title"
      lang="en"
    >
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-appearance-preset-title">Shared Appearance preset</h3>
          <p>
            One Appearance preset this Workspace’s Core keeps for the devices you use with it. Saving puts this device’s
            Appearance there; another device previews it beside its own and applies the settings you pick, on itself.
            Nothing is saved or applied until you press it. A device can also follow the preset, one way, once you turn
            that on: it then applies each newer revision by itself, until Appearance is changed there or following is
            stopped. It is not two-way sync: following never sends a device’s Appearance anywhere. Only Appearance is
            in it, never how messages are sent, time display, language, accounts, permissions or folders.
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
              disabled={!contents || !!busy || !!preview}
              onClick={() => {
                setSaid(null);
                setChosen(appearanceFields.filter(differs));
                setPreview("apply");
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
        {device && (
          <div className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">On this device</span>
              <span className="settings-row-help appearance-follow-status">{device}</span>
            </span>
            <span className="settings-row-action appearance-file-buttons">
              {following.revision === null ? (
                <button type="button" disabled={!contents || !!busy || !!preview} onClick={() => { setSaid(null); setPreview("follow"); }}>
                  Follow this preset…
                </button>
              ) : (
                <>
                  {(following.condition?.kind === "paused" || following.condition?.kind === "offline") && (
                    <button type="button" onClick={() => void catchUp(read!.workspaceId)}>
                      Try again
                    </button>
                  )}
                  <button type="button" onClick={() => stopFollowing(read!.workspaceId, "chosen")}>
                    Stop following
                  </button>
                </>
              )}
            </span>
          </div>
        )}
        {stopText && (
          <p className="appearance-file-done" role="status">
            {stopText}
          </p>
        )}
        {preview === "follow" && read?.kind === "preset" && (
          <div className="appearance-file-preview" role="group" aria-label="Follow preview">
            <p>
              Revision {read.revision}
              {when(read.savedAt)}. Following applies all of these on this device now and saves them here, then each
              newer revision of this Workspace’s preset once it is saved, while Yuzuno is open here. Changing Appearance
              on this device stops following. Following never sends this device’s Appearance anywhere.
            </p>
            <PresetChoices appearance={appearance} contents={read.contents} chosen={[]} onChosen={() => {}} fixed />
            {read.contents.unknown.length > 0 && (
              <p className="settings-row-help">
                Not Appearance settings this version knows, so left out: {read.contents.unknown.join(", ")}
              </p>
            )}
            <div className="appearance-file-buttons">
              <button type="button" disabled={!!busy} onClick={() => void follow()}>
                {busy === "follow"
                  ? "Following…"
                  : changes
                    ? `Follow and apply ${changes} ${changes === 1 ? "change" : "changes"}`
                    : "Follow (nothing changes now)"}
              </button>
              <button type="button" disabled={!!busy} onClick={() => setPreview(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {preview === "apply" && read?.kind === "preset" && (
          <div className="appearance-file-preview" role="group" aria-label="Shared preset preview">
            <p>
              Revision {read.revision}
              {when(read.savedAt)}. Ticked settings are taken from the shared preset and saved on this device only; the
              others stay as they are.
            </p>
            <PresetChoices appearance={appearance} contents={read.contents} chosen={chosen} onChosen={setChosen} />
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

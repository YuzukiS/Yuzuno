import { useEffect, useRef, useState } from "react";
import { NetworkError } from "./api";
import { importAppearance, useAppearance, type Appearance } from "./appearance";
import {
  appearanceFields,
  fieldValue,
  importedAppearance,
  type AppearanceField,
  type AppearanceFileContents,
} from "./appearance-file";
import { catchUp, noteText, pauseText, startFollowing, stopFollowing, useFollow } from "./appearance-follow";
import { fetchPreset, presetErrorText, refusedText, savePreset, type PresetRead } from "./appearance-preset";
import { fieldLabel, fieldText } from "./AppearanceSettings";
import type { SaveOutcome } from "./device-storage";
import { langTag, strings, useLanguage, type Language } from "./i18n";
import { saveRefusalReason } from "./SaveStatus";
import "./appearance.css";

const short = (workspaceId: string) => workspaceId.slice(0, 8);
type Refused = Extract<SaveOutcome, { saved: false }>;
type What = "applied" | "following";
/** What the last action said, kept as what happened and worded when shown
 * (T-189). Core's and the browser's own words are kept as they came. */
type Said =
  | { kind: "conflict"; conflict: "preset_changed" | "other_workspace" }
  | { kind: "saved"; revision: number }
  | { kind: "noAnswer" }
  | { kind: "notSaved"; error: unknown }
  | { kind: "unconfirmed"; what: What; error: unknown }
  | { kind: "otherWorkspace"; what: What }
  | { kind: "changed"; what: What }
  | { kind: "notApplied"; what: What; refused: Refused }
  | { kind: "applied"; count: number }
  | { kind: "followUnsaved"; revision: number; refused: Refused }
  | { kind: "following"; revision: number };

// The section's own words (T-189). Workspace IDs, revisions, times, the
// preset's values and names, and what Core or the browser said are shown as
// they are.
const text = strings({
  now: (value: string) => `Now: ${value}`,
  sharedBad: (value: string) => `Shared: ${value}, not a value Yuzuno accepts; kept as now`,
  sharedSame: "Shared: the same",
  shared: (value: string) => `Shared: ${value}`,
  conflictChanged:
    "Not saved: another device changed the shared preset after this one read it. Nothing was changed. Read it again to see that preset before saving over it.",
  conflictOther:
    "Not saved: this page read the preset from another Workspace than the one it is connected to now. Nothing was changed. Read it again.",
  saved: (revision: number) => `Saved this device’s Appearance as this Workspace’s shared preset (revision ${revision}).`,
  noAnswer: "No answer from Core, so this device doesn’t know whether the preset was saved. Nothing is retried; read it again to see.",
  notSaved: (error: string) => `Not saved: ${error}. Nothing was changed.`,
  what: { applied: "applied", following: "following" } as Record<What, string>,
  unconfirmed: (what: string, error: string) =>
    `Not ${what}: this Workspace’s Core couldn’t confirm the preset (${error}). Nothing changed on this device. Read it again once connected.`,
  otherWorkspace: (what: string) =>
    `Not ${what}: this page is now connected to another Workspace, whose preset this isn’t. Nothing changed on this device. Read it again.`,
  changed: (what: string) => `Not ${what}: the shared preset changed after you previewed it. Nothing changed on this device. Preview it again.`,
  notApplied: (what: string, why: string) => `Not ${what}: ${why}. Nothing was changed; your Appearance stays as it is.`,
  applied: (count: number) => `Applied ${count} ${count === 1 ? "setting" : "settings"} from the shared preset; saved on this device.`,
  followUnsaved: (revision: number, why: string) =>
    `Revision ${revision} is applied and saved on this device, but this device couldn’t save that it follows the preset (${why}), so it doesn’t follow it.`,
  following: (revision: number) =>
    `This device now follows this Workspace’s shared preset: revision ${revision} is applied and saved here, and a newer one will be once it is saved.`,
  reading: "Reading this Workspace’s shared preset…",
  couldNotRead: (error: string) => `Couldn’t read this Workspace’s shared preset: ${error}. Nothing here changed.`,
  notRead: "Not read. Read it again to see this Workspace’s shared preset.",
  none: (workspace: string) => `Workspace ${workspace}: no preset shared yet.`,
  refused: (workspace: string, revision: number, why: string) =>
    `Workspace ${workspace}: the shared preset (revision ${revision}) can’t be applied here: ${why}.`,
  savedAt: (at: string) => `, saved ${at}`,
  via: { local: " through Core’s own address", remote: " through the remote entry" } as Record<"local" | "remote", string>,
  preset: (workspace: string, revision: number, saved: string, via: string) => `Workspace ${workspace}: shared preset revision ${revision}${saved}${via}.`,
  offline: (revision: number) =>
    `Follows this Workspace’s shared preset (revision ${revision} applied), but isn’t connected to Core now: the Appearance in effect stays, and the latest preset is read once connected.`,
  paused: (why: string) => `Following is paused: ${why}. The Appearance in effect stays.`,
  appliedAt: (at: string) => `, applied ${at}`,
  note: (note: string) => ` Note: ${note}.`,
  follows: (revision: number, applied: string, note: string) =>
    `Follows this Workspace’s shared preset: revision ${revision}${applied}. A newer revision is applied once it is saved; changing Appearance here stops following.${note}`,
  ownAppearance: "Uses its own Appearance; it doesn’t follow this Workspace’s preset.",
  stoppedEdited: "Stopped following this Workspace’s shared preset: Appearance was changed on this device, and stays as set here.",
  stoppedChosen: "Stopped following. This device keeps the Appearance in effect; nothing changed on Core.",
  stopUnsaved: (why: string) => ` This device couldn’t save that it stopped (${why}), so it stops for this visit only.`,
  title: "Shared Appearance preset",
  intro:
    "One Appearance preset this Workspace’s Core keeps for the devices you use with it. Saving puts this device’s Appearance there; another device previews it beside its own and applies the settings you pick, on itself. Nothing is saved or applied until you press it. A device can also follow the preset, one way, once you turn that on: it then applies each newer revision by itself, until Appearance is changed there or following is stopped. It is not two-way sync: following never sends a device’s Appearance anywhere. Only Appearance is in it, never how messages are sent, time display, language, accounts, permissions or folders.",
  sharedPreset: "Shared preset",
  inWorkspace: "In this Workspace",
  saving: "Saving…",
  saveHere: "Save this device’s Appearance here",
  replace: "Replace it with this device’s Appearance",
  preview: "Preview…",
  readAgain: "Read again",
  onDevice: "On this device",
  followPreset: "Follow this preset…",
  tryAgain: "Try again",
  stopFollowing: "Stop following",
  followPreview: "Follow preview",
  followPreviewText: (revision: number, saved: string) =>
    `Revision ${revision}${saved}. Following applies all of these on this device now and saves them here, then each newer revision of this Workspace’s preset once it is saved, while Yuzuno is open here. Changing Appearance on this device stops following. Following never sends this device’s Appearance anywhere.`,
  leftOut: (names: string) => `Not Appearance settings this version knows, so left out: ${names}`,
  followingBusy: "Following…",
  followApply: (n: number) => `Follow and apply ${n} ${n === 1 ? "change" : "changes"}`,
  followNothing: "Follow (nothing changes now)",
  cancel: "Cancel",
  presetPreview: "Shared preset preview",
  applyPreviewText: (revision: number, saved: string) =>
    `Revision ${revision}${saved}. Ticked settings are taken from the shared preset and saved on this device only; the others stay as they are.`,
  applying: "Applying…",
  applySelected: (n: number) => `Apply ${n} selected`,
  nothingToApply: "Nothing to apply",
}, {
  now: (value) => `当前：${value}`,
  sharedBad: (value) => `共享：${value}，不是 Yuzuno 接受的值；保持当前`,
  sharedSame: "共享：相同",
  shared: (value) => `共享：${value}`,
  conflictChanged: "未保存：此设备读取之后，另一台设备更改了共享预设。没有任何更改。请重新读取，先查看那个预设再覆盖保存。",
  conflictOther: "未保存：此页面读取的预设来自另一个 Workspace，而不是现在连接的这个。没有任何更改。请重新读取。",
  saved: (revision) => `已将此设备的外观保存为此 Workspace 的共享预设（修订 ${revision}）。`,
  noAnswer: "Core 没有回答，因此此设备不知道预设是否已保存。不会自动重试；请重新读取查看。",
  notSaved: (error) => `未保存：${error}。没有任何更改。`,
  what: { applied: "未应用", following: "未跟随" },
  unconfirmed: (what, error) => `${what}：此 Workspace 的 Core 无法确认预设（${error}）。此设备上没有任何变化。连接后请重新读取。`,
  otherWorkspace: (what) => `${what}：此页面现在连接的是另一个 Workspace，这不是它的预设。此设备上没有任何变化。请重新读取。`,
  changed: (what) => `${what}：你预览之后共享预设发生了变化。此设备上没有任何变化。请重新预览。`,
  notApplied: (what, why) => `${what}：${why}。没有任何更改；你的外观保持不变。`,
  applied: (count) => `已从共享预设应用 ${count} 项设置；已保存在此设备上。`,
  followUnsaved: (revision, why) => `修订 ${revision} 已应用并保存在此设备上，但此设备无法保存“正在跟随预设”（${why}），因此它不会跟随。`,
  following: (revision) => `此设备现在跟随此 Workspace 的共享预设：修订 ${revision} 已应用并保存在这里，更新的修订保存后也会应用。`,
  reading: "正在读取此 Workspace 的共享预设…",
  couldNotRead: (error) => `无法读取此 Workspace 的共享预设：${error}。这里没有任何变化。`,
  notRead: "未读取。请重新读取以查看此 Workspace 的共享预设。",
  none: (workspace) => `Workspace ${workspace}：尚未共享预设。`,
  refused: (workspace, revision, why) => `Workspace ${workspace}：共享预设（修订 ${revision}）无法在这里应用：${why}。`,
  savedAt: (at) => `，保存于 ${at}`,
  via: { local: "，经由 Core 自己的地址", remote: "，经由远程入口" },
  preset: (workspace, revision, saved, via) => `Workspace ${workspace}：共享预设修订 ${revision}${saved}${via}。`,
  offline: (revision) => `跟随此 Workspace 的共享预设（已应用修订 ${revision}），但现在没有连接到 Core：当前外观保持不变，连接后会读取最新的预设。`,
  paused: (why) => `跟随已暂停：${why}。当前外观保持不变。`,
  appliedAt: (at) => `，应用于 ${at}`,
  note: (note) => `注意：${note}。`,
  follows: (revision, applied, note) => `跟随此 Workspace 的共享预设：修订 ${revision}${applied}。更新的修订保存后会应用；在这里更改外观会停止跟随。${note}`,
  ownAppearance: "使用自己的外观；不跟随此 Workspace 的预设。",
  stoppedEdited: "已停止跟随此 Workspace 的共享预设：此设备上的外观已更改，并保持这里的设置。",
  stoppedChosen: "已停止跟随。此设备保留当前外观；Core 上没有任何变化。",
  stopUnsaved: (why) => `此设备无法保存“已停止”（${why}），因此只在本次访问中停止。`,
  title: "共享外观预设",
  intro:
    "此 Workspace 的 Core 为你使用的设备保存的一个外观预设。保存会把此设备的外观放在那里；另一台设备会把它与自己的外观并排预览，并在自己身上应用你选的设置。在你按下按钮之前，不会保存或应用任何内容。设备也可以在你开启后单向跟随该预设：之后它会自行应用每个更新的修订，直到那里的外观被更改或停止跟随。这不是双向同步：跟随从不会把设备的外观发送到任何地方。其中只有外观，从不包括消息发送方式、时间显示、语言、账户、权限或文件夹。",
  sharedPreset: "共享预设",
  inWorkspace: "在此 Workspace 中",
  saving: "正在保存…",
  saveHere: "把此设备的外观保存到这里",
  replace: "用此设备的外观替换它",
  preview: "预览…",
  readAgain: "重新读取",
  onDevice: "在此设备上",
  followPreset: "跟随此预设…",
  tryAgain: "重试",
  stopFollowing: "停止跟随",
  followPreview: "跟随预览",
  followPreviewText: (revision, saved) =>
    `修订 ${revision}${saved}。跟随会立即在此设备上应用以下全部设置并保存在这里，之后在 Yuzuno 于此打开期间，此 Workspace 预设的每个更新修订保存后也会应用。在此设备上更改外观会停止跟随。跟随从不会把此设备的外观发送到任何地方。`,
  leftOut: (names) => `此版本不认识的外观设置，因此略过：${names}`,
  followingBusy: "正在跟随…",
  followApply: (n) => `跟随并应用 ${n} 项更改`,
  followNothing: "跟随（现在没有变化）",
  cancel: "取消",
  presetPreview: "共享预设预览",
  applyPreviewText: (revision, saved) => `修订 ${revision}${saved}。勾选的设置会从共享预设中取用，只保存在此设备上；其他设置保持不变。`,
  applying: "正在应用…",
  applySelected: (n) => `应用所选的 ${n} 项`,
  nothingToApply: "没有可应用的",
});
type Words = ReturnType<typeof text>;
const time = (at: string) => new Date(at).toLocaleString();
const savedText = (t: Words, at: string | null) => (at ? t.savedAt(time(at)) : "");

/** What the last action said, in `language`. */
function saidText(said: Said, language: Language): string {
  const t = text(language);
  switch (said.kind) {
    case "conflict":
      return said.conflict === "preset_changed" ? t.conflictChanged : t.conflictOther;
    case "saved":
      return t.saved(said.revision);
    case "noAnswer":
      return t.noAnswer;
    case "notSaved":
      return t.notSaved(presetErrorText(said.error, language));
    case "unconfirmed":
      return t.unconfirmed(t.what[said.what], presetErrorText(said.error, language));
    case "otherWorkspace":
      return t.otherWorkspace(t.what[said.what]);
    case "changed":
      return t.changed(t.what[said.what]);
    case "notApplied":
      return t.notApplied(t.what[said.what], saveRefusalReason(said.refused, language));
    case "applied":
      return t.applied(said.count);
    case "followUnsaved":
      return t.followUnsaved(said.revision, saveRefusalReason(said.refused, language));
    case "following":
      return t.following(said.revision);
  }
}

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
  const language = useLanguage();
  const t = text(language);
  return (
    <ul>
      {appearanceFields.map((field) => {
        const value = contents.values[field];
        const bad = contents.invalid.find((item) => item.field === field);
        if (value === undefined && !bad) return null;
        const now = fieldText(field, fieldValue(appearance, field), language);
        const label = fieldLabel(field, language);
        if (value === undefined)
          return (
            <li key={field} data-state="invalid">
              <span className="appearance-file-name">{label}</span>
              <span>{t.now(now)}</span>
              <span>{t.sharedBad(bad!.value)}</span>
            </li>
          );
        const same = value === fieldValue(appearance, field);
        const shared = same ? t.sharedSame : t.shared(fieldText(field, value, language));
        if (fixed)
          return (
            <li key={field} data-state={same ? "same" : "differs"}>
              <span className="appearance-file-name">{label}</span>
              <span>{t.now(now)}</span>
              <span>{shared}</span>
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
              {label}
            </label>
            <span>{t.now(now)}</span>
            <span>{shared}</span>
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
  const language = useLanguage();
  const t = text(language);
  const appearance = useAppearance();
  const [read, setRead] = useState<PresetRead | null>(null);
  // Opened active, it is reading from the start, never "not read" first.
  const [reading, setReading] = useState<"reading" | { error: unknown } | null>(active ? "reading" : null);
  // Picking settings to apply once, or seeing what following takes.
  const [preview, setPreview] = useState<false | "apply" | "follow">(false);
  const [chosen, setChosen] = useState<AppearanceField[]>([]);
  const [busy, setBusy] = useState<"save" | "apply" | "follow" | null>(null);
  const [said, setSaid] = useState<{ error: boolean; said: Said; n: number } | null>(null);
  // An answer to a read or save from before the editor closed is not used.
  const generation = useRef(0);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said?.error) line.current?.scrollIntoView?.({ block: "nearest" });
  }, [said]);
  const say = (error: boolean, line: Said) => setSaid((old) => ({ error, said: line, n: (old?.n ?? 0) + 1 }));
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
        setReading({ error });
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
        say(true, { kind: "conflict", conflict: outcome.conflict });
        return;
      }
      setRead(outcome);
      setPreview(false);
      say(false, { kind: "saved", revision: outcome.revision });
    } catch (error) {
      if (n !== generation.current) return;
      if (error instanceof NetworkError) {
        forget();
        say(true, { kind: "noAnswer" });
      } else say(true, { kind: "notSaved", error });
    } finally {
      if (n === generation.current) setBusy(null);
    }
  }

  /** Asks Core again whether the preset previewed is still this Workspace's,
   * at that revision; says why not otherwise. */
  async function confirmed(target: PresetRead, n: number, what: What): Promise<boolean> {
    let now: PresetRead;
    try {
      now = await fetchPreset();
    } catch (error) {
      if (n !== generation.current) return false;
      forget();
      say(true, { kind: "unconfirmed", what, error });
      return false;
    }
    if (n !== generation.current) return false;
    if (now.workspaceId !== target.workspaceId) {
      forget();
      say(true, { kind: "otherWorkspace", what });
      return false;
    }
    if (now.revision !== target.revision) {
      setRead(now);
      setPreview(false);
      say(true, { kind: "changed", what });
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
      say(true, { kind: "notApplied", what: "applied", refused: outcome });
      return;
    }
    setPreview(false);
    say(false, { kind: "applied", count: fields.length });
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
      say(true, { kind: "notApplied", what: "following", refused: outcome });
      return;
    }
    const kept = startFollowing(read.workspaceId, read.revision);
    setPreview(false);
    if (!kept.saved) {
      say(true, { kind: "followUnsaved", revision: read.revision, refused: kept });
      return;
    }
    say(false, { kind: "following", revision: read.revision });
  }

  let status: string;
  if (reading === "reading") status = t.reading;
  else if (reading) status = t.couldNotRead(presetErrorText(reading.error, language));
  else if (!read) status = t.notRead;
  else if (read.kind === "none") status = t.none(short(read.workspaceId));
  else if (read.kind === "refused") status = t.refused(short(read.workspaceId), read.revision, refusedText(read.why, language));
  else status = t.preset(short(read.workspaceId), read.revision, savedText(t, read.savedAt), read.savedVia ? t.via[read.savedVia] : "");

  const following = useFollow(read?.workspaceId ?? null);
  const changes = contents ? appearanceFields.filter(differs).length : 0;
  let device: string | null = null;
  if (read && following.revision !== null) {
    const c = following.condition;
    if (c?.kind === "offline") device = t.offline(following.revision);
    else if (c?.kind === "paused") device = t.paused(pauseText(c.why, language));
    else {
      const applied = c?.kind === "following" && c.appliedAt ? t.appliedAt(time(c.appliedAt)) : "";
      const note = c?.kind === "following" && c.note ? t.note(noteText(c.note, language)) : "";
      device = t.follows(following.revision, applied, note);
    }
  } else if (read) device = t.ownAppearance;
  const stop = following.stop;
  const stopText = stop
    ? `${stop.why === "edited" ? t.stoppedEdited : t.stoppedChosen}${stop.unsaved ? t.stopUnsaved(saveRefusalReason(stop.unsaved, language)) : ""}`
    : null;

  return (
    <section
      id="settings-appearance-preset"
      className="settings-section appearance-preset"
      aria-labelledby="settings-appearance-preset-title"
      lang={langTag(language)}
    >
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-appearance-preset-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      <div className="settings-group appearance-file" aria-label={t.sharedPreset}>
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.inWorkspace}</span>
            <span className="settings-row-help appearance-preset-status">
              {status}
            </span>
          </span>
          <span className="settings-row-action appearance-file-buttons">
            <button type="button" disabled={!read || !!busy} onClick={() => void save()}>
              {busy === "save" ? t.saving : read?.kind === "none" ? t.saveHere : t.replace}
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
              {t.preview}
            </button>
            <button
              type="button"
              disabled={reading === "reading" || !!busy}
              onClick={() => {
                setSaid(null);
                load();
              }}
            >
              {t.readAgain}
            </button>
          </span>
        </div>
        {device && (
          <div className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.onDevice}</span>
              <span className="settings-row-help appearance-follow-status">{device}</span>
            </span>
            <span className="settings-row-action appearance-file-buttons">
              {following.revision === null ? (
                <button type="button" disabled={!contents || !!busy || !!preview} onClick={() => { setSaid(null); setPreview("follow"); }}>
                  {t.followPreset}
                </button>
              ) : (
                <>
                  {(following.condition?.kind === "paused" || following.condition?.kind === "offline") && (
                    <button type="button" onClick={() => void catchUp(read!.workspaceId)}>
                      {t.tryAgain}
                    </button>
                  )}
                  <button type="button" onClick={() => stopFollowing(read!.workspaceId, "chosen")}>
                    {t.stopFollowing}
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
          <div className="appearance-file-preview" role="group" aria-label={t.followPreview}>
            <p>{t.followPreviewText(read.revision, savedText(t, read.savedAt))}</p>
            <PresetChoices appearance={appearance} contents={read.contents} chosen={[]} onChosen={() => {}} fixed />
            {read.contents.unknown.length > 0 && <p className="settings-row-help">{t.leftOut(read.contents.unknown.join(", "))}</p>}
            <div className="appearance-file-buttons">
              <button type="button" disabled={!!busy} onClick={() => void follow()}>
                {busy === "follow" ? t.followingBusy : changes ? t.followApply(changes) : t.followNothing}
              </button>
              <button type="button" disabled={!!busy} onClick={() => setPreview(false)}>
                {t.cancel}
              </button>
            </div>
          </div>
        )}
        {preview === "apply" && read?.kind === "preset" && (
          <div className="appearance-file-preview" role="group" aria-label={t.presetPreview}>
            <p>{t.applyPreviewText(read.revision, savedText(t, read.savedAt))}</p>
            <PresetChoices appearance={appearance} contents={read.contents} chosen={chosen} onChosen={setChosen} />
            {read.contents.unknown.length > 0 && <p className="settings-row-help">{t.leftOut(read.contents.unknown.join(", "))}</p>}
            <div className="appearance-file-buttons">
              <button type="button" disabled={!selected.length || !!busy} onClick={() => void apply()}>
                {busy === "apply" ? t.applying : selected.length ? t.applySelected(selected.length) : t.nothingToApply}
              </button>
              <button type="button" disabled={!!busy} onClick={() => setPreview(false)}>
                {t.cancel}
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
            {saidText(said.said, language)}
          </p>
        )}
      </div>
    </section>
  );
}

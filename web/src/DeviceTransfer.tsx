import { useEffect, useRef, useState } from "react";
import { shortcutModifier } from "./api";
import { importAppearance, useAppearance } from "./appearance";
import { appearanceFields, fieldValue, importedAppearance, type AppearanceField } from "./appearance-file";
import { fieldLabel, fieldText } from "./AppearanceSettings";
import type { FileRefusal } from "./appearance-file";
import type { SaveOutcome } from "./device-storage";
import { importLanguagePreferences, strings, useLanguage, useLanguagePreferences, type LanguageChoice } from "./i18n";
import { notificationCategories, type NotificationCategory } from "./notification-prefs";
import { importNotificationPrefs, useNotificationPrefs } from "./notification-store";
import { saveRefusalReason } from "./SaveStatus";
import { importPreferences, useDevicePreferences, type SendKey } from "./device-preferences";
import {
  DEVICE_FILE,
  MAX_DEVICE_FILE_BYTES,
  deviceGroups,
  exportDevicePreferences,
  readDeviceFile,
  type DeviceFileContents,
  type DeviceGroup,
  type GroupRefusal,
} from "./device-transfer-file";
import { importTimePreferences, timeZoneName, useTimePreferences, type ClockFormat } from "./time-preferences";
import "./appearance.css";
import "./device-transfer.css";

/** What a line said last, as what happened, so it is worded in the language
 * shown, also after a switch (T-189). */
type Message =
  | { kind: "tooLarge"; name: string }
  | { kind: "unreadable"; name: string }
  | { kind: "refused"; refusal: FileRefusal }
  | { kind: "applied"; group: DeviceGroup }
  | { kind: "notApplied"; group: DeviceGroup; outcome: Extract<SaveOutcome, { saved: false }> };

// Key names (Return, ⌘, Ctrl), time zones (IANA's) and file names are written
// as they are; what a file holds is shown as it holds it.
const text = strings({
  groups: { appearance: "Appearance", sending: "Sending messages", time: "Time display", language: "Language", notifications: "Notifications" } as Record<DeviceGroup, string>,
  sendKeys: (modifier: string): Record<SendKey, string> => ({ auto: "Automatic", enter: "Return sends", modEnter: `${modifier}+Return sends` }),
  clocks: { system: "System", h12: "12-hour", h24: "24-hour" } as Record<ClockFormat, string>,
  ownZone: "This device’s own",
  sendKey: "Send key",
  clock: "Clock",
  timeZone: "Time zone",
  // Each language is named in its own words, as Settings → Language names them.
  languages: { system: "System", en: "English", "zh-Hans": "简体中文" } as Record<LanguageChoice, string>,
  interfaceLanguage: "Interface language",
  kinds: { needsYou: "An Agent needs you", failed: "A Turn failed", finished: "A Turn finished", backupFailed: "A daily backup failed" } as Record<NotificationCategory, string>,
  choices: { preview: "Show what was written", muted: "Mute on this device" },
  on: "On",
  off: "Off",
  deviceOwn: "Whether this device notifies at all, and this browser’s permission, stay as they are: applying never turns notifications on or asks for permission.",
  invalid: "not a value Yuzuno accepts; kept as now",
  title: "Move preferences to another device",
  intro: "One file of this device’s Appearance, how messages are sent, how times are shown, the interface language and the notification choices. Accounts, permissions, folders, conversations and drafts are never in it, and nothing in the Workspace changes. Importing shows each group beside yours, and you apply each group on its own. This copies a file; it doesn’t sync devices.",
  fileGroup: "Preferences file",
  help: "Exports the settings in effect: the language as chosen (System stays System), and which notifications, previews and mute, but not whether this device notifies at all. An Appearance export from this settings page can be imported here too. Keyboard shortcuts aren’t in the file. An older Yuzuno reading this file leaves out the language and notifications.",
  export: "Export to a file",
  import: "Import from a file…",
  choose: "Choose a preferences file",
  preview: "Import preview",
  from: (name: string, exportedAt: string | null, appearanceOnly: boolean) =>
    `From ${name}${exportedAt ? `, exported ${exportedAt}` : ""}${appearanceOnly ? ", an Appearance export: only Appearance is in it" : ""}. Each group applies on its own; the others stay as they are.`,
  cannot: (refusal: GroupRefusal) => `Can’t be applied: the file holds ${refusal.refused}. Kept as now.`,
  now: (value: string) => `Now: ${value}`,
  same: "File: the same",
  file: (value: string | null, invalid?: string) => (invalid ? `File: ${value}, ${invalid}` : `File: ${value}`),
  apply: (group: string, pending: number) => (pending ? `Apply ${group}` : "Nothing to apply"),
  unknown: (names: string) => `Not preferences this version knows, so left out: ${names}`,
  close: "Close",
  message: (message: Message, groups: Record<DeviceGroup, string>): string => {
    switch (message.kind) {
      case "tooLarge":
        return `${message.name} is larger than 16 KiB, too large for a preferences export, so it was not read. Nothing was changed.`;
      case "unreadable":
        return `${message.name} could not be read. Nothing was changed.`;
      case "refused":
        return `${message.refusal.error}. Nothing was changed.`;
      case "applied":
        return `${groups[message.group]} applied and saved on this device.`;
      case "notApplied":
        return `${groups[message.group]} not applied: ${message.outcome.detail}. It stays as it is.`;
    }
  },
}, {
  groups: { appearance: "外观", sending: "发送消息", time: "时间显示", language: "界面语言", notifications: "通知" },
  sendKeys: (modifier) => ({ auto: "自动", enter: "Return 发送", modEnter: `${modifier}+Return 发送` }),
  clocks: { system: "系统", h12: "12 小时制", h24: "24 小时制" },
  ownZone: "此设备自己的时区",
  sendKey: "发送键",
  clock: "时钟",
  timeZone: "时区",
  languages: { system: "系统", en: "English", "zh-Hans": "简体中文" },
  interfaceLanguage: "界面语言",
  kinds: { needsYou: "有 Agent 需要你", failed: "Turn 失败", finished: "Turn 完成", backupFailed: "每日备份失败" },
  choices: { preview: "显示所写的内容", muted: "在此设备上静音" },
  on: "开",
  off: "关",
  deviceOwn: "此设备是否发送通知，以及此浏览器的权限，都保持不变：应用时从不开启通知，也不请求权限。",
  invalid: "不是 Yuzuno 接受的值；保持当前",
  title: "把偏好移到另一台设备",
  intro: "一个文件，包含此设备的外观、消息的发送方式、时间的显示方式、界面语言和通知选择。账户、权限、文件夹、会话和草稿从不在其中，Workspace 中的任何内容也不会改变。导入时会把每组与你的并排显示，由你逐组应用。这是复制一个文件，不会在设备之间同步。",
  fileGroup: "偏好文件",
  help: "导出当前生效的设置：界面语言按你的选择导出（“系统”仍是“系统”），通知则导出通知哪些内容、是否显示内容和静音，但不包括此设备是否发送通知。在此设置页导出的外观文件也可以在这里导入。键盘快捷键不在文件中。较旧版本的 Yuzuno 读取此文件时会略过界面语言和通知。",
  export: "导出到文件",
  import: "从文件导入…",
  choose: "选择偏好文件",
  preview: "导入预览",
  from: (name, exportedAt, appearanceOnly) =>
    `来自 ${name}${exportedAt ? `，导出于 ${exportedAt}` : ""}${appearanceOnly ? "，这是外观导出文件：其中只有外观" : ""}。每组单独应用，其他组保持不变。`,
  cannot: (refusal) =>
    `无法应用：${
      {
        notSettings: `文件中的内容不是设置：${refusal.value}`,
        sendKey: `文件中是此版本没有的发送键：${refusal.value}`,
        clock: `文件中是此版本没有的时钟格式：${refusal.value}`,
        timeZone: `文件中是此浏览器不认识的时区：${refusal.value}`,
        language: `文件中是此版本没有的界面语言选择：${refusal.value}`,
        onOff: `文件中的值不是开或关：${refusal.value}`,
      }[refusal.reason] ?? refusal.refused
    }。保持当前。`,
  now: (value) => `当前：${value}`,
  same: "文件：相同",
  file: (value, invalid) => (invalid ? `文件：${value}，${invalid}` : `文件：${value}`),
  apply: (group, pending) => (pending ? `应用${group}` : "没有可应用的"),
  unknown: (names) => `此版本不认识的偏好，因此未包含：${names}`,
  close: "关闭",
  message: (message, groups) => {
    switch (message.kind) {
      case "tooLarge":
        return `${message.name} 大于 16 KiB，作为偏好导出文件太大，因此没有读取。没有更改任何内容。`;
      case "unreadable":
        return `无法读取 ${message.name}。没有更改任何内容。`;
      case "refused":
        return `${
          {
            notJson: "此文件不是 JSON，因此不是偏好导出文件",
            notExport: "此文件不是 Yuzuno 的偏好或外观导出文件",
            newer: `此文件来自更新的 Yuzuno（文件版本 ${message.refusal.version}），此版本只能读取版本 ${message.refusal.reads}`,
            unknownVersion: "此文件的版本不是 Yuzuno 认识的版本",
            empty: "此文件不含这些偏好中的任何一项",
          }[message.refusal.code] ?? message.refusal.error
        }。没有更改任何内容。`;
      case "applied":
        return `${groups[message.group]}已应用并保存到此设备。`;
      case "notApplied":
        return `${groups[message.group]}未应用：${saveRefusalReason(message.outcome, "zh-Hans")}。它保持不变。`;
    }
  },
});

type Row = { key: string; label: string; now: string; file: string | null; differs: boolean; invalid?: string };
type Said = { error: boolean; message: Message };

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * This device's preferences to and from one file (T-194): Appearance, how
 * messages are sent, how times are shown, the interface language and the
 * notification choices. Export writes the settings in effect. Import shows each group beside yours, and each group is applied
 * on its own, only once saved on this device: a refused save, or Cancel,
 * leaves that group as it is. No step changes more than one group, and
 * nothing here syncs between devices.
 */
export function DeviceTransferSection() {
  const language = useLanguage();
  const t = text(language);
  const sendKeyText = t.sendKeys(shortcutModifier);
  const zoneText = (zone: string | null) => (zone ? timeZoneName(zone) : t.ownZone);
  const appearance = useAppearance();
  const sending = useDevicePreferences();
  const time = useTimePreferences();
  const languageChoice = useLanguagePreferences();
  const notifications = useNotificationPrefs();
  const onOff = (on: boolean) => (on ? t.on : t.off);
  const [file, setFile] = useState<{ name: string; contents: DeviceFileContents } | null>(null);
  const [said, setSaid] = useState<Partial<Record<DeviceGroup | "file", Said>>>({});
  const picker = useRef<HTMLInputElement>(null);

  const rows = (group: DeviceGroup, contents: DeviceFileContents): Row[] => {
    if (group === "appearance") {
      const read = contents.appearance;
      if (!read || "refused" in read) return [];
      return appearanceFields.flatMap((field): Row[] => {
        const value = read.values[field];
        const bad = read.invalid.find((item) => item.field === field);
        if (value === undefined && !bad) return [];
        const now = fieldText(field, fieldValue(appearance, field), language);
        if (value === undefined)
          return [{ key: field, label: fieldLabel(field, language), now, file: bad!.value, differs: false, invalid: t.invalid }];
        return [{ key: field, label: fieldLabel(field, language), now, file: fieldText(field, value, language), differs: value !== fieldValue(appearance, field) }];
      });
    }
    if (group === "sending") {
      const read = contents.sending;
      if (!read || "refused" in read || read.value.sendKey === undefined) return [];
      const value = read.value.sendKey;
      return [{ key: "sendKey", label: t.sendKey, now: sendKeyText[sending.sendKey], file: sendKeyText[value], differs: value !== sending.sendKey }];
    }
    if (group === "language") {
      const read = contents.language;
      if (!read || "refused" in read || read.value.language === undefined) return [];
      const value = read.value.language;
      return [{ key: "language", label: t.interfaceLanguage, now: t.languages[languageChoice.language], file: t.languages[value], differs: value !== languageChoice.language }];
    }
    if (group === "notifications") {
      const read = contents.notifications;
      if (!read || "refused" in read) return [];
      const out: Row[] = [];
      for (const kind of notificationCategories) {
        const value = read.value.categories?.[kind];
        if (value === undefined) continue;
        const now = notifications.categories[kind];
        out.push({ key: kind, label: t.kinds[kind], now: onOff(now), file: onOff(value), differs: value !== now });
      }
      for (const name of ["preview", "muted"] as const) {
        const value = read.value[name];
        if (value === undefined) continue;
        out.push({ key: name, label: t.choices[name], now: onOff(notifications[name]), file: onOff(value), differs: value !== notifications[name] });
      }
      return out;
    }
    const read = contents.time;
    if (!read || "refused" in read) return [];
    const out: Row[] = [];
    if (read.value.clock !== undefined)
      out.push({ key: "clock", label: t.clock, now: t.clocks[time.clock], file: t.clocks[read.value.clock], differs: read.value.clock !== time.clock });
    if (read.value.timeZone !== undefined)
      out.push({ key: "timeZone", label: t.timeZone, now: zoneText(time.timeZone), file: zoneText(read.value.timeZone), differs: read.value.timeZone !== time.timeZone });
    return out;
  };
  const refusal = (group: DeviceGroup, contents: DeviceFileContents) => {
    const read = contents[group];
    return read && "refused" in read ? read : null;
  };

  function exportFile() {
    const text = exportDevicePreferences({ appearance, sending, time, language: languageChoice, notifications });
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${DEVICE_FILE}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function choose(picked: File | undefined) {
    setSaid({});
    setFile(null);
    if (!picked) return;
    if (picked.size > MAX_DEVICE_FILE_BYTES) {
      setSaid({ file: { error: true, message: { kind: "tooLarge", name: picked.name } } });
      return;
    }
    let text: string;
    try {
      text = await readText(picked);
    } catch {
      setSaid({ file: { error: true, message: { kind: "unreadable", name: picked.name } } });
      return;
    }
    const read = readDeviceFile(text);
    if ("error" in read) {
      setSaid({ file: { error: true, message: { kind: "refused", refusal: read } } });
      return;
    }
    setFile({ name: picked.name, contents: read.contents });
  }
  /** One group, saved on this device first; nothing else changes. */
  function apply(group: DeviceGroup) {
    if (!file) return;
    const contents = file.contents;
    let outcome;
    if (group === "appearance") {
      const read = contents.appearance;
      if (!read || "refused" in read) return;
      const fields = appearanceFields.filter((field: AppearanceField) => {
        const value = read.values[field];
        return value !== undefined && value !== fieldValue(appearance, field);
      });
      if (!fields.length) return;
      outcome = importAppearance(importedAppearance(appearance, { ...read, unknown: [], exportedAt: null }, fields));
    } else if (group === "sending") {
      const read = contents.sending;
      if (!read || "refused" in read) return;
      outcome = importPreferences({ ...sending, ...read.value });
    } else if (group === "time") {
      const read = contents.time;
      if (!read || "refused" in read) return;
      outcome = importTimePreferences({ ...time, ...read.value });
    } else if (group === "language") {
      const read = contents.language;
      if (!read || "refused" in read) return;
      outcome = importLanguagePreferences({ ...languageChoice, ...read.value });
    } else {
      const read = contents.notifications;
      if (!read || "refused" in read) return;
      // The kinds, previews and mute only: whether this device notifies stays its own.
      outcome = importNotificationPrefs({
        categories: { ...notifications.categories, ...read.value.categories },
        preview: read.value.preview ?? notifications.preview,
        muted: read.value.muted ?? notifications.muted,
      });
    }
    setSaid((old) => ({
      ...old,
      [group]: outcome.saved
        ? { error: false, message: { kind: "applied", group } }
        : { error: true, message: { kind: "notApplied", group, outcome } },
    }));
  }
  // A group's line says what its last Apply did, until another file is read.
  useEffect(() => {
    if (!file) setSaid((old) => (old.file ? { file: old.file } : {}));
  }, [file]);

  const exportedAt =
    file?.contents.exportedAt && !Number.isNaN(Date.parse(file.contents.exportedAt))
      ? new Date(file.contents.exportedAt).toLocaleString()
      : null;
  return (
    <section id="settings-transfer" className="settings-section device-transfer" aria-labelledby="settings-transfer-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-transfer-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      <div className="settings-group appearance-file" aria-label={t.fileGroup}>
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.fileGroup}</span>
            <span className="settings-row-help">{t.help}</span>
          </span>
          <span className="settings-row-action appearance-file-buttons">
            <button type="button" onClick={exportFile}>
              {t.export}
            </button>
            <button type="button" onClick={() => picker.current?.click()}>
              {t.import}
            </button>
            <input
              ref={picker}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label={t.choose}
              onChange={(event) => {
                const picked = event.target.files?.[0];
                event.target.value = "";
                void choose(picked);
              }}
            />
          </span>
        </div>
        {file && (
          <div className="appearance-file-preview device-transfer-preview" role="group" aria-label={t.preview}>
            {/* The file's name, as the system wrote it, is never translated. */}
            <p>{t.from(file.name, exportedAt, file.contents.kind === "appearance")}</p>
            {deviceGroups.map((group) => {
              if (!file.contents[group]) return null;
              const refused = refusal(group, file.contents);
              const list = rows(group, file.contents);
              const pending = list.filter((row) => row.differs).length;
              const line = said[group];
              return (
                <section key={group} className="device-transfer-group" aria-label={t.groups[group]}>
                  <h4>{t.groups[group]}</h4>
                  {refused ? (
                    <p className="appearance-file-error">{t.cannot(refused)}</p>
                  ) : (
                    <ul>
                      {list.map((row) => (
                        <li key={row.key} data-state={row.invalid ? "invalid" : row.differs ? "differs" : "same"}>
                          <span className="appearance-file-name">{row.label}</span>
                          <span>{t.now(row.now)}</span>
                          <span>{row.invalid || row.differs ? t.file(row.file, row.invalid) : t.same}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {group === "notifications" && <p className="settings-row-help">{t.deviceOwn}</p>}
                  {!refused && (
                    <button type="button" disabled={!pending} onClick={() => apply(group)}>
                      {t.apply(t.groups[group], pending)}
                    </button>
                  )}
                  {line && (
                    <p className={line.error ? "appearance-file-error" : "appearance-file-done"} role={line.error ? "alert" : "status"}>
                      {t.message(line.message, t.groups)}
                    </p>
                  )}
                </section>
              );
            })}
            {file.contents.unknown.length > 0 && (
              <p className="settings-row-help">{t.unknown(file.contents.unknown.join(", "))}</p>
            )}
            <div className="appearance-file-buttons">
              <button type="button" onClick={() => setFile(null)}>
                {t.close}
              </button>
            </div>
          </div>
        )}
        {said.file && (
          <p className={said.file.error ? "appearance-file-error" : "appearance-file-done"} role={said.file.error ? "alert" : "status"}>
            {t.message(said.file.message, t.groups)}
          </p>
        )}
      </div>
    </section>
  );
}

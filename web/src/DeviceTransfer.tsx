import { useEffect, useRef, useState } from "react";
import { shortcutModifier } from "./api";
import { importAppearance, useAppearance } from "./appearance";
import { appearanceFields, fieldValue, importedAppearance, type AppearanceField } from "./appearance-file";
import { fieldLabels, fieldText } from "./AppearanceSettings";
import { importPreferences, useDevicePreferences, type SendKey } from "./device-preferences";
import {
  DEVICE_FILE,
  MAX_DEVICE_FILE_BYTES,
  deviceGroups,
  exportDevicePreferences,
  readDeviceFile,
  type DeviceFileContents,
  type DeviceGroup,
} from "./device-transfer-file";
import { importTimePreferences, timeZoneName, useTimePreferences, type ClockFormat } from "./time-preferences";
import "./appearance.css";
import "./device-transfer.css";

const groupTitles: Record<DeviceGroup, string> = {
  appearance: "Appearance",
  sending: "Sending messages",
  time: "Time display",
};
const sendKeyText: Record<SendKey, string> = {
  auto: "Automatic",
  enter: "Return sends",
  modEnter: `${shortcutModifier}+Return sends`,
};
const clockText: Record<ClockFormat, string> = { system: "System", h12: "12-hour", h24: "24-hour" };
const zoneText = (zone: string | null) => (zone ? timeZoneName(zone) : "This device’s own");

type Row = { key: string; label: string; now: string; file: string | null; differs: boolean; invalid?: string };
type Said = { error: boolean; text: string };

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
 * messages are sent and how times are shown. Export writes the settings in
 * effect. Import shows each group beside yours, and each group is applied
 * on its own, only once saved on this device: a refused save, or Cancel,
 * leaves that group as it is. No step changes more than one group, and
 * nothing here syncs between devices.
 */
export function DeviceTransferSection() {
  const appearance = useAppearance();
  const sending = useDevicePreferences();
  const time = useTimePreferences();
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
        const now = fieldText(field, fieldValue(appearance, field));
        if (value === undefined)
          return [{ key: field, label: fieldLabels[field], now, file: bad!.value, differs: false, invalid: "not a value Yuzuno accepts; kept as now" }];
        return [{ key: field, label: fieldLabels[field], now, file: fieldText(field, value), differs: value !== fieldValue(appearance, field) }];
      });
    }
    if (group === "sending") {
      const read = contents.sending;
      if (!read || "refused" in read || read.value.sendKey === undefined) return [];
      const value = read.value.sendKey;
      return [{ key: "sendKey", label: "Send key", now: sendKeyText[sending.sendKey], file: sendKeyText[value], differs: value !== sending.sendKey }];
    }
    const read = contents.time;
    if (!read || "refused" in read) return [];
    const out: Row[] = [];
    if (read.value.clock !== undefined)
      out.push({ key: "clock", label: "Clock", now: clockText[time.clock], file: clockText[read.value.clock], differs: read.value.clock !== time.clock });
    if (read.value.timeZone !== undefined)
      out.push({ key: "timeZone", label: "Time zone", now: zoneText(time.timeZone), file: zoneText(read.value.timeZone), differs: read.value.timeZone !== time.timeZone });
    return out;
  };
  const refusal = (group: DeviceGroup, contents: DeviceFileContents) => {
    const read = contents[group];
    return read && "refused" in read ? read.refused : null;
  };

  function exportFile() {
    const text = exportDevicePreferences({ appearance, sending, time });
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
      setSaid({ file: { error: true, text: `${picked.name} is larger than 16 KiB, too large for a preferences export, so it was not read. Nothing was changed.` } });
      return;
    }
    let text: string;
    try {
      text = await readText(picked);
    } catch {
      setSaid({ file: { error: true, text: `${picked.name} could not be read. Nothing was changed.` } });
      return;
    }
    const read = readDeviceFile(text);
    if ("error" in read) {
      setSaid({ file: { error: true, text: `${read.error}. Nothing was changed.` } });
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
    } else {
      const read = contents.time;
      if (!read || "refused" in read) return;
      outcome = importTimePreferences({ ...time, ...read.value });
    }
    setSaid((old) => ({
      ...old,
      [group]: outcome.saved
        ? { error: false, text: `${groupTitles[group]} applied and saved on this device.` }
        : { error: true, text: `${groupTitles[group]} not applied: ${outcome.detail}. It stays as it is.` },
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
          <h3 id="settings-transfer-title">Move preferences to another device</h3>
          <p>
            One file of this device’s Appearance, how messages are sent and how times are shown. Accounts, permissions,
            folders, conversations and drafts are never in it, and nothing in the Workspace changes. Importing shows
            each group beside yours, and you apply each group on its own. This copies a file; it doesn’t sync devices.
          </p>
        </div>
      </header>
      <div className="settings-group appearance-file" aria-label="Preferences file">
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">Preferences file</span>
            <span className="settings-row-help">
              Exports the settings in effect. An Appearance export from this settings page can be imported here too.
              Language and keyboard shortcuts aren’t in the file.
            </span>
          </span>
          <span className="settings-row-action appearance-file-buttons">
            <button type="button" onClick={exportFile}>
              Export to a file
            </button>
            <button type="button" onClick={() => picker.current?.click()}>
              Import from a file…
            </button>
            <input
              ref={picker}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Choose a preferences file"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                event.target.value = "";
                void choose(picked);
              }}
            />
          </span>
        </div>
        {file && (
          <div className="appearance-file-preview device-transfer-preview" role="group" aria-label="Import preview">
            <p>
              From {file.name}
              {exportedAt ? `, exported ${exportedAt}` : ""}
              {file.contents.kind === "appearance" ? ", an Appearance export: only Appearance is in it" : ""}. Each group
              applies on its own; the others stay as they are.
            </p>
            {deviceGroups.map((group) => {
              if (!file.contents[group]) return null;
              const refused = refusal(group, file.contents);
              const list = rows(group, file.contents);
              const pending = list.filter((row) => row.differs).length;
              const line = said[group];
              return (
                <section key={group} className="device-transfer-group" aria-label={groupTitles[group]}>
                  <h4>{groupTitles[group]}</h4>
                  {refused ? (
                    <p className="appearance-file-error">Can’t be applied: the file holds {refused}. Kept as now.</p>
                  ) : (
                    <ul>
                      {list.map((row) => (
                        <li key={row.key} data-state={row.invalid ? "invalid" : row.differs ? "differs" : "same"}>
                          <span className="appearance-file-name">{row.label}</span>
                          <span>Now: {row.now}</span>
                          <span>{row.invalid ? `File: ${row.file}, ${row.invalid}` : row.differs ? `File: ${row.file}` : "File: the same"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!refused && (
                    <button type="button" disabled={!pending} onClick={() => apply(group)}>
                      {pending ? `Apply ${groupTitles[group]}` : "Nothing to apply"}
                    </button>
                  )}
                  {line && (
                    <p className={line.error ? "appearance-file-error" : "appearance-file-done"} role={line.error ? "alert" : "status"}>
                      {line.text}
                    </p>
                  )}
                </section>
              );
            })}
            {file.contents.unknown.length > 0 && (
              <p className="settings-row-help">
                Not preferences this version knows, so left out: {file.contents.unknown.join(", ")}
              </p>
            )}
            <div className="appearance-file-buttons">
              <button type="button" onClick={() => setFile(null)}>
                Close
              </button>
            </div>
          </div>
        )}
        {said.file && (
          <p className={said.file.error ? "appearance-file-error" : "appearance-file-done"} role={said.file.error ? "alert" : "status"}>
            {said.file.text}
          </p>
        )}
      </div>
    </section>
  );
}

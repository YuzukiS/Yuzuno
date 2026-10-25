import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Rows2, Rows4, Sun, Type } from "lucide-react";
import {
  appearanceStored,
  importAppearance,
  restoreDefaultAppearance,
  retryAppearanceWrite,
  saveAppearance,
  useAppearance,
  useAppearanceSave,
  type AgentListDensity,
  type Appearance,
  type DockLimits,
  type ProjectGroupStyle,
  MAX_DOCK_LIMIT,
  MAX_FONT_SIZE,
  MAX_TURN_BARS,
  MAX_TURN_NUMBERS,
  MIN_FONT_SIZE,
  type ThemePreference,
  palettes,
  type Palette,
} from "./appearance";
import {
  appearanceFields,
  exportAppearance,
  fieldValue,
  importedAppearance,
  MAX_APPEARANCE_FILE_BYTES,
  readAppearanceFile,
  type AppearanceField,
  type AppearanceFileContents,
} from "./appearance-file";
import { SaveStatus } from "./SaveStatus";

const themes: {
  value: ThemePreference;
  label: string;
  note: string;
  icon: typeof Sun;
}[] = [
  { value: "light", label: "Light", note: "Daylight", icon: Sun },
  { value: "dark", label: "Dark", note: "Low light", icon: Moon },
  {
    value: "system",
    label: "System",
    note: "Follow your device",
    icon: Monitor,
  },
];
const projectGroupChoices: {
  value: ProjectGroupStyle;
  label: string;
  note: string;
}[] = [
  { value: "headers", label: "Headers", note: "Small titles and a thin line" },
  { value: "cards", label: "Cards", note: "A light card for each project" },
  { value: "bands", label: "Colour bands", note: "A thin project colour beside each" },
  { value: "none", label: "No grouping", note: "One list, as before" },
];
const agentLists: {
  value: AgentListDensity;
  label: string;
  note: string;
  icon: typeof Sun;
  rows: number;
}[] = [
  {
    value: "detailed",
    label: "Detailed",
    note: "The latest report or update under each name",
    icon: Rows2,
    rows: 2,
  },
  {
    value: "compact",
    label: "Compact",
    note: "Name and status only",
    icon: Rows4,
    rows: 3,
  },
];
const dockLimits: { key: keyof DockLimits; label: string }[] = [
  { key: "jobs", label: "Local jobs" },
  { key: "actions", label: "GitHub Actions" },
  { key: "subAgents", label: "Sub-agents" },
];
/** One count on a slider, its name before it and its value, or what 0
 * means, after. */
function CountSlider({
  name,
  label,
  value,
  max,
  zero,
  onChange,
}: {
  name: string;
  label: string;
  value: number;
  max: number;
  /** What 0 means here, such as "Hidden". */
  zero: string;
  onChange: (value: number) => void;
}) {
  const shown = value === 0 ? zero : String(value);
  return (
    <label className="dock-limit">
      <span>{label}</span>
      <input
        type="range"
        name={name}
        min={0}
        max={max}
        step={1}
        value={value}
        aria-valuetext={shown}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output aria-hidden="true">{shown}</output>
    </label>
  );
}

const paletteLabels: Record<Palette, string> = {
  garden: "Garden",
  yuzu: "Yuzu",
  graphite: "Graphite",
  pine: "Pine",
  sunroom: "Sunroom",
};

/** Appearance, one category of Settings: how Yuzuno looks on this device.
 * It shows the choice in effect, which is the saved one unless this device
 * refused to save it (T-187); then it says so, keeps the choice, and offers
 * to try again or restore the defaults. Before a save in this visit it says
 * what this device holds: a saved choice, the defaults, or one it can't read. */
export function AppearanceSection() {
  const appearance = useAppearance();
  const save = useAppearanceSave();
  function update(next: Partial<Appearance>) {
    saveAppearance({ ...appearance, ...next });
  }
  const theme = themes.find((t) => t.value === appearance.theme)?.label;
  return (
    <section
      className="settings-section appearance-settings"
      aria-labelledby="settings-appearance-title"
    >
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-appearance-title">Appearance</h3>
          <p>
            Make yourself comfortable. Changes apply as you choose and stay
            on this device.
          </p>
        </div>
        <span className="settings-current" title="In effect now">
          {paletteLabels[appearance.palette]} · {theme} · {appearance.fontSize} px
          {appearance.agentList === "compact" && " · Compact list"}
        </span>
      </header>
      <div className="settings-group appearance-group">
        <fieldset className="appearance-field">
          <legend>Palette</legend>
          <div className="palette-options">
            {palettes.map((palette) => (
              <label
                key={palette}
                className="palette-choice"
                data-swatch={palette}
              >
                <input
                  type="radio"
                  name="appearance-palette"
                  value={palette}
                  checked={appearance.palette === palette}
                  onChange={() => update({ palette })}
                />
                <span className="palette-swatch" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{paletteLabels[palette]}</span>
                <Check
                  size={13}
                  className="palette-selected"
                  aria-hidden="true"
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>Theme</legend>
          <div className="theme-options">
            {themes.map(({ value, label, note, icon: Icon }) => (
              <label
                key={value}
                className={`theme-choice theme-choice-${value}`}
              >
                <input
                  type="radio"
                  name="appearance-theme"
                  value={value}
                  checked={appearance.theme === value}
                  onChange={() => update({ theme: value })}
                />
                <span className="theme-swatch" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="theme-choice-name">
                  <Icon size={14} />
                  {label}
                  <Check size={13} className="theme-selected" />
                </span>
                <small>{note}</small>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>Text size</legend>
          <p className="appearance-help">
            Conversation text, controls and file previews grow together. Below
            14 px only conversation text gets smaller, so controls stay legible.
          </p>
          <div className="font-size-slider">
            <span className="font-size-end" aria-hidden="true" style={{ fontSize: MIN_FONT_SIZE }}>
              Aa
            </span>
            <input
              type="range"
              name="appearance-font-size"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              step={1}
              value={appearance.fontSize}
              aria-label="Text size"
              aria-valuetext={`${appearance.fontSize} px`}
              onChange={(event) => update({ fontSize: Number(event.target.value) })}
            />
            <span className="font-size-end" aria-hidden="true" style={{ fontSize: MAX_FONT_SIZE }}>
              Aa
            </span>
            <output className="font-size-value" aria-hidden="true">
              {appearance.fontSize} px
            </output>
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>Agent list</legend>
          <p className="appearance-help">
            Each Agent's report or update stays in its conversation either
            way, and anything that needs you still shows.
          </p>
          <div className="agent-list-options">
            {agentLists.map(({ value, label, note, icon: Icon, rows }) => (
              <label
                key={value}
                className={`theme-choice agent-list-choice agent-list-choice-${value}`}
              >
                <input
                  type="radio"
                  name="appearance-agent-list"
                  value={value}
                  checked={appearance.agentList === value}
                  onChange={() => update({ agentList: value })}
                />
                <span className="agent-list-swatch" aria-hidden="true">
                  {Array.from({ length: rows }, (_, row) => (
                    <span key={row}>
                      <i />
                      <b />
                      <b />
                    </span>
                  ))}
                </span>
                <span className="theme-choice-name">
                  <Icon size={14} />
                  {label}
                  <Check size={13} className="theme-selected" />
                </span>
                <small>{note}</small>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>Project groups</legend>
          <p className="appearance-help">
            How the Agent list sets projects apart when it shows All
            projects. Each group folds, and its + starts a new agent in it.
          </p>
          <div className="project-group-options">
            {projectGroupChoices.map(({ value, label, note }) => (
              <label
                key={value}
                className={`theme-choice project-group-choice project-group-choice-${value}`}
              >
                <input
                  type="radio"
                  name="appearance-project-groups"
                  value={value}
                  checked={appearance.projectGroups === value}
                  onChange={() => update({ projectGroups: value })}
                />
                <span className="project-group-swatch" aria-hidden="true">
                  <span className="swatch-group">
                    <span>
                      <i />
                      <b />
                    </span>
                    <span>
                      <i />
                      <b />
                    </span>
                  </span>
                  <span className="swatch-group">
                    <span>
                      <i />
                      <b />
                    </span>
                  </span>
                </span>
                <span className="theme-choice-name">
                  {label}
                  <Check size={13} className="theme-selected" />
                </span>
                <small>{note}</small>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>Conversation dock</legend>
          <p className="appearance-help">
            The most of each the left edge of a conversation shows, what is
            running or queued first. 0 hides that group there; the Jobs panel
            still lists everything.
          </p>
          <div className="dock-limits">
            {dockLimits.map(({ key, label }) => (
              <CountSlider
                key={key}
                name={`appearance-dock-${key}`}
                label={label}
                value={appearance.dock[key]}
                max={MAX_DOCK_LIMIT}
                zero="Hidden"
                onChange={(value) =>
                  update({ dock: { ...appearance.dock, [key]: value } })
                }
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>Turn dock</legend>
          <p className="appearance-help">
            The right edge of a conversation: how many turns around the one
            you are reading show their number, and how many short bars lead
            on to further turns on each side. 0 numbered turns hides the
            dock; scrolling and Back to latest still work.
          </p>
          <div className="dock-limits">
            <CountSlider
              name="appearance-turn-numbers"
              label="Numbered turns"
              value={appearance.turnDock.numbers}
              max={MAX_TURN_NUMBERS}
              zero="Hidden"
              onChange={(numbers) =>
                update({ turnDock: { ...appearance.turnDock, numbers } })
              }
            />
            <CountSlider
              name="appearance-turn-bars"
              label="Bars on each side"
              value={appearance.turnDock.bars}
              max={MAX_TURN_BARS}
              zero="None"
              onChange={(bars) =>
                update({ turnDock: { ...appearance.turnDock, bars } })
              }
            />
          </div>
        </fieldset>
        <div className="appearance-preview">
          <span className="appearance-preview-label">
            <Type size={13} /> A little preview
          </span>
          <p>Room for your next idea.</p>
          <p lang="zh-CN">让每个想法，都有舒服的落脚处。</p>
          <code>const next = "something good";</code>
        </div>
      </div>
      <SaveStatus
        outcome={save?.outcome ?? null}
        action={save?.action}
        attempt={save?.attempt}
        stored={appearanceStored()}
        scope="this device"
        onRetry={retryAppearanceWrite}
        onRestoreDefaults={restoreDefaultAppearance}
      />
      <AppearanceFile appearance={appearance} />
    </section>
  );
}

export const fieldLabels: Record<AppearanceField, string> = {
  palette: "Palette",
  theme: "Theme",
  fontSize: "Text size",
  agentList: "Agent list",
  projectGroups: "Project groups",
  "dock.jobs": "Conversation dock: Local jobs",
  "dock.actions": "Conversation dock: GitHub Actions",
  "dock.subAgents": "Conversation dock: Sub-agents",
  "turnDock.numbers": "Turn dock: Numbered turns",
  "turnDock.bars": "Turn dock: Bars on each side",
};

/** A setting's value as the controls above name it. */
export function fieldText(field: AppearanceField, value: string | number): string {
  switch (field) {
    case "palette":
      return paletteLabels[value as Palette];
    case "theme":
      return themes.find((t) => t.value === value)?.label ?? String(value);
    case "fontSize":
      return `${value} px`;
    case "agentList":
      return agentLists.find((a) => a.value === value)?.label ?? String(value);
    case "projectGroups":
      return projectGroupChoices.find((p) => p.value === value)?.label ?? String(value);
    case "turnDock.bars":
      return value === 0 ? "None" : String(value);
    default:
      return value === 0 ? "Hidden" : String(value);
  }
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Appearance to and from a file (T-194). Export writes the settings in
 * effect. Import shows each setting the file holds beside the one in effect,
 * ticked where they differ, and applies only the ticked ones, once saved on
 * this device; a file it can't use, Cancel or a refused save change nothing. */
function AppearanceFile({ appearance }: { appearance: Appearance }) {
  const [file, setFile] = useState<{ name: string; contents: AppearanceFileContents } | null>(null);
  const [chosen, setChosen] = useState<AppearanceField[]>([]);
  const [said, setSaid] = useState<{ error: boolean; text: string; n: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  // In a short pane the line can lie below the button pressed.
  useEffect(() => {
    if (said?.error) line.current?.scrollIntoView?.({ block: "nearest" });
  }, [said]);
  const say = (error: boolean, text: string) => setSaid((old) => ({ error, text, n: (old?.n ?? 0) + 1 }));
  const differs = (field: AppearanceField, contents: AppearanceFileContents) => {
    const value = contents.values[field];
    return value !== undefined && value !== fieldValue(appearance, field);
  };
  const selected = file ? chosen.filter((field) => differs(field, file.contents)) : [];

  function exportFile() {
    const url = URL.createObjectURL(new Blob([exportAppearance(appearance)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "yuzuno-appearance.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function choose(picked: File | undefined) {
    setSaid(null);
    setFile(null);
    if (!picked) return;
    if (picked.size > MAX_APPEARANCE_FILE_BYTES) {
      say(true, `${picked.name} is larger than 16 KiB, too large for an Appearance export, so it was not read. Nothing was changed.`);
      return;
    }
    let text: string;
    try {
      text = await readText(picked);
    } catch {
      say(true, `${picked.name} could not be read. Nothing was changed.`);
      return;
    }
    const read = readAppearanceFile(text);
    if ("error" in read) {
      say(true, `${read.error}. Nothing was changed.`);
      return;
    }
    setFile({ name: picked.name, contents: read.contents });
    setChosen(appearanceFields.filter((field) => differs(field, read.contents)));
  }
  function apply() {
    if (!file || !selected.length) return;
    const outcome = importAppearance(importedAppearance(appearance, file.contents, selected));
    if (!outcome.saved) {
      say(true, `Not imported: ${outcome.detail}. Nothing was changed; your Appearance stays as it is.`);
      return;
    }
    setFile(null);
    say(false, `Imported ${selected.length} ${selected.length === 1 ? "setting" : "settings"} from ${file.name}; saved on this device.`);
  }
  const exportedAt = file?.contents.exportedAt && !Number.isNaN(Date.parse(file.contents.exportedAt))
    ? new Date(file.contents.exportedAt).toLocaleString()
    : null;

  return (
    <div className="settings-group appearance-file" aria-label="Appearance file">
      <div className="settings-row">
        <span className="settings-row-main">
          <span className="settings-row-title">Move Appearance to another device</span>
          <span className="settings-row-help">
            A file of the settings above as they are in effect: palette, theme, text size, Agent list, project groups
            and docks. Accounts, permissions, folders and conversations are never in it. Importing shows each setting
            beside yours before anything changes.
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
            aria-label="Choose an Appearance file"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              void choose(picked);
            }}
          />
        </span>
      </div>
      {file && (
        <div className="appearance-file-preview" role="group" aria-label="Import preview">
          <p>
            From {file.name}
            {exportedAt ? `, exported ${exportedAt}` : ""}. Ticked settings are taken from the file; the others stay as
            they are.
          </p>
          <ul>
            {appearanceFields.map((field) => {
              const value = file.contents.values[field];
              const bad = file.contents.invalid.find((item) => item.field === field);
              if (value === undefined && !bad) return null;
              const now = fieldText(field, fieldValue(appearance, field));
              if (value === undefined)
                return (
                  <li key={field} data-state="invalid">
                    <span className="appearance-file-name">{fieldLabels[field]}</span>
                    <span>Now: {now}</span>
                    <span>File: {bad!.value}, not a value Yuzuno accepts; kept as now</span>
                  </li>
                );
              const same = !differs(field, file.contents);
              return (
                <li key={field} data-state={same ? "same" : "differs"}>
                  <label className="appearance-file-name">
                    <input
                      type="checkbox"
                      disabled={same}
                      checked={!same && chosen.includes(field)}
                      onChange={(event) =>
                        setChosen((old) => (event.target.checked ? [...old, field] : old.filter((f) => f !== field)))
                      }
                    />
                    {fieldLabels[field]}
                  </label>
                  <span>Now: {now}</span>
                  <span>{same ? "File: the same" : `File: ${fieldText(field, value)}`}</span>
                </li>
              );
            })}
          </ul>
          {file.contents.unknown.length > 0 && (
            <p className="settings-row-help">
              Not Appearance settings this version knows, so left out: {file.contents.unknown.join(", ")}
            </p>
          )}
          <div className="appearance-file-buttons">
            <button type="button" disabled={!selected.length} onClick={apply}>
              {selected.length ? `Apply ${selected.length} selected` : "Nothing to apply"}
            </button>
            <button
              type="button"
              onClick={() => {
                setFile(null);
                setSaid(null);
              }}
            >
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
  );
}

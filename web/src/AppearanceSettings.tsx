import { Check, Monitor, Moon, Rows2, Rows4, Sun, Type } from "lucide-react";
import {
  appearanceReadable,
  restoreDefaultAppearance,
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
import type { SaveOutcome } from "./preference-save";
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

/** Storage this browser won't even read: nothing shown is a saved choice. */
const UNREADABLE: SaveOutcome = {
  saved: false,
  reason: "blocked",
  detail: "this browser doesn’t let Yuzuno store settings here",
};

/** Appearance, one category of Settings: how Yuzuno looks on this device.
 * It shows the choice in effect, which is the saved one unless this device
 * refused to save it (T-187); then it says so, keeps the choice, and offers
 * to try again or restore the defaults. */
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
        outcome={save ?? (appearanceReadable() ? null : UNREADABLE)}
        scope="this device"
        onRetry={() => saveAppearance(appearance)}
        onRestoreDefaults={restoreDefaultAppearance}
      />
    </section>
  );
}

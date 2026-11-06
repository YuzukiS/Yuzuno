import { useEffect, useState } from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { api, errorText } from "./api";
import { CLAUDE_MODES, CODEX_PRESETS, claudeModeText, codexPermissionText } from "./agent-defaults";
import {
  readExecutorTemplates, saveExecutorTemplates,
  type ExecutorHarness, type ExecutorTemplate, type ExecutorTemplatesView,
} from "./executor-templates";
import { ExecutorSlots } from "./ExecutorSlots";
import { langTag, strings, useLanguage } from "./i18n";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import "./executor-templates.css";

const text = strings({
  title: "Executor templates",
  section: "Executor templates for this Workspace",
  sectionProject: "Executor templates for this project",
  intro: "What an Agent that Core creates for one task is made of: its harness, model and permissions, its name, and instructions it starts with. A dispatch from a template uses a project's own template of that id first, then this Workspace's. Only you change them.",
  introProject: "This project's own templates. A dispatch of one of its tasks uses a template here before the Workspace's of the same id.",
  reading: "Reading templates…",
  none: "No template yet.",
  fromWorkspace: (names: string) => `Also available here, from the Workspace: ${names}.`,
  replaced: "replaced here",
  runsOn: "Runs on",
  thisHost: "This Core host",
  auto: "Choose automatically",
  unknownMachine: (id: string) => `${id} (not in the Machines list)`,
  containedNoCodex: (name: string) => `${name} (keeps Agents contained: no Codex)`,
  machinesUnavailable: (id: string) => `${id} (Machines list unavailable)`,
  machineHelp: "Where its executors run. A dispatch may name another machine.",
  autoHelp: "Core chooses at each dispatch: a machine with a free executor slot first, then the most spare Jobs memory, then CPU. The task shows which it chose and why.",
  opencodeHost: "OpenCode executors run on this Core host.",
  later: (n: number) => `This list also holds ${n} ${n === 1 ? "template" : "templates"} saved by a newer Core. This Core can’t show ${n === 1 ? "it" : "them"}; saving here keeps ${n === 1 ? "it" : "them"} as ${n === 1 ? "it is" : "they are"}.`,
  newTemplate: "New template",
  label: "Label",
  id: "Id",
  idHelp: "Lowercase letters, digits and hyphens. A dispatch names the template by it.",
  harness: "Harness",
  model: "Model",
  inheritModel: "Inherit the default for new Agents",
  effort: "Reasoning effort",
  inheritEffort: "The model’s own",
  permission: "Permissions",
  inheritPermission: "Inherit the default for new Agents",
  opencodeNative: "OpenCode uses its own configuration’s model and permissions.",
  namePattern: "Name",
  namePatternHelp: (pattern: string) => `{task} is the task’s ID, {label} this label. Empty: ${pattern}.`,
  instructions: "Instructions",
  instructionsHelp: (used: number, limit: number) => `Given to the executor with its task’s materials. ${used} of ${limit} bytes.`,
  maxConcurrent: "At most at once",
  maxConcurrentHelp: "At most this many of this template’s executors run at once, within Executors at once. Empty: no limit of its own.",
  maxConcurrentInvalid: (max: number) => `At most at once is a whole number from 1 to ${max}.`,
  add: "Add template",
  remove: (label: string) => `Remove ${label}`,
  save: "Save templates",
  saved: "Saved.",
  unsaved: "Unsaved changes",
  reload: "Reload saved templates",
}, {
  title: "执行者模板",
  section: "此 Workspace 的执行者模板",
  sectionProject: "此项目的执行者模板",
  intro: "Core 为单个任务创建的 Agent 由什么组成：harness、模型与权限、名称，以及它开始时获得的说明。按模板派发时，先用项目自己的同 id 模板，再用此 Workspace 的。只有你能更改。",
  introProject: "此项目自己的模板。派发此项目的任务时，先用这里的模板，再用 Workspace 中同 id 的模板。",
  reading: "正在读取模板…",
  none: "还没有模板。",
  fromWorkspace: (names) => `这里也可用 Workspace 的模板：${names}。`,
  replaced: "已在此替换",
  runsOn: "运行于",
  thisHost: "此 Core 主机",
  auto: "自动选择",
  unknownMachine: (id) => `${id}（不在机器列表中）`,
  containedNoCodex: (name) => `${name}（隔离其 Agent：不运行 Codex）`,
  machinesUnavailable: (id) => `${id}（机器列表不可用）`,
  machineHelp: "其执行者运行的地方。派发时可以指定其他机器。",
  autoHelp: "Core 在每次派发时选择：先选有空闲执行者槽位的机器，再选 Job 剩余内存最多的，然后是 CPU。任务上会显示选了哪台以及原因。",
  opencodeHost: "OpenCode 执行者在此 Core 主机上运行。",
  later: (n) => `此列表还有 ${n} 个由较新的 Core 保存的模板。此 Core 无法显示；在此保存会原样保留它们。`,
  newTemplate: "新模板",
  label: "标签",
  id: "Id",
  idHelp: "小写字母、数字和连字符。派发时用它指名模板。",
  harness: "Harness",
  model: "模型",
  inheritModel: "沿用新 Agent 默认值",
  effort: "推理强度",
  inheritEffort: "模型自己的",
  permission: "权限",
  inheritPermission: "沿用新 Agent 默认值",
  opencodeNative: "OpenCode 使用其自身配置中的模型与权限。",
  namePattern: "名称",
  namePatternHelp: (pattern) => `{task} 是任务 ID，{label} 是此标签。留空：${pattern}。`,
  instructions: "说明",
  instructionsHelp: (used, limit) => `与任务材料一起交给执行者。已用 ${used} / ${limit} 字节。`,
  maxConcurrent: "同时最多",
  maxConcurrentHelp: "此模板的执行者同时最多运行这么多个，且不超过“同时运行的执行者”。留空：没有自己的上限。",
  maxConcurrentInvalid: (max) => `同时最多 是 1 到 ${max} 之间的整数。`,
  add: "添加模板",
  remove: (label) => `移除 ${label}`,
  save: "保存模板",
  saved: "已保存。",
  unsaved: "有未保存的更改",
  reload: "重新读取已保存的模板",
});

type Draft = {
  key: string;
  id: string;
  /** A new template's id follows its label until it is edited. */
  idTouched: boolean;
  label: string;
  harness: ExecutorHarness;
  model: string;
  reasoningEffort: string;
  permission: string;
  namePattern: string;
  instructions: string;
  maxConcurrent: string;
  /** Where its executors run (T-35 S3): "" for this Core host, "auto", or a machine's id. */
  machine: string;
};

let keys = 0;
const draftOf = (t: ExecutorTemplate): Draft => ({
  key: `t${++keys}`, id: t.id, idTouched: true, label: t.label, harness: t.harness, model: t.model ?? "",
  reasoningEffort: t.reasoningEffort ?? "", permission: t.permissionPreset ?? t.permissionMode ?? "",
  namePattern: t.namePattern ?? "", instructions: t.instructions ?? "", maxConcurrent: t.maxConcurrent ? String(t.maxConcurrent) : "",
  machine: t.machineId && t.machineId !== "local" ? t.machineId : "",
});
const slug = (label: string) => label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
/** A new template's id: its label's, or the first free `template-N` for a
 * label with no Latin letter or digit (R2 70093e91). */
const idFor = (label: string, taken: string[]) => {
  const id = slug(label);
  if (id || !label.trim()) return id;
  let n = 1;
  while (taken.includes(`template-${n}`)) n++;
  return `template-${n}`;
};
const set = (value: string) => (value.trim() ? value.trim() : undefined);
/** A template's own limit as the editor takes it: empty (none), or a whole
 * number from 1 to `max`; anything else (a negative number, a fraction) is
 * no limit Core would take (null). */
const atOnce = (value: string, max: number): number | undefined | null => {
  const v = value.trim();
  if (!v) return undefined;
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
};
/** As Core takes it: only what this harness uses, unset left out. */
const templateOf = (d: Draft): ExecutorTemplate => {
  const template: ExecutorTemplate = { id: d.id.trim(), label: d.label.trim(), harness: d.harness };
  const pattern = set(d.namePattern);
  if (pattern) template.namePattern = pattern;
  if (d.harness !== "opencode" && set(d.model)) template.model = set(d.model);
  // An effort goes with the model it is for.
  if (d.harness === "codex" && set(d.model) && set(d.reasoningEffort)) template.reasoningEffort = set(d.reasoningEffort);
  if (d.harness === "codex" && d.permission) template.permissionPreset = d.permission;
  if (d.harness === "claude" && d.permission) template.permissionMode = d.permission;
  if (d.instructions.trim()) template.instructions = d.instructions;
  const limit = atOnce(d.maxConcurrent, Number.MAX_SAFE_INTEGER);
  if (limit) template.maxConcurrent = limit;
  // Kept as saved (T-35 S3): an OpenCode template runs on this Core host.
  if (d.machine && d.harness !== "opencode") template.machineId = d.machine;
  return template;
};
/** The machines a template's executors may run on, by harness: this Core
 * host always; an SSH machine for Codex unless it keeps its Agents contained,
 * and for Claude Code; `auto` for both. OpenCode runs on this Core host only,
 * where `auto` would always choose (T-35 S3). */
const machineOptions = (harness: ExecutorHarness, machines: WorkspaceMachine[]) =>
  harness === "opencode" ? [] : machines.filter((m) => m.kind === "ssh" && !(harness === "codex" && m.contained));
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** The Workspace's executor templates, or with `projectId` that project's own
 * (T-34). The user's setting only: no Agent tool changes templates. */
export function ExecutorTemplates({ active, projectId, disabled = false }: { active: boolean; projectId?: string; disabled?: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<ExecutorTemplatesView | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [reload, setReload] = useState(0);
  // The registered machines a template may name; none read, only this Core host and auto.
  const [machines, setMachines] = useState<WorkspaceMachine[]>([]);
  // Whether that list has been read: a saved machine is called missing only
  // from a list that was read and lacks it (#645 R1 e4931a53).
  const [machinesRead, setMachinesRead] = useState<"reading" | "read" | "failed">("reading");
  const own = (from: ExecutorTemplatesView) => (projectId ? from.project ?? { version: 0, templates: [] } : from.workspace);
  // A saved machine the select doesn't offer. Before the list is read it is
  // just its id; a failed read says so. Once read, a listed machine is one this
  // harness can't use (Codex where Agents are kept contained, #645 R1 1342ccdd);
  // an unlisted one is missing.
  const savedMachine = (id: string) => {
    if (machinesRead === "reading") return id;
    if (machinesRead === "failed") return t.machinesUnavailable(id);
    const listed = machines.find(m => m.id === id);
    return listed ? t.containedNoCodex(listed.name) : t.unknownMachine(id);
  };
  const adopt = (next: ExecutorTemplatesView) => {
    setView(next);
    setDrafts(own(next).templates.map(draftOf));
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setView(null);
    setError("");
    readExecutorTemplates(controller.signal, projectId).then(next => {
      if (!controller.signal.aborted) adopt(next);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    setMachinesRead("reading");
    api<{ machines: WorkspaceMachine[] }>("/machines", { signal: controller.signal }).then(list => {
      if (controller.signal.aborted) return;
      setMachines(Array.isArray(list.machines) ? list.machines : []);
      setMachinesRead("read");
    }).catch(() => {
      // Only this Core host and auto are offered then; a saved machine says why it isn't.
      if (!controller.signal.aborted) setMachinesRead("failed");
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId, reload]);
  // Compared as this client writes them: Core's field order may differ.
  const changed = !!view && JSON.stringify(drafts.map(templateOf)) !== JSON.stringify(own(view).templates.map(saved => templateOf(draftOf(saved))));
  const locked = disabled || busy;
  // A template's own limit Core wouldn't take holds the save, said at its field.
  const badLimit = (d: Draft) => !!view && atOnce(d.maxConcurrent, view.limits.maxConcurrent) === null;
  const invalid = drafts.some(badLimit);
  const edit = (key: string, change: Partial<Draft>) => {
    setDone(false);
    setDrafts(list => list.map(d => {
      if (d.key !== key) return d;
      const next = { ...d, ...change };
      if (change.label !== undefined && !d.idTouched) next.id = idFor(change.label, list.filter(o => o.key !== key).map(o => o.id));
      // Permissions differ per harness: a change of harness starts them over.
      if (change.harness && change.harness !== d.harness) next.permission = "";
      // A machine the new harness can't run on goes back to this Core host:
      // OpenCode runs only there, Codex on no machine that keeps Agents contained.
      if (change.harness === "opencode"
        || (change.harness === "codex" && machines.some(m => m.id === next.machine && m.contained))) next.machine = "";
      // An effort is for its model: clearing the model clears it too (R1 de0ae592).
      if (change.model !== undefined && !change.model.trim()) next.reasoningEffort = "";
      return next;
    }));
  };
  async function save() {
    if (!view) return;
    setBusy(true);
    setError("");
    try {
      adopt(await saveExecutorTemplates(own(view).version, drafts.map(templateOf), projectId));
      setDone(true);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  const inherited = projectId && view ? view.workspace.templates : [];
  const replaced = (id: string) => drafts.some(d => d.id.trim() === id);
  return (
    <section
      id={projectId ? undefined : "settings-executor-templates"}
      className="settings-section executor-templates-settings"
      aria-label={projectId ? t.sectionProject : t.section}
      lang={langTag(language)}
    >
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{projectId ? t.introProject : t.intro}</p>
        </div>
      </header>
      <ExecutorSlots active={active} projectId={projectId} disabled={disabled} />
      {active && !view && !error && <p className="settings-row-help" role="status">{t.reading}</p>}
      {view && <>
        {inherited.length > 0 && (
          <p className="settings-row-help executor-templates-inherited">
            {t.fromWorkspace(inherited.map(w => (replaced(w.id) ? `${w.label} (${t.replaced})` : w.label)).join(" · "))}
          </p>
        )}
        {(own(view).laterTemplates ?? 0) > 0 && <p className="settings-row-help">{t.later(own(view).laterTemplates ?? 0)}</p>}
        {drafts.length === 0 && <p className="settings-row-help">{t.none}</p>}
        {drafts.map(d => {
          const name = d.label.trim() || t.newTemplate;
          return (
            <fieldset key={d.key} className="settings-group executor-template" aria-label={name} disabled={locked}>
              <legend>{name}</legend>
              <label className="settings-row">
                <span className="settings-row-title">{t.label}</span>
                <input className="settings-input" aria-label={t.label} value={d.label} maxLength={80}
                  onChange={e => edit(d.key, { label: e.target.value })} />
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.id}</span>
                  <span className="settings-row-help">{t.idHelp}</span>
                </span>
                <input className="settings-input" aria-label={t.id} value={d.id} maxLength={48}
                  onChange={e => edit(d.key, { id: e.target.value, idTouched: true })} />
              </label>
              <label className="settings-row">
                <span className="settings-row-title">{t.harness}</span>
                <select className="settings-select" aria-label={t.harness} value={d.harness}
                  onChange={e => edit(d.key, { harness: e.target.value as ExecutorHarness })}>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude Code</option>
                  {(view.opencodeEnabled || d.harness === "opencode") && <option value="opencode">OpenCode</option>}
                </select>
              </label>
              {d.harness === "opencode" ? <p className="settings-row-help">{t.opencodeNative}</p> : <>
                <label className="settings-row">
                  <span className="settings-row-title">{t.model}</span>
                  <input className="settings-input" aria-label={t.model} value={d.model} placeholder={t.inheritModel}
                    onChange={e => edit(d.key, { model: e.target.value })} />
                </label>
                {d.harness === "codex" && (
                  <label className="settings-row">
                    <span className="settings-row-title">{t.effort}</span>
                    <input className="settings-input" aria-label={t.effort} value={d.reasoningEffort} placeholder={t.inheritEffort}
                      disabled={locked || !d.model.trim()} onChange={e => edit(d.key, { reasoningEffort: e.target.value })} />
                  </label>
                )}
                <label className="settings-row">
                  <span className="settings-row-title">{t.permission}</span>
                  <select className="settings-select" aria-label={t.permission} value={d.permission}
                    onChange={e => edit(d.key, { permission: e.target.value })}>
                    <option value="">{t.inheritPermission}</option>
                    {(d.harness === "codex" ? CODEX_PRESETS : CLAUDE_MODES).map(value => (
                      <option key={value} value={value}>
                        {d.harness === "codex" ? codexPermissionText(value, language) : claudeModeText(value, language)}
                      </option>
                    ))}
                  </select>
                </label>
              </>}
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.runsOn}</span>
                  <span className="settings-row-help">
                    {d.harness === "opencode" ? t.opencodeHost : d.machine === "auto" ? t.autoHelp : t.machineHelp}
                  </span>
                </span>
                <select className="settings-select" aria-label={t.runsOn} value={d.harness === "opencode" ? "" : d.machine}
                  disabled={locked || d.harness === "opencode"} onChange={e => edit(d.key, { machine: e.target.value })}>
                  <option value="">{t.thisHost}</option>
                  {machineOptions(d.harness, machines).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  {d.harness !== "opencode" && d.machine && d.machine !== "auto" && !machineOptions(d.harness, machines).some(m => m.id === d.machine) && (
                    // Kept as saved, and named for what is known of it.
                    <option value={d.machine}>{savedMachine(d.machine)}</option>
                  )}
                  {d.harness !== "opencode" && <option value="auto">{t.auto}</option>}
                </select>
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.namePattern}</span>
                  <span className="settings-row-help">{t.namePatternHelp(view.defaultNamePattern)}</span>
                </span>
                <input className="settings-input" aria-label={t.namePattern} value={d.namePattern} maxLength={120}
                  placeholder={view.defaultNamePattern} onChange={e => edit(d.key, { namePattern: e.target.value })} />
              </label>
              <label className="settings-row executor-template-instructions">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.instructions}</span>
                  <span className="settings-row-help">{t.instructionsHelp(bytes(d.instructions), view.limits.instructionsBytes)}</span>
                </span>
                <textarea className="settings-textarea" aria-label={t.instructions} rows={4} value={d.instructions}
                  onChange={e => edit(d.key, { instructions: e.target.value })} />
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.maxConcurrent}</span>
                  <span className={badLimit(d) ? "inline-error" : "settings-row-help"}>
                    {badLimit(d) ? t.maxConcurrentInvalid(view.limits.maxConcurrent) : t.maxConcurrentHelp}
                  </span>
                </span>
                <input className="settings-input" aria-label={t.maxConcurrent} type="number" inputMode="numeric" step={1}
                  min={1} max={view.limits.maxConcurrent} aria-invalid={badLimit(d) || undefined}
                  value={d.maxConcurrent} onChange={e => edit(d.key, { maxConcurrent: e.target.value })} />
              </label>
              <button type="button" className="quiet-button" onClick={() => { setDone(false); setDrafts(list => list.filter(x => x.key !== d.key)); }}>
                <Trash2 size={13} /> {t.remove(name)}
              </button>
            </fieldset>
          );
        })}
        <div className="executor-templates-actions">
          <button type="button" className="quiet-button" disabled={locked || drafts.length >= view.limits.templates}
            onClick={() => { setDone(false); setDrafts(list => [...list, { ...draftOf({ id: "", label: "", harness: "codex" }), idTouched: false }]); }}>
            <Plus size={13} /> {t.add}
          </button>
          <button type="button" className="secondary-button" disabled={locked || !changed || invalid} onClick={() => void save()}>
            {busy && <LoaderCircle size={13} className="spin" />} {t.save}
          </button>
          {changed ? <span className="settings-row-help">{t.unsaved}</span> : done && <span className="settings-row-help" role="status">{t.saved}</span>}
        </div>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reload}</button>}
    </section>
  );
}

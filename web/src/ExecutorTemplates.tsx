import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Check, ChevronLeft, ChevronRight, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { api, errorText } from "./api";
import { CLAUDE_MODES, CODEX_PRESETS, claudeModeText, codexPermissionText } from "./agent-defaults";
import {
  MAX_STEPS, PR_STEP_KINDS, STEP_KINDS, defaultSteps, presetsIn, readExecutorTemplates, saveExecutorTemplates,
  type DeliveryMode, type ExecutorHarness, type ExecutorPreset, type ExecutorTemplate, type ExecutorTemplatesView,
  type StepKind, type TemplateChange, type TemplateStep,
} from "./executor-templates";
import { ExecutorSlots } from "./ExecutorSlots";
import { moment } from "./conversation-time";
import { langTag, strings, useLanguage, type Language } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import { ChoiceCards } from "./SettingsChoices";
import { timeFormatter, useTimeDisplay } from "./time-preferences";
import "./executor-templates.css";

const text = strings({
  title: "Executor templates",
  section: "Executor templates for this Workspace",
  intro: "Named kinds of executor for every project: what an Agent that Core creates for one task is made of. A dispatch can name one; without one, Core makes a general executor from the defaults for new Agents. Only you change them.",
  reading: "Reading templates…",
  none: "No template yet: a dispatch makes a general executor.",
  addPresets: "Add presets",
  presetsTitle: "Add presets",
  presetsHelp: (harness: string) => `Choose the presets to add. Each becomes an unsaved template for ${harness}, the default for new Agents, that you can change; nothing is saved until you save.`,
  presetTaken: "One with this id is in the list: it is added under another id.",
  addChosen: (n: number) => (n === 1 ? "Add 1 preset" : `Add ${n} presets`),
  room: (n: number, limit: number) => `Room for ${n} more ${n === 1 ? "template" : "templates"}: the list holds at most ${limit}.`,
  cancel: "Cancel",
  list: "Templates",
  backTo: "Back to Executor templates",
  needsFix: "Needs a fix",
  pageIntro: "A kind of executor a dispatch can name by its id.",
  nameAndPurpose: "Name and purpose",
  howItRuns: "How it runs",
  whereItRuns: "Where it runs",
  removeTitle: "Remove this template",
  removeHelp: "It leaves the list when the page is saved; a dispatch can no longer name it.",
  origin: (project: string, id: string) => `Copied from the project ${project}, where its id was ${id}.`,
  lastChanged: "Last changed: ",
  you: "You",
  labelNeeded: "A template needs a label.",
  projectTitle: "Executors",
  projectIntro: "Executor templates are kept for the whole Workspace, in Settings under Executor templates. Here: how many of this project’s executors run at once.",
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
  whenToChoose: "When to choose it",
  whenToChooseHelp: "One line a lead reads to choose this template. Not sent to the executor.",
  model: "Model",
  inheritModel: "Inherit the default for new Agents",
  modelHint: (hint: string) => `The preset suggests: ${hint}`,
  effort: "Reasoning effort",
  inheritEffort: "The model’s own",
  permission: "Permissions",
  inheritPermission: "Inherit the default for new Agents",
  opencodeNative: "OpenCode uses its own configuration’s model and permissions.",
  namePattern: "Name",
  namePatternHelp: (pattern: string) => `{task} is the task’s ID, {label} this label. Empty: ${pattern}.`,
  instructions: "Instructions",
  instructionsHelp: (used: number, limit: number) => `Given to the executor with its task’s materials. ${used} of ${limit} bytes.`,
  delivery: "Delivery",
  deliveryHelp: "How the work is delivered. The executor is told in its materials and mail; Core doesn’t hold it to it.",
  deliveries: {
    pr: ["Pull request", "Review, CI and merge follow."],
    "direct-commit": ["Direct commit", "Committed without a pull request, as to a results repository."],
    none: ["No repository change", "The result is the deliverable: an answer, a memo, a check."],
  } as Record<DeliveryMode, [string, string]>,
  steps: "Steps",
  stepsHelp: "What its executors do, in order. Descriptive for now: the executor reads them, and Core doesn’t track them.",
  defaultSteps: "Its delivery’s default steps:",
  customize: "Change the steps",
  useDefault: "Use the default steps",
  addStep: "Add a step",
  step: (n: number) => `Step ${n}`,
  stepKind: (n: number) => `Step ${n}: kind`,
  stepLabel: (n: number) => `Step ${n}: label`,
  stepRounds: (n: number) => `Step ${n}: rounds`,
  stepApprover: (n: number) => `Step ${n}: approver`,
  moveUp: (n: number) => `Move step ${n} up`,
  moveDown: (n: number) => `Move step ${n} down`,
  removeStep: (n: number) => `Remove step ${n}`,
  oneRound: "1 round",
  twoRounds: "2 rounds",
  approvers: { user: "You", lead: "A lead", either: "You or a lead" } as Record<"user" | "lead" | "either", string>,
  kinds: {
    materials: "Read the materials", work: "Work", result: "Submit a result", gate: "Wait for approval", job: "Run a Job",
    pr: "Pull request", review: "Review", ci: "CI", merge: "Merge",
  } as Record<StepKind, string>,
  kindNeedsPr: "Only for delivery by pull request.",
  stepsNeeded: "Add a step, or use the default steps.",
  add: "Add template",
  remove: (label: string) => `Remove ${label}`,
  save: "Save templates",
  saved: "Saved.",
  unsaved: "Unsaved changes",
  reload: "Reload saved templates",
}, {
  title: "执行者模板",
  section: "此 Workspace 的执行者模板",
  intro: "所有项目共用的、有名字的执行者种类：Core 为单个任务创建的 Agent 由什么组成。派发时可以指定一个；不指定时，Core 按新 Agent 的默认设置创建通用执行者。只有你能更改。",
  reading: "正在读取模板…",
  none: "还没有模板：派发时会创建通用执行者。",
  addPresets: "添加预设",
  presetsTitle: "添加预设",
  presetsHelp: (harness) => `选择要添加的预设。每个都会成为一个未保存的 ${harness} 模板（新 Agent 的默认 Harness），可以再改；保存之前什么都不会写入。`,
  presetTaken: "列表里已有这个 id：添加时会换一个 id。",
  addChosen: (n) => `添加 ${n} 个预设`,
  room: (n, limit) => `还能添加 ${n} 个模板：列表最多 ${limit} 个。`,
  cancel: "取消",
  list: "模板",
  backTo: "返回执行者模板",
  needsFix: "需要修改",
  pageIntro: "派发时可以用 id 指名的一种执行者。",
  nameAndPurpose: "名称与用途",
  howItRuns: "运行方式",
  whereItRuns: "运行在哪里",
  removeTitle: "移除此模板",
  removeHelp: "保存此页后它就从列表中移除；派发时不能再指名它。",
  origin: (project, id) => `从项目 ${project} 复制而来，原 id 是 ${id}。`,
  lastChanged: "上次修改：",
  you: "你",
  labelNeeded: "模板需要一个标签。",
  projectTitle: "执行者",
  projectIntro: "执行者模板对整个 Workspace 通用，在设置的“执行者模板”中。这里设置此项目的执行者同时最多运行几个。",
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
  whenToChoose: "何时选它",
  whenToChooseHelp: "一行字，负责人据此选模板。不会发给执行者。",
  model: "模型",
  inheritModel: "沿用新 Agent 默认值",
  modelHint: (hint) => `预设建议：${hint}`,
  effort: "推理强度",
  inheritEffort: "模型自己的",
  permission: "权限",
  inheritPermission: "沿用新 Agent 默认值",
  opencodeNative: "OpenCode 使用其自身配置中的模型与权限。",
  namePattern: "名称",
  namePatternHelp: (pattern) => `{task} 是任务 ID，{label} 是此标签。留空：${pattern}。`,
  instructions: "说明",
  instructionsHelp: (used, limit) => `与任务材料一起交给执行者。已用 ${used} / ${limit} 字节。`,
  delivery: "交付方式",
  deliveryHelp: "工作怎么交付。执行者会在材料和派发邮件里看到；Core 不强制。",
  deliveries: {
    pr: ["通过 PR", "之后是审查、CI 和合并。"],
    "direct-commit": ["直接提交", "不开 PR 直接提交，例如提交到结果仓库。"],
    none: ["不改仓库", "结果本身就是交付物：一个回答、一份备忘录、一次核查。"],
  },
  steps: "步骤",
  stepsHelp: "执行者按顺序做的事。目前只是说明：执行者会读到，Core 不跟踪。",
  defaultSteps: "按交付方式的默认步骤：",
  customize: "修改步骤",
  useDefault: "使用默认步骤",
  addStep: "添加步骤",
  step: (n) => `第 ${n} 步`,
  stepKind: (n) => `第 ${n} 步：类型`,
  stepLabel: (n) => `第 ${n} 步：说明`,
  stepRounds: (n) => `第 ${n} 步：轮数`,
  stepApprover: (n) => `第 ${n} 步：批准人`,
  moveUp: (n) => `第 ${n} 步上移`,
  moveDown: (n) => `第 ${n} 步下移`,
  removeStep: (n) => `移除第 ${n} 步`,
  oneRound: "1 轮",
  twoRounds: "2 轮",
  approvers: { user: "你", lead: "负责人", either: "你或负责人" },
  kinds: {
    materials: "读材料", work: "工作", result: "提交结果", gate: "等批准", job: "跑 Job",
    pr: "PR", review: "审查", ci: "CI", merge: "合并",
  },
  kindNeedsPr: "只用于通过 PR 交付。",
  stepsNeeded: "添加一个步骤，或使用默认步骤。",
  add: "添加模板",
  remove: (label) => `移除 ${label}`,
  save: "保存模板",
  saved: "已保存。",
  unsaved: "有未保存的更改",
  reload: "重新读取已保存的模板",
});
type Text = ReturnType<typeof text>;

/** A step as the editor holds it: "" for an unset field. */
type DraftStep = { key: string; kind: StepKind; label: string; rounds: "" | "1" | "2"; approver: "" | "user" | "lead" | "either" };

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
  /** Where its executors run (T-35 S3): "" for this Core host, "auto", or a machine's id. */
  machine: string;
  /** Kept as saved: where a copied template came from (YN-2 S2). */
  origin?: ExecutorTemplate["origin"];
  /** The id it was saved under, whose last change it shows (YN-24's `lastModified`); none for a new one. */
  savedId?: string;
  /** YN-23: "" is unset, which is "pr". */
  deliveryMode: "" | DeliveryMode;
  /** null: its delivery's default steps. */
  steps: DraftStep[] | null;
  whenToChoose: string;
  /** From the preset it was made from, never saved: its model hint, and its permission per harness. */
  preset?: { modelHint?: string; permissions?: ExecutorPreset["permissions"] };
};

let keys = 0;
const stepOf = (s: TemplateStep): DraftStep => ({
  key: `s${++keys}`, kind: s.kind, label: s.label ?? "",
  rounds: s.rounds === 1 || s.rounds === 2 ? String(s.rounds) as "1" | "2" : "",
  approver: s.approver ?? "",
});
const draftOf = (t: ExecutorTemplate): Draft => ({
  key: `t${++keys}`, id: t.id, idTouched: true, label: t.label, harness: t.harness, model: t.model ?? "",
  reasoningEffort: t.reasoningEffort ?? "", permission: t.permissionPreset ?? t.permissionMode ?? "",
  namePattern: t.namePattern ?? "", instructions: t.instructions ?? "",
  machine: t.machineId && t.machineId !== "local" ? t.machineId : "",
  ...(t.origin ? { origin: t.origin } : {}),
  deliveryMode: t.deliveryMode ?? "",
  steps: t.steps ? t.steps.map(stepOf) : null,
  whenToChoose: t.whenToChoose ?? "",
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
/** `id`, or the first `id-2`, `id-3`… no other template has. */
const freeId = (id: string, taken: string[]) => {
  let free = id;
  for (let n = 2; taken.includes(free); n++) free = `${id.slice(0, 48 - String(n).length - 1)}-${n}`;
  return free;
};
const set = (value: string) => (value.trim() ? value.trim() : undefined);
const stepTemplate = (s: DraftStep): TemplateStep => ({
  kind: s.kind,
  ...(set(s.label) ? { label: set(s.label) } : {}),
  // Only where Core takes them: rounds on a review, an approver on a gate.
  ...(s.kind === "review" && s.rounds ? { rounds: Number(s.rounds) } : {}),
  ...(s.kind === "gate" && s.approver ? { approver: s.approver } : {}),
});
/** As Core takes it: only what this harness uses, unset left out. A
 * template has no limit of its own (T-43, the user's 2026-11-07 decision:
 * one limit per machine), so one saved before is dropped at the next save. */
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
  // Kept as saved (T-35 S3): an OpenCode template runs on this Core host.
  if (d.machine && d.harness !== "opencode") template.machineId = d.machine;
  if (d.origin) template.origin = d.origin;
  if (d.deliveryMode) template.deliveryMode = d.deliveryMode;
  if (d.steps) template.steps = d.steps.map(stepTemplate);
  if (set(d.whenToChoose)) template.whenToChoose = set(d.whenToChoose);
  return template;
};
/** A step this template's delivery can't have: pr, review, ci and merge are for pull requests only. */
const stepRefused = (d: Draft, s: DraftStep) => (d.deliveryMode || "pr") !== "pr" && PR_STEP_KINDS.includes(s.kind);
const stepsInvalid = (d: Draft) => !!d.steps && (d.steps.length === 0 || d.steps.some((s) => stepRefused(d, s)));
/** The machines a template's executors may run on, by harness: this Core
 * host always; an SSH machine for Codex unless it keeps its Agents contained,
 * and for Claude Code; `auto` for both. OpenCode runs on this Core host only,
 * where `auto` would always choose (T-35 S3). */
const machineOptions = (harness: ExecutorHarness, machines: WorkspaceMachine[]) =>
  harness === "opencode" ? [] : machines.filter((m) => m.kind === "ssh" && !(harness === "codex" && m.contained));
const bytes = (value: string) => new TextEncoder().encode(value).length;
const harnessName = (h: ExecutorHarness) => (h === "codex" ? "Codex" : h === "claude" ? "Claude Code" : "OpenCode");
/** A preset's permission for `harness`, if it has one. */
const presetPermission = (preset: Draft["preset"], harness: ExecutorHarness) =>
  harness === "opencode" ? "" : (preset?.permissions?.[harness] ?? "");
/** A template made from a preset, for `harness`, under a free id. */
const draftFromPreset = (p: ExecutorPreset, harness: ExecutorHarness, id: string): Draft => ({
  ...draftOf({
    id, label: p.label, harness,
    ...(p.instructions ? { instructions: p.instructions } : {}),
    ...(p.deliveryMode ? { deliveryMode: p.deliveryMode } : {}),
    ...(p.steps ? { steps: p.steps } : {}),
    ...(p.whenToChoose ? { whenToChoose: p.whenToChoose } : {}),
  }),
  permission: presetPermission({ permissions: p.permissions }, harness),
  preset: { modelHint: p.modelHint, permissions: p.permissions },
});
/** A step line as the default steps show it. */
const stepsLine = (steps: TemplateStep[], t: Text) => steps.map((s) => t.kinds[s.kind]).join(" → ");

/** A project's executors on its page (YN-2 S2): its own Executors at once.
 * Templates are the Workspace's, in Settings. */
export function ProjectExecutors({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const language = useLanguage();
  const t = text(language);
  return (
    <section className="settings-section executor-templates-settings" aria-label={t.projectTitle} lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.projectTitle}</h3>
          <p>{t.projectIntro}</p>
        </div>
      </header>
      <ExecutorSlots active projectId={projectId} disabled={disabled} />
    </section>
  );
}

/** Choose presets to add (YN-23): each chosen one becomes an unsaved draft.
 * `room` is how many more templates the list takes; no more can be chosen
 * (#742 R1 3ec18555: past it, chosen presets were left out unsaid). */
function PresetPicker({ presets, taken, room, limit, harness, t, onAdd, onCancel }: {
  presets: ExecutorPreset[]; taken: string[]; room: number; limit: number; harness: ExecutorHarness; t: Text;
  onAdd: (chosen: ExecutorPreset[]) => void; onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const full = chosen.length >= room;
  const toggle = (id: string) => setChosen((list) => (list.includes(id) ? list.filter((c) => c !== id) : [...list, id]));
  return (
    <div className="settings-group appearance-group executor-presets" role="group" aria-label={t.presetsTitle}>
      <fieldset className="appearance-field">
        <legend>{t.presetsTitle}</legend>
        <p className="appearance-help">{t.presetsHelp(harnessName(harness))}</p>
        {room < presets.length && <p className="appearance-help executor-presets-room" role="status">{t.room(Math.max(room, 0), limit)}</p>}
        <div className="theme-options settings-choice-cards executor-preset-options">
          {presets.map((p) => (
            <label key={p.id} className="theme-choice settings-choice executor-preset-choice">
              <input type="checkbox" value={p.id} checked={chosen.includes(p.id)} disabled={full && !chosen.includes(p.id)}
                onChange={() => toggle(p.id)} />
              <span className="theme-choice-name">
                {p.label}
                <Check size={13} className="theme-selected" aria-hidden="true" />
              </span>
              {p.whenToChoose && <small>{p.whenToChoose}</small>}
              <small className="executor-preset-meta">
                {t.deliveries[p.deliveryMode ?? "pr"][0]} · {stepsLine(p.steps ?? defaultSteps(p.deliveryMode), t)}
              </small>
              {taken.includes(p.id) && <small className="executor-preset-meta">{t.presetTaken}</small>}
            </label>
          ))}
        </div>
        <div className="executor-templates-actions executor-presets-actions">
          <button type="button" className="secondary-button" disabled={chosen.length === 0}
            onClick={() => onAdd(presets.filter((p) => chosen.includes(p.id)))}>
            <Plus size={13} /> {t.addChosen(chosen.length)}
          </button>
          <button type="button" className="quiet-button" onClick={onCancel}><X size={13} /> {t.cancel}</button>
        </div>
      </fieldset>
    </div>
  );
}

/** A template's steps (YN-23): its delivery's default, or its own rows. */
function StepsField({ d, t, edit }: { d: Draft; t: Text; edit: (change: Partial<Draft>) => void }) {
  const steps = d.steps;
  const change = (key: string, next: Partial<DraftStep>) =>
    edit({ steps: (steps ?? []).map((s) => (s.key === key ? { ...s, ...next } : s)) });
  const move = (from: number, to: number) => {
    const list = [...(steps ?? [])];
    const [step] = list.splice(from, 1);
    list.splice(to, 0, step);
    edit({ steps: list });
  };
  return (
    <fieldset className="appearance-field executor-template-steps">
      <legend>{t.steps}</legend>
      <p className="appearance-help">{t.stepsHelp}</p>
      {!steps ? (
        <div className="executor-steps-default">
          <p className="settings-row-help">{t.defaultSteps} {stepsLine(defaultSteps(d.deliveryMode || "pr"), t)}</p>
          <button type="button" className="quiet-button" onClick={() => edit({ steps: defaultSteps(d.deliveryMode || "pr").map(stepOf) })}>
            {t.customize}
          </button>
        </div>
      ) : (
        <>
          <ol className="executor-steps">
            {steps.map((s, i) => {
              const n = i + 1;
              const refused = stepRefused(d, s);
              return (
                <li key={s.key} className="executor-step">
                  <span className="executor-step-number" aria-hidden="true">{n}</span>
                  <select className="settings-select" aria-label={t.stepKind(n)} value={s.kind} aria-invalid={refused || undefined}
                    onChange={(e) => change(s.key, { kind: e.target.value as StepKind })}>
                    {STEP_KINDS.map((kind) => <option key={kind} value={kind}>{t.kinds[kind]}</option>)}
                  </select>
                  <input className="settings-input" aria-label={t.stepLabel(n)} value={s.label} maxLength={60} placeholder={t.kinds[s.kind]}
                    onChange={(e) => change(s.key, { label: e.target.value })} />
                  {s.kind === "review" && (
                    <select className="settings-select" aria-label={t.stepRounds(n)} value={s.rounds || "1"}
                      onChange={(e) => change(s.key, { rounds: e.target.value as "1" | "2" })}>
                      <option value="1">{t.oneRound}</option>
                      <option value="2">{t.twoRounds}</option>
                    </select>
                  )}
                  {s.kind === "gate" && (
                    <select className="settings-select" aria-label={t.stepApprover(n)} value={s.approver || "user"}
                      onChange={(e) => change(s.key, { approver: e.target.value as DraftStep["approver"] })}>
                      {(["user", "lead", "either"] as const).map((a) => <option key={a} value={a}>{t.approvers[a]}</option>)}
                    </select>
                  )}
                  <span className="executor-step-actions">
                    <button type="button" className="icon-button" aria-label={t.moveUp(n)} title={t.moveUp(n)} disabled={i === 0} onClick={() => move(i, i - 1)}>
                      <ArrowUp size={13} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t.moveDown(n)} title={t.moveDown(n)} disabled={i === steps.length - 1} onClick={() => move(i, i + 1)}>
                      <ArrowDown size={13} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t.removeStep(n)} title={t.removeStep(n)}
                      onClick={() => edit({ steps: steps.filter((x) => x.key !== s.key) })}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                  {refused && <span className="inline-error executor-step-error">{t.kindNeedsPr}</span>}
                </li>
              );
            })}
          </ol>
          {steps.length === 0 && <p className="inline-error">{t.stepsNeeded}</p>}
          <div className="executor-templates-actions">
            <button type="button" className="quiet-button" disabled={steps.length >= MAX_STEPS}
              onClick={() => edit({ steps: [...steps, stepOf({ kind: "work" })] })}>
              <Plus size={13} /> {t.addStep}
            </button>
            <button type="button" className="quiet-button" onClick={() => edit({ steps: null })}>{t.useDefault}</button>
          </div>
        </>
      )}
    </fieldset>
  );
}

/** The Workspace's executor templates (T-34; the only list since YN-2 S2):
 * a list, and a page for each template (YN-8 S5b). The whole list is still
 * saved at once, against the version read, by the page's save bar.
 * The user's setting only: no Agent tool changes templates. */
export function ExecutorTemplates({ active, disabled = false }: { active: boolean; disabled?: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<ExecutorTemplatesView | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [reload, setReload] = useState(0);
  const [picking, setPicking] = useState(false);
  // The template whose page is shown, by its draft's key; none: the list.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(false);
  // The registered machines a template may name; none read, only this Core host and auto.
  const [machines, setMachines] = useState<WorkspaceMachine[]>([]);
  // Whether that list has been read: a saved machine is called missing only
  // from a list that was read and lacks it (#645 R1 e4931a53).
  const [machinesRead, setMachinesRead] = useState<"reading" | "read" | "failed">("reading");
  const own = (from: ExecutorTemplatesView) => from.workspace;
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
  // A template saved under the id of one in the list keeps its key, so its
  // page stays open across a save; one no longer there closes it.
  const adopt = (next: ExecutorTemplatesView) => {
    setView(next);
    setDrafts(old => own(next).templates.map(saved => {
      const was = old.find(d => d.id.trim() === saved.id);
      return { ...draftOf(saved), savedId: saved.id, ...(was ? { key: was.key } : {}) };
    }));
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setView(null);
    setError("");
    readExecutorTemplates(controller.signal).then(next => {
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
  }, [active, reload]);
  // Compared as this client writes them: Core's field order may differ.
  const changed = !!view && JSON.stringify(drafts.map(templateOf)) !== JSON.stringify(own(view).templates.map(saved => templateOf(draftOf(saved))));
  const locked = disabled || busy;
  const noLabel = (d: Draft) => !d.label.trim();
  const needsFix = (d: Draft) => noLabel(d) || stepsInvalid(d);
  const invalid = drafts.some(needsFix);
  const open = openKey ? drafts.find(d => d.key === openKey) : undefined;
  // Another view starts at its top, its title focused; the first keeps the focus Settings gave the page.
  const shownKey = open?.key ?? null;
  useEffect(() => {
    if (!shown.current) {
      shown.current = true;
      return;
    }
    heading.current?.closest(".settings-pane")?.scrollTo?.({ top: 0 });
    heading.current?.focus();
  }, [shownKey]);
  const edit = (key: string, change: Partial<Draft>) => {
    setDone(false);
    setDrafts(list => list.map(d => {
      if (d.key !== key) return d;
      const next = { ...d, ...change };
      if (change.label !== undefined && !d.idTouched) next.id = idFor(change.label, list.filter(o => o.key !== key).map(o => o.id));
      // Permissions differ per harness: a change of harness starts them over,
      // with a preset's own for the new harness if it has one.
      if (change.harness && change.harness !== d.harness) next.permission = presetPermission(d.preset, change.harness);
      // A machine the new harness can't run on goes back to this Core host:
      // OpenCode runs only there, Codex on no machine that keeps Agents contained.
      if (change.harness === "opencode"
        || (change.harness === "codex" && machines.some(m => m.id === next.machine && m.contained))) next.machine = "";
      // An effort is for its model: clearing the model clears it too (R1 de0ae592).
      if (change.model !== undefined && !change.model.trim()) next.reasoningEffort = "";
      return next;
    }));
  };
  async function save(): Promise<boolean> {
    if (!view) return false;
    setBusy(true);
    setError("");
    try {
      adopt(await saveExecutorTemplates(own(view).version, drafts.map(templateOf)));
      setDone(true);
      return true;
    } catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(false); }
  }
  // On Settings › Executors the change joins the page's save bar (YN-8),
  // held while a template's label or steps can't be saved; alone it keeps its Save.
  const inBar = useSaveBarPart("executor-templates", changed && view && !disabled ? {
    ready: !invalid,
    save,
    discard: () => { setError(""); setDone(false); setPicking(false); adopt(view); },
  } : null);
  // The harness a preset's template gets: the default for new Agents, as a general executor's.
  const presetHarness = (): ExecutorHarness => {
    const harness = view?.general?.harness;
    return harness === "codex" || harness === "claude" || (harness === "opencode" && view?.opencodeEnabled) ? harness : "codex";
  };
  // Each chosen preset becomes an unsaved draft, under a free id; Save writes them, as any edit.
  const addPresets = (chosen: ExecutorPreset[]) => {
    const taken = drafts.map(d => d.id.trim());
    const harness = presetHarness();
    const made = chosen.map(p => {
      const id = freeId(p.id, taken);
      taken.push(id);
      return draftFromPreset(p, harness, id);
    });
    setDone(false);
    setPicking(false);
    setDrafts(list => [...list, ...made].slice(0, view?.limits.templates ?? 50));
  };
  // A new template opens on its own page.
  const addNew = () => {
    const made = { ...draftOf({ id: "", label: "", harness: "codex" }), idTouched: false };
    setDone(false);
    setPicking(false);
    setDrafts(list => [...list, made]);
    setOpenKey(made.key);
  };
  const runsOnText = (d: Draft) =>
    d.harness === "opencode" || !d.machine ? t.thisHost
      : d.machine === "auto" ? t.auto
        : machines.find(m => m.id === d.machine)?.name ?? savedMachine(d.machine);
  const presets = view ? presetsIn(view.presets, language) : [];
  const saveLine = view && (
    <div className="executor-templates-actions">
      {!inBar && (
        <button type="button" className="secondary-button" disabled={locked || !changed || invalid} onClick={() => void save()}>
          {busy && <LoaderCircle size={13} className="spin" />} {t.save}
        </button>
      )}
      {changed ? !inBar && <span className="settings-row-help">{t.unsaved}</span> : done && <span className="settings-row-help" role="status">{t.saved}</span>}
    </div>
  );
  return (
    <section
      id="settings-executor-templates"
      className="settings-section executor-templates-settings"
      aria-label={t.section}
      lang={langTag(language)}
    >
      {open && (
        <button type="button" className="settings-crumb" aria-label={t.backTo} onClick={() => setOpenKey(null)}>
          <ChevronLeft size={14} aria-hidden="true" />
          {t.title}
        </button>
      )}
      <header className="settings-section-heading">
        <div>
          <h3 ref={heading} tabIndex={-1}>{open ? open.label.trim() || t.newTemplate : t.title}</h3>
          <p>{open ? open.whenToChoose.trim() || t.pageIntro : t.intro}</p>
        </div>
        {open?.id.trim() && <span className="settings-current">{open.id.trim()}</span>}
      </header>
      {open && view ? (
        <>
          {open.savedId && view.lastModified?.[open.savedId] && <LastChange change={view.lastModified[open.savedId]} t={t} />}
          <TemplatePage key={open.key} d={open} t={t} language={language} view={view} locked={locked} machines={machines}
            savedMachine={savedMachine} edit={(change) => edit(open.key, change)}
            remove={() => { setDone(false); setOpenKey(null); setDrafts(list => list.filter(x => x.key !== open.key)); }} />
          {saveLine}
        </>
      ) : (
        <>
          <ExecutorSlots active={active} disabled={disabled} />
          {active && !view && !error && <p className="settings-row-help" role="status">{t.reading}</p>}
          {view && <>
            <div className="settings-group appearance-group executor-template-list">
              <fieldset className="appearance-field" disabled={locked}>
                <legend>{t.list}</legend>
                {(own(view).laterTemplates ?? 0) > 0 && <p className="settings-block-help">{t.later(own(view).laterTemplates ?? 0)}</p>}
                {drafts.length === 0 && <p className="settings-block-help">{t.none}</p>}
                <ul className="settings-list">
                  {drafts.map(d => (
                    <li key={d.key}>
                      <button type="button" className="settings-list-row is-open executor-template-row" data-template={d.id.trim() || undefined}
                        onClick={() => setOpenKey(d.key)}>
                        <Bot size={15} className="settings-list-icon" aria-hidden="true" />
                        <span className="settings-list-main">
                          <span className="settings-list-title">{d.label.trim() || t.newTemplate}</span>
                          <span className="settings-list-sub">
                            {harnessName(d.harness)} · {t.deliveries[d.deliveryMode || "pr"][0]} · {runsOnText(d)}
                          </span>
                        </span>
                        {needsFix(d) && <span className="settings-tag is-error">{t.needsFix}</span>}
                        {d.id.trim() && <span className="settings-tag is-mono">{d.id.trim()}</span>}
                        <ChevronRight size={15} className="settings-list-chev" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                  <li>
                    <button type="button" className="settings-list-row is-open is-add" disabled={drafts.length >= view.limits.templates} onClick={addNew}>
                      <Plus size={15} className="settings-list-icon" aria-hidden="true" />
                      <span className="settings-list-main"><span className="settings-list-title">{t.add}</span></span>
                    </button>
                  </li>
                  {presets.length > 0 && !picking && (
                    <li>
                      <button type="button" className="settings-list-row is-open is-add" disabled={drafts.length >= view.limits.templates}
                        onClick={() => setPicking(true)}>
                        <Plus size={15} className="settings-list-icon" aria-hidden="true" />
                        <span className="settings-list-main"><span className="settings-list-title">{t.addPresets}</span></span>
                      </button>
                    </li>
                  )}
                </ul>
              </fieldset>
            </div>
            {picking && (
              <PresetPicker presets={presets} taken={drafts.map(d => d.id.trim())} room={view.limits.templates - drafts.length}
                limit={view.limits.templates} harness={presetHarness()} t={t}
                onAdd={addPresets} onCancel={() => setPicking(false)} />
            )}
            {saveLine}
          </>}
        </>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reload}</button>}
    </section>
  );
}

const changedAt = timeFormatter({ year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** Who last changed a template, when and why (YN-24): leads change templates
 * directly, so this line is where you see their changes. */
function LastChange({ change, t }: { change: TemplateChange; t: Text }) {
  const time = useTimeDisplay();
  const ms = Date.parse(change.at);
  const who = change.by.kind === "user" ? t.you : change.by.name;
  const reason = change.reason?.trim();
  return (
    <p className="settings-row-help executor-template-changed">
      {t.lastChanged}{who}
      {Number.isFinite(ms) && <> · <time dateTime={moment(ms, time).dateTime} title={moment(ms, time).title}>{changedAt(time).format(ms)}</time></>}
      {reason && <> · {reason}</>}
    </p>
  );
}

/** One template's page (YN-8 S5b), in the design's order: its name and
 * purpose and how it runs, its delivery and steps, where it runs and its
 * instructions, then removing it on a card of its own. */
function TemplatePage({ d, t, language, view, locked, machines, savedMachine, edit, remove }: {
  d: Draft; t: Text; language: Language; view: ExecutorTemplatesView; locked: boolean; machines: WorkspaceMachine[];
  savedMachine: (id: string) => string; edit: (change: Partial<Draft>) => void; remove: () => void;
}) {
  const name = d.label.trim() || t.newTemplate;
  const noLabel = !d.label.trim();
  const deliveries = (["pr", "direct-commit", "none"] as const).map((value) => ({
    value, label: t.deliveries[value][0], note: t.deliveries[value][1],
  }));
  return (
    <div className="executor-template" aria-label={name}>
      <fieldset className="settings-group appearance-group" disabled={locked}>
        <fieldset className="appearance-field executor-template-basics">
          <legend>{t.nameAndPurpose}</legend>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.label}</span>
              {noLabel && <span className="inline-error">{t.labelNeeded}</span>}
              {d.origin && <span className="settings-row-help">{t.origin(d.origin.projectName, d.origin.id)}</span>}
            </span>
            <input className="settings-input" aria-label={t.label} value={d.label} maxLength={80} aria-invalid={noLabel || undefined}
              onChange={e => edit({ label: e.target.value })} />
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.whenToChoose}</span>
              <span className="settings-row-help">{t.whenToChooseHelp}</span>
            </span>
            <input className="settings-input executor-template-when" aria-label={t.whenToChoose} value={d.whenToChoose} maxLength={200}
              onChange={e => edit({ whenToChoose: e.target.value })} />
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.id}</span>
              <span className="settings-row-help">{t.idHelp}</span>
            </span>
            <input className="settings-input" aria-label={t.id} value={d.id} maxLength={48}
              onChange={e => edit({ id: e.target.value, idTouched: true })} />
          </label>
        </fieldset>
        <fieldset className="appearance-field executor-template-runs">
          <legend>{t.howItRuns}</legend>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.harness}</span>
            </span>
            <select className="settings-select" aria-label={t.harness} value={d.harness}
              onChange={e => edit({ harness: e.target.value as ExecutorHarness })}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
              {(view.opencodeEnabled || d.harness === "opencode") && <option value="opencode">OpenCode</option>}
            </select>
          </label>
          {d.harness === "opencode" ? <p className="settings-row-help executor-template-note">{t.opencodeNative}</p> : <>
            <label className="settings-row">
              <span className="settings-row-main">
                <span className="settings-row-title">{t.model}</span>
                {d.preset?.modelHint && <span className="settings-row-help">{t.modelHint(d.preset.modelHint)}</span>}
              </span>
              <input className="settings-input" aria-label={t.model} value={d.model} placeholder={t.inheritModel}
                onChange={e => edit({ model: e.target.value })} />
            </label>
            {d.harness === "codex" && (
              <label className="settings-row">
                <span className="settings-row-main"><span className="settings-row-title">{t.effort}</span></span>
                <input className="settings-input" aria-label={t.effort} value={d.reasoningEffort} placeholder={t.inheritEffort}
                  disabled={locked || !d.model.trim()} onChange={e => edit({ reasoningEffort: e.target.value })} />
              </label>
            )}
            <label className="settings-row">
              <span className="settings-row-main"><span className="settings-row-title">{t.permission}</span></span>
              <select className="settings-select" aria-label={t.permission} value={d.permission}
                onChange={e => edit({ permission: e.target.value })}>
                <option value="">{t.inheritPermission}</option>
                {(d.harness === "codex" ? CODEX_PRESETS : CLAUDE_MODES).map(value => (
                  <option key={value} value={value}>
                    {d.harness === "codex" ? codexPermissionText(value, language) : claudeModeText(value, language)}
                  </option>
                ))}
              </select>
            </label>
          </>}
        </fieldset>
      </fieldset>
      <fieldset className="settings-group appearance-group" disabled={locked}>
        <fieldset className="appearance-field executor-template-delivery">
          <legend>{t.delivery}</legend>
          <p className="appearance-help">{t.deliveryHelp}</p>
          <ChoiceCards<DeliveryMode> name={`delivery-${d.key}`} value={d.deliveryMode || "pr"} choices={deliveries}
            className="executor-delivery-choice" onChange={(deliveryMode) => edit({ deliveryMode })} />
        </fieldset>
        <StepsField d={d} t={t} edit={edit} />
      </fieldset>
      <fieldset className="settings-group appearance-group" disabled={locked}>
        <fieldset className="appearance-field executor-template-where">
          <legend>{t.whereItRuns}</legend>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.runsOn}</span>
              <span className="settings-row-help">
                {d.harness === "opencode" ? t.opencodeHost : d.machine === "auto" ? t.autoHelp : t.machineHelp}
              </span>
            </span>
            <select className="settings-select" aria-label={t.runsOn} value={d.harness === "opencode" ? "" : d.machine}
              disabled={locked || d.harness === "opencode"} onChange={e => edit({ machine: e.target.value })}>
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
              placeholder={view.defaultNamePattern} onChange={e => edit({ namePattern: e.target.value })} />
          </label>
        </fieldset>
        <fieldset className="appearance-field executor-template-instructions">
          <legend>{t.instructions}</legend>
          <p className="appearance-help">{t.instructionsHelp(bytes(d.instructions), view.limits.instructionsBytes)}</p>
          <textarea className="settings-textarea" aria-label={t.instructions} rows={6} value={d.instructions}
            onChange={e => edit({ instructions: e.target.value })} />
        </fieldset>
      </fieldset>
      {/* What removes is last, on its own card (YN-8). */}
      <div className="settings-group appearance-group">
        <div className="settings-row executor-template-remove">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.removeTitle}</span>
            <span className="settings-row-help">{t.removeHelp}</span>
          </span>
          <span className="settings-row-action">
            <button type="button" className="secondary-button" disabled={locked} onClick={remove}>
              <Trash2 size={13} /> {t.remove(name)}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

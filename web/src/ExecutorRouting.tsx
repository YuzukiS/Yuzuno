import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDown, ChevronUp, CircleAlert, CircleHelp, Clock, Gauge, GripVertical, Layers, Pencil, Plus, Trash2, Wallet, X,
} from "lucide-react";
import { errorText } from "./api";
import {
  DEEPSEEK_PEAK, EFFORTS, HARNESSES, MODEL_HINTS, PRESETS, PolicyRefused, credentialFits, isKnown, keyFits, modelShort, moved,
  newCandidateId, pathPlace, presetCandidates, readPolicy, sameSchedule, savePolicy, usesApi,
  type AnyCondition, type Candidate, type Condition, type Credential, type Harness, type Policy, type PolicyView, type PresetId, type Schedule, type Slot,
} from "./executor-routing";
import { langTag, strings, useLanguage } from "./i18n";
import { ROUTING_CREDENTIALS_CHANGED, readAccountsShared, readKeys, shortFingerprint, type AccountsView, type RoutingKey } from "./routing-keys";
import { useSaveBarPart } from "./SettingsSaveBar";
import { Tip, TipText } from "./Tip";
import { timeFormatter, useTimeDisplay } from "./time-preferences";
import "./executor-routing.css";

const harnessName: Record<Harness, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const providerName: Record<string, string> = { deepseek: "DeepSeek", anthropic: "Anthropic", openai: "OpenAI" };

const text = strings({
  title: "Executor routing",
  intro: "When a new executor starts, Core takes the first candidate from the top whose conditions all hold now, that this machine can run, and that starts. Executors already running are never switched.",
  on: "On",
  off: "Off",
  switchLabel: "Executor routing",
  offNote: "Routing is off: new executors start with their templates' own settings.",
  reading: "Reading the routing order…",
  version: (n: number) => `version ${n}`,
  orderTitle: "Candidate order",
  orderHelp: "Drag a handle to reorder, or use the arrows. A candidate keeps its colour when it moves; its number is its place.",
  none: "No candidate yet: add one, or start from a preset.",
  grip: (title: string) => `Reorder ${title}: drag, or press the up and down arrow keys`,
  movedTo: (title: string, n: number) => `${title} moved to place ${n}`,
  moveUp: (title: string) => `Move ${title} up`,
  moveDown: (title: string) => `Move ${title} down`,
  enable: (title: string) => `Use ${title}`,
  edit: (title: string) => `Edit ${title}`,
  collapse: (title: string) => `Close ${title}`,
  tagSub: "Subscription",
  tagApi: "API",
  loginClaude: "This host's login",
  loginCodex: "This host's login (ChatGPT subscription)",
  loginOpencode: "OpenCode's own login",
  pool: (n: number | "all") => (n === "all" ? "claude-swap pool · the account with most left · all accounts" : `claude-swap pool · the account with most left · ${n} ${n === 1 ? "account" : "accounts"}`),
  key: (provider: string, source: string) => `API key: ${provider} · ${source}`,
  keyLocal: "this host",
  key1p: "1Password",
  keyMissing: (id: string) => `API key ${id} · not added yet: add it under Accounts and keys`,
  keyPending: (id: string) => `API key ${id}`,
  codexHome: (label: string) => `Codex account: ${label}`,
  codexHomeMissing: (id: string) => `Codex account ${id} · not in the list`,
  chipPeakOff: (m?: number) => (m ? `DeepSeek off-peak · at least ${m} min before peak` : "DeepSeek off-peak"),
  chipPeakOn: "DeepSeek peak hours",
  chipInside: (s: string, m?: number) => `Within ${s}${m ? ` · ${m} min left at least` : ""}`,
  chipOutside: (s: string, m?: number) => `Outside ${s}${m ? ` · ${m} min left at least` : ""}`,
  chipQuota: (five?: number, week?: number) => [five != null ? `5-hour left ≥ ${five}%` : "", week != null ? `week left ≥ ${week}%` : ""].filter(Boolean).join(" · "),
  chipCap: (usd: number) => `Today ≤ $${usd}`,
  chipPick: "The account with most left",
  chipSkip: "Skipped when a reading is unavailable",
  chipPass: "Counted as met when a reading is unavailable",
  chipUnknownKind: (kind: string) => `A condition this version can't show (${kind})`,
  utc: "UTC",
  local: "Core host time",
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  dayRange: (a: string, b: string) => `${a}–${b}`,
  moreSlots: (n: number) => ` +${n}`,
  slotJoin: "; ",
  // The editor.
  label: "Name",
  labelPlaceholder: "Empty: tool and model",
  modelPlaceholder: "The tool's default",
  harness: "Tool",
  model: "Model",
  effort: "Reasoning effort",
  effortDefault: "The model's own",
  credential: "Account or key",
  credLoginClaude: "This host's login",
  credLoginCodex: "This host's login (ChatGPT subscription)",
  credLoginOpencode: "OpenCode's own login",
  credPool: "claude-swap pool (the account with most left)",
  credKey: (provider: string, id: string) => `API key: ${provider} (${id})`,
  credHome: (label: string) => `Codex account: ${label}`,
  poolAccounts: "Accounts in the pool",
  poolAll: "All accounts claude-swap lists",
  poolSome: "Only these:",
  account: (n: number) => `Account #${n}`,
  noAccounts: "claude-swap lists no account now.",
  conditions: "Conditions",
  noConditions: "No condition: it's chosen whenever it's reached and can start.",
  addTime: "Time window",
  addQuota: "Subscription left",
  addCap: "Daily spend",
  removeCondition: "Remove this condition",
  timeWindow: "Time window",
  insideOption: "Within these hours",
  outsideOption: "Outside these hours",
  timeZone: "Time zone",
  useDeepseek: "DeepSeek's peak hours",
  deepseekHelp: "UTC, Monday to Friday, 01–04 and 06–10. Its off-peak price is outside them.",
  slot: (n: number) => `Period ${n}`,
  dayOf: (n: number, day: string) => `Period ${n}: ${day}`,
  from: (n: number) => `Period ${n}: from`,
  to: (n: number) => `Period ${n}: to`,
  toHelp: "An end at or before the start runs past midnight; 00:00 as the end is midnight.",
  removeSlot: (n: number) => `Remove period ${n}`,
  addSlot: "Add a period",
  minLeft: "At least this many minutes left in it",
  minutes: "min",
  quota: "Subscription left",
  fiveHour: "5-hour window left at least",
  week: "This week left at least",
  cap: "Daily spend",
  capOwn: "This candidate, at most $ a day",
  unknown: "When a reading is unavailable",
  skip: "Skip this candidate",
  pass: "Count it as met",
  remove: "Remove this candidate",
  done: "Done",
  // Problems.
  needsFix: "Needs a fix",
  modelSpaces: "A model is one name, without spaces.",
  modelOpencode: "An OpenCode model is <provider>/<model>, such as deepseek/deepseek-flash.",
  keyNeeded: (id: string) => `The key ${id} isn't added yet: add it under Accounts and keys below, or choose another.`,
  homeNeeded: (id: string) => `The Codex account ${id} isn't listed: add it under Accounts and keys below, or choose another.`,
  labelTooLong: "A name is at most 60 characters.",
  credNotFit: "This tool can't use that account or key.",
  poolEmpty: "Choose an account, or all.",
  quotaEmpty: "Give a 5-hour or weekly share, or remove the condition.",
  capBad: "A daily spend above $0, at most $10,000.",
  slotsEmpty: "A time window needs a period.",
  slotNoDay: (n: number) => `Period ${n} needs a day.`,
  slotBad: (n: number) => `Period ${n} starts and ends at the same time.`,
  minBad: "1 to 1440 minutes.",
  // Below the list.
  add: "Add a candidate",
  max: (n: number) => `At most ${n} candidates.`,
  presets: "Presets:",
  preset: { deepseekFirst: "DeepSeek off-peak first", subscriptions: "Subscriptions only", subscriptionsThenApi: "Subscriptions first, API after" } as Record<PresetId, string>,
  presetReplace: (name: string) => `Replace the list with “${name}”? It stays unsaved until you save.`,
  replace: "Replace",
  cancel: "Cancel",
  whenNoneTitle: "When none is available",
  whenNoneWait: "New executors wait in the queue. Core checks again every minute and whenever a reading changes; the Agent that dispatched one is told when a candidate may be available first.",
  capTitle: "Daily API spend for the Workspace",
  capHelp: "Applies to every candidate with an API key, on top of its own cap. At the cap no new executor starts with an API key; running ones go on. Spend is what the tools report, not a bill; a day is the Core host's date.",
  capInput: "At most $ a day, all API keys",
  capNone: "No cap",
  // Saving.
  conflict: (n: number, at: string) => `A newer version (${n}${at ? `, saved ${at}` : ""}) is in Core. Nothing was overwritten; your changes are still here.`,
  conflictOrder: "Its order:",
  conflictOff: "Routing off.",
  useSaved: "Use the saved version",
  keepMine: "Keep mine, to save over it",
  refusedAt: (candidate: number, condition?: number) => condition != null ? `Core didn't accept condition ${condition + 1} of candidate ${candidate}:` : `Core didn't accept candidate ${candidate}:`,
  refused: "Core didn't accept the routing order:",
}, {
  title: "执行者路由",
  intro: "新开执行者时，Core 从上往下找第一个此刻条件都满足、这台机器能跑、启动也成功的候选。已经在运行的执行者不换。",
  on: "开启",
  off: "关闭",
  switchLabel: "执行者路由",
  offNote: "路由关着：新开的执行者按各自模板的固定设置启动。",
  reading: "正在读取路由顺序…",
  version: (n) => `版本 ${n}`,
  orderTitle: "候选顺序",
  orderHelp: "拖动左边的把手排序，或用上下按钮。候选移动时颜色跟着它走，编号是它现在的位置。",
  none: "还没有候选：添加一个，或从预设开始。",
  grip: (title) => `给 ${title} 排序：拖动，或按上下方向键`,
  movedTo: (title, n) => `${title} 移到了第 ${n} 位`,
  moveUp: (title) => `上移 ${title}`,
  moveDown: (title) => `下移 ${title}`,
  enable: (title) => `启用 ${title}`,
  edit: (title) => `编辑 ${title}`,
  collapse: (title) => `收起 ${title}`,
  tagSub: "订阅",
  tagApi: "API",
  loginClaude: "主机的登录",
  loginCodex: "主机的登录（ChatGPT 订阅）",
  loginOpencode: "OpenCode 自己的登录",
  pool: (n) => (n === "all" ? "claude-swap 账号池 · 选剩余最多的 · 全部账号" : `claude-swap 账号池 · 选剩余最多的 · ${n} 个账号`),
  key: (provider, source) => `API key：${provider} · ${source}`,
  keyLocal: "本机密钥库",
  key1p: "1Password",
  keyMissing: (id) => `API key ${id} · 还没添加：在「账号和密钥」里添加`,
  keyPending: (id) => `API key ${id}`,
  codexHome: (label) => `Codex 账号：${label}`,
  codexHomeMissing: (id) => `Codex 账号 ${id} · 不在列表里`,
  chipPeakOff: (m) => (m ? `DeepSeek 闲时 · 离高峰至少 ${m} 分钟` : "DeepSeek 闲时"),
  chipPeakOn: "DeepSeek 高峰时段",
  chipInside: (s, m) => `在 ${s} 内${m ? ` · 至少还剩 ${m} 分钟` : ""}`,
  chipOutside: (s, m) => `在 ${s} 以外${m ? ` · 至少还剩 ${m} 分钟` : ""}`,
  chipQuota: (five, week) => [five != null ? `5 小时剩 ≥ ${five}%` : "", week != null ? `本周剩 ≥ ${week}%` : ""].filter(Boolean).join(" · "),
  chipCap: (usd) => `今日本项 ≤ $${usd}`,
  chipPick: "选剩余最多的账号",
  chipSkip: "读不到时跳过",
  chipPass: "读不到时当作满足",
  chipUnknownKind: (kind) => `这个版本显示不了的条件（${kind}）`,
  utc: "UTC",
  local: "Core 主机时间",
  days: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  dayRange: (a, b) => `${a}至${b.replace("周", "")}`,
  moreSlots: (n) => ` 等 ${n + 1} 段`,
  slotJoin: "；",
  label: "名称",
  labelPlaceholder: "不填就用工具和模型",
  modelPlaceholder: "工具的默认模型",
  harness: "工具",
  model: "模型",
  effort: "推理强度",
  effortDefault: "模型自己的",
  credential: "账号或 key",
  credLoginClaude: "主机的登录",
  credLoginCodex: "主机的登录（ChatGPT 订阅）",
  credLoginOpencode: "OpenCode 自己的登录",
  credPool: "claude-swap 账号池（选剩余最多的）",
  credKey: (provider, id) => `API key：${provider}（${id}）`,
  credHome: (label) => `Codex 账号：${label}`,
  poolAccounts: "池里的账号",
  poolAll: "claude-swap 列出的全部账号",
  poolSome: "只用这些：",
  account: (n) => `账号 #${n}`,
  noAccounts: "claude-swap 现在没有列出账号。",
  conditions: "条件",
  noConditions: "没有条件：轮到它、能启动就选它。",
  addTime: "时间窗口",
  addQuota: "订阅额度",
  addCap: "每日花费",
  removeCondition: "删除这个条件",
  timeWindow: "时间窗口",
  insideOption: "在这些时段内",
  outsideOption: "在这些时段以外",
  timeZone: "时区",
  useDeepseek: "DeepSeek 高峰时段",
  deepseekHelp: "UTC 周一至五 01–04、06–10 点。闲时价格在这些时段以外。",
  slot: (n) => `时段 ${n}`,
  dayOf: (n, day) => `时段 ${n}：${day}`,
  from: (n) => `时段 ${n}：开始`,
  to: (n) => `时段 ${n}：结束`,
  toHelp: "结束早于或等于开始就是跨过午夜；结束填 00:00 就是到午夜。",
  removeSlot: (n) => `删除时段 ${n}`,
  addSlot: "添加时段",
  minLeft: "至少还剩多少分钟",
  minutes: "分钟",
  quota: "订阅额度",
  fiveHour: "5 小时窗口至少剩",
  week: "本周至少剩",
  cap: "每日花费",
  capOwn: "这一项每天最多 $",
  unknown: "读不到读数时",
  skip: "跳过这一项",
  pass: "当作满足",
  remove: "删除这一项",
  done: "完成",
  needsFix: "需要修改",
  modelSpaces: "模型是一个名字，不带空格。",
  modelOpencode: "OpenCode 的模型写成 <提供方>/<模型>，例如 deepseek/deepseek-flash。",
  keyNeeded: (id) => `还没有 key ${id}：在下面的「账号和密钥」里添加，或换一个。`,
  homeNeeded: (id) => `Codex 账号 ${id} 不在列表里：在下面的「账号和密钥」里添加，或换一个。`,
  labelTooLong: "名称最多 60 个字。",
  credNotFit: "这个工具用不了这个账号或 key。",
  poolEmpty: "选一个账号，或全部。",
  quotaEmpty: "填 5 小时或本周的下限，或删掉这个条件。",
  capBad: "每日花费要大于 $0，最多 $10,000。",
  slotsEmpty: "时间窗口至少要有一个时段。",
  slotNoDay: (n) => `时段 ${n} 要选至少一天。`,
  slotBad: (n) => `时段 ${n} 的开始和结束是同一时间。`,
  minBad: "1 到 1440 分钟。",
  add: "添加候选",
  max: (n) => `最多 ${n} 项。`,
  presets: "预设：",
  preset: { deepseekFirst: "闲时 DeepSeek 优先", subscriptions: "只用订阅", subscriptionsThenApi: "订阅优先，API 兜底" },
  presetReplace: (name) => `用「${name}」替换现在的列表？保存之前不会写入。`,
  replace: "替换",
  cancel: "取消",
  whenNoneTitle: "都不可用时",
  whenNoneWait: "新开的执行者排队等。Core 每分钟、以及每次读数变化时重新判断；派发它的 Agent 会收到最早什么时候可能有候选可用。",
  capTitle: "工作区每日 API 花费",
  capHelp: "对所有用 API key 的候选生效，另外还有各自的上限。到了上限不再新开用 API key 的执行者，正在跑的继续跑。花费是各工具自己报的估算，不是账单；一天按 Core 主机的日期算。",
  capInput: "所有 API key 合计每天最多 $",
  capNone: "不设上限",
  conflict: (n, at) => `Core 里有更新的版本（${n}${at ? `，${at} 保存` : ""}）。什么都没有被覆盖，你的改动还在这里。`,
  conflictOrder: "它的顺序：",
  conflictOff: "路由关着。",
  useSaved: "用保存的版本",
  keepMine: "保留我的，保存时覆盖它",
  refusedAt: (candidate, condition) => condition != null ? `Core 不接受第 ${candidate} 项的第 ${condition + 1} 个条件：` : `Core 不接受第 ${candidate} 项：`,
  refused: "Core 不接受这个路由顺序：",
});
type Text = ReturnType<typeof text>;

const savedAt = timeFormatter({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** A schedule in a few words: its zone, its first period's days and hours, and how many more. */
/** One period in a few words: its days and hours. */
function slotWords(slot: Slot, t: Text): string {
  const days = [...slot.days].sort((a, b) => a - b);
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = days.length === 7 ? "" : contiguous ? t.dayRange(t.days[days[0] - 1], t.days[days.at(-1)! - 1]) : days.map((d) => t.days[d - 1]).join(" ");
  return `${dayText ? `${dayText} ` : ""}${slot.from}–${slot.to}`;
}
const zoneWords = (schedule: Schedule, t: Text) => (schedule.timeZone === "UTC" ? t.utc : t.local);
/** A schedule in a few words, for its chip: its zone, its first period, and how many more. */
function scheduleWords(schedule: Schedule, t: Text): string {
  const slot = schedule.slots[0];
  if (!slot) return t.timeWindow;
  return `${zoneWords(schedule, t)} ${slotWords(slot, t)}${schedule.slots.length > 1 ? t.moreSlots(schedule.slots.length - 1) : ""}`;
}

function chipText(c: AnyCondition, t: Text): string {
  if (!isKnown(c)) return t.chipUnknownKind(c.kind);
  if (c.kind === "quota") return t.chipQuota(c.fiveHourLeftPct, c.weekLeftPct) || t.quota;
  if (c.kind === "dailyApiCap") return t.chipCap(c.usd);
  if (sameSchedule(c.schedule, DEEPSEEK_PEAK)) return c.inside ? t.chipPeakOn : t.chipPeakOff(c.minMinutesLeft);
  return (c.inside ? t.chipInside : t.chipOutside)(scheduleWords(c.schedule, t), c.minMinutesLeft);
}
const chipIcon = (c: AnyCondition) => (c.kind === "timeWindow" ? Clock : c.kind === "quota" ? Gauge : c.kind === "dailyApiCap" ? Wallet : CircleHelp);

/** What a candidate's account or key is, in a line. */
function credentialWords(c: Candidate, t: Text, keys: RoutingKey[] | null, accounts: AccountsView | null): { text: string; missing: boolean } {
  const cred = c.credential;
  if (cred.kind === "login") return { text: c.harness === "codex" ? t.loginCodex : c.harness === "claude" ? t.loginClaude : t.loginOpencode, missing: false };
  if (cred.kind === "pool") return { text: t.pool(cred.accounts === "all" ? "all" : cred.accounts.length), missing: false };
  if (cred.kind === "apiKey") {
    if (!keys) return { text: t.keyPending(cred.keyId), missing: false };
    const key = keys.find((k) => k.id === cred.keyId);
    return key ? { text: t.key(providerName[key.provider] ?? key.provider, key.source === "local" ? t.keyLocal : t.key1p), missing: false } : { text: t.keyMissing(cred.keyId), missing: true };
  }
  const home = accounts?.codexHomes.find((h) => h.id === cred.id);
  return home ? { text: t.codexHome(home.label), missing: false } : { text: t.codexHomeMissing(cred.id), missing: !!accounts };
}
const titleOf = (c: Candidate) => c.label?.trim() || [harnessName[c.harness] ?? c.harness, modelShort(c.model ?? "")].filter(Boolean).join(" · ");
/** A candidate's name where its card's API tag isn't beside it (labels,
 * announcements, a newer version's order): one with an API key says so, so
 * "Claude Code · opus" by subscription and by API key are told apart. */
const nameOf = (c: Candidate) => (c.label?.trim() || c.credential.kind !== "apiKey" ? titleOf(c) : `${titleOf(c)} · API`);

const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const usdFits = (n: number | undefined) => n != null && n > 0 && n <= 10_000;

/** What keeps a candidate from being saved, by where it is ("" the candidate,
 * else a condition's place), as Core's check (YN-34 S3a) would refuse it, so
 * it is said here before a save. */
function problemsOf(c: Candidate, t: Text, keys: RoutingKey[] | null, accounts: AccountsView | null): { at: string; text: string }[] {
  const list: { at: string; text: string }[] = [];
  const model = c.model ?? "";
  if (/\s/.test(model)) list.push({ at: "", text: t.modelSpaces });
  else if (c.harness === "opencode" && model && !/^[^/\s]+\/[^\s]+$/.test(model)) list.push({ at: "", text: t.modelOpencode });
  if ((c.label ?? "").trim().length > 60) list.push({ at: "", text: t.labelTooLong });
  const cred = c.credential;
  if (!credentialFits(c.harness, cred)) list.push({ at: "", text: t.credNotFit });
  else if (cred.kind === "apiKey" && keys) {
    const key = keys.find((k) => k.id === cred.keyId);
    if (!key) list.push({ at: "", text: t.keyNeeded(cred.keyId) });
    else if (!keyFits(c.harness, key.provider)) list.push({ at: "", text: t.credNotFit });
  } else if (cred.kind === "codexHome" && accounts && !accounts.codexHomes.some((h) => h.id === cred.id)) list.push({ at: "", text: t.homeNeeded(cred.id) });
  if (cred.kind === "pool" && Array.isArray(cred.accounts) && cred.accounts.length === 0) list.push({ at: "", text: t.poolEmpty });
  c.conditions.forEach((cond, i) => {
    if (!isKnown(cond)) return;
    const at = String(i);
    if (cond.kind === "quota" && cond.fiveHourLeftPct == null && cond.weekLeftPct == null) list.push({ at, text: t.quotaEmpty });
    if (cond.kind === "dailyApiCap" && !usdFits(cond.usd)) list.push({ at, text: t.capBad });
    if (cond.kind === "timeWindow") {
      if (!cond.schedule.slots.length) list.push({ at, text: t.slotsEmpty });
      cond.schedule.slots.forEach((s, n) => {
        if (!s.days.length) list.push({ at, text: t.slotNoDay(n + 1) });
        else if (minutesOf(s.from) === minutesOf(s.to)) list.push({ at, text: t.slotBad(n + 1) });
      });
      if (cond.minMinutesLeft != null && !(cond.minMinutesLeft >= 1 && cond.minMinutesLeft <= 1440)) list.push({ at, text: t.minBad });
    }
  });
  return list;
}

/** Settings → Executor routing: the ordered candidates (YN-49 S4a), saved
 * whole against the version read, through the page's save bar. */
export function ExecutorRouting({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  const [view, setView] = useState<PolicyView | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [readError, setReadError] = useState("");
  // null until read: a key a candidate names is called missing only from a list that was read.
  const [keys, setKeys] = useState<RoutingKey[] | null>(null);
  const [accounts, setAccounts] = useState<AccountsView | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PolicyView | null>(null);
  const [refused, setRefused] = useState<{ text: string; path?: string } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [asking, setAsking] = useState<PresetId | null>(null);
  const [live, setLive] = useState("");
  // Each candidate's colour, by id, in the order first seen: a move keeps it.
  const colours = useRef(new Map<string, number>());
  const colourOf = (id: string) => {
    if (!colours.current.has(id)) {
      const used = new Set(colours.current.values());
      let n = 1;
      while (used.has(n) && n < 8) n++;
      colours.current.set(id, used.has(n) ? (colours.current.size % 8) + 1 : n);
    }
    return colours.current.get(id)!;
  };
  const focusGrip = useRef<string | null>(null);

  const adopt = (next: PolicyView) => { setView(next); setDraft(next.policy); setConflict(null); setRefused(null); setSaveError(""); };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const signal = controller.signal;
    setReadError("");
    readPolicy(signal).then((next) => { if (!signal.aborted) adopt(next); }).catch((e) => { if (!signal.aborted) setReadError(errorText(e)); });
    // Keys and accounts as Accounts and keys below shows them; that block says why when they can't be read.
    const credentials = () => {
      readKeys(signal).then((next) => { if (!signal.aborted) setKeys(next.keys); }).catch(() => {});
      readAccountsShared().then((next) => { if (!signal.aborted) setAccounts(next); }).catch(() => {});
    };
    credentials();
    window.addEventListener(ROUTING_CREDENTIALS_CHANGED, credentials);
    return () => { controller.abort(); window.removeEventListener(ROUTING_CREDENTIALS_CHANGED, credentials); };
  }, [active]);
  useLayoutEffect(() => {
    if (!focusGrip.current) return;
    const id = focusGrip.current;
    [...document.querySelectorAll<HTMLElement>(".routing-cand")].find((card) => card.dataset.cand === id)
      ?.querySelector<HTMLButtonElement>(".routing-grip")?.focus();
    focusGrip.current = null;
  });

  const policy = draft;
  const changed = !!view && !!policy && JSON.stringify(policy) !== JSON.stringify(view.policy);
  const problems = new Map((policy?.candidates ?? []).map((c) => [c.id, problemsOf(c, t, keys, accounts)]));
  const capBad = policy?.dailyApiCapUsd != null && !usdFits(policy.dailyApiCapUsd);
  const invalid = [...problems.values()].some((p) => p.length > 0) || capBad;
  const edit = (change: (p: Policy) => Policy) => { setDraft((p) => (p ? change(p) : p)); setRefused(null); setSaveError(""); };
  const editCandidate = (id: string, change: (c: Candidate) => Candidate) =>
    edit((p) => ({ ...p, candidates: p.candidates.map((c) => (c.id === id ? change(c) : c)) }));
  const move = (from: number, to: number, focus = false) => {
    if (!policy || to < 0 || to >= policy.candidates.length || from === to) return;
    const c = policy.candidates[from];
    edit((p) => ({ ...p, candidates: moved(p.candidates, from, to) }));
    setLive(t.movedTo(nameOf(c), to + 1));
    if (focus) focusGrip.current = c.id;
  };

  async function save(): Promise<boolean> {
    if (!policy || !view) return false;
    try {
      adopt(await savePolicy(view.version, policy));
      return true;
    } catch (e) {
      if (e instanceof PolicyRefused && e.code === "version_conflict") {
        setConflict(e.current ?? await readPolicy().catch(() => null));
      } else if (e instanceof PolicyRefused && e.code === "invalid") {
        setRefused({ text: e.message, path: e.path });
        const at = pathPlace(e.path).candidate;
        if (at != null && policy.candidates[at]) setOpen(policy.candidates[at].id);
      } else setSaveError(errorText(e));
      return false;
    }
  }
  useSaveBarPart("executor-routing", changed && view ? {
    ready: !invalid && !conflict,
    save,
    discard: () => { if (view) adopt(view); },
  } : null);

  const limit = view?.limits.candidates ?? 8;
  const addCandidate = () => {
    if (!policy) return;
    const id = newCandidateId(policy.candidates.map((c) => c.id));
    edit((p) => ({ ...p, candidates: [...p.candidates, { id, enabled: true, harness: "claude", model: "sonnet", credential: { kind: "login" }, conditions: [], unknown: "skip" }] }));
    setOpen(id);
  };
  const applyPreset = (preset: PresetId) => {
    edit((p) => ({ ...p, candidates: presetCandidates(preset, keys ?? [], p.candidates.map((c) => c.id)).slice(0, limit) }));
    setAsking(null);
    setOpen(null);
  };
  const refusedPlace = pathPlace(refused?.path);
  const refusedId = refusedPlace.candidate != null ? policy?.candidates[refusedPlace.candidate]?.id : undefined;

  return (
    <section className="settings-section executor-routing" aria-labelledby="routing-title" lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3 id="routing-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        {policy && (
          <label className="routing-head-switch">
            <input type="checkbox" role="switch" className="settings-toggle" aria-label={t.switchLabel} checked={policy.enabled}
              onChange={(e) => edit((p) => ({ ...p, enabled: e.target.checked }))} />
            {policy.enabled ? t.on : t.off}
          </label>
        )}
      </header>
      {readError && <p className="inline-error" role="alert">{readError}</p>}
      {active && !view && !readError && <p className="settings-row-help" role="status">{t.reading}</p>}
      {conflict && (
        <div className="routing-conflict" role="alert">
          <p><CircleAlert size={14} className="routing-icon" aria-hidden="true" /> {t.conflict(conflict.version, conflict.updatedAt && Number.isFinite(Date.parse(conflict.updatedAt)) ? savedAt(time).format(Date.parse(conflict.updatedAt)) : "")}</p>
          <p className="settings-row-help">{conflict.policy.enabled ? t.conflictOrder : t.conflictOff}</p>
          {conflict.policy.enabled && <ol className="routing-conflict-order">{conflict.policy.candidates.map((c) => <li key={c.id}>{nameOf(c)}</li>)}</ol>}
          <div className="routing-form-actions">
            <button type="button" className="secondary-button" onClick={() => adopt(conflict)}>{t.useSaved}</button>
            <button type="button" className="quiet-button" onClick={() => { setView(conflict); setConflict(null); }}>{t.keepMine}</button>
          </div>
        </div>
      )}
      {refused && (
        <p className="inline-error routing-refused" role="alert">
          {refusedPlace.candidate != null ? t.refusedAt(refusedPlace.candidate + 1, refusedPlace.condition) : t.refused} <span lang="en">{refused.text}</span>
        </p>
      )}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      {policy && view && <>
        {!policy.enabled && <p className="settings-block-help routing-off-note">{t.offNote}</p>}
        <div className="routing-order-head">
          <h4 className="settings-group-title">{t.orderTitle} <span className="settings-current">{t.version(view.version)}</span></h4>
          <p className="settings-block-help">{t.orderHelp}</p>
        </div>
        <CandidateList policy={policy} t={t} keys={keys} accounts={accounts} open={open} problems={problems} refusedId={refusedId}
          refusedCondition={refusedPlace.condition} colourOf={colourOf} onOpen={setOpen} onMove={move}
          onEdit={editCandidate} onRemove={(id) => { edit((p) => ({ ...p, candidates: p.candidates.filter((c) => c.id !== id) })); setOpen(null); }} />
        <p className="sr-only" role="status" aria-live="polite">{live}</p>
        <div className="routing-list-foot">
          <button type="button" className="secondary-button" disabled={policy.candidates.length >= limit} onClick={addCandidate}><Plus size={14} /> {t.add}</button>
          {policy.candidates.length >= limit && <small className="settings-row-meta">{t.max(limit)}</small>}
          <span className="settings-row-meta">{t.presets}</span>
          {PRESETS.map((p) => (
            <button type="button" key={p} className="quiet-button" aria-pressed={asking === p}
              onClick={() => (policy.candidates.length ? setAsking(p) : applyPreset(p))}>{t.preset[p]}</button>
          ))}
        </div>
        {asking && (
          <div className="settings-confirm" role="group" aria-label={t.presetReplace(t.preset[asking])}>
            <p>{t.presetReplace(t.preset[asking])}</p>
            <span className="settings-confirm-actions">
              <button type="button" className="secondary-button" onClick={() => applyPreset(asking)}>{t.replace}</button>
              <button type="button" className="quiet-button" onClick={() => setAsking(null)}>{t.cancel}</button>
            </span>
          </div>
        )}
        <div className="settings-group routing-workspace">
          <div className="settings-row">
            <Clock size={16} className="settings-row-icon" aria-hidden="true" />
            <div className="settings-row-main">
              <span className="settings-row-title">{t.whenNoneTitle}</span>
              <p className="settings-row-help">{t.whenNoneWait}</p>
            </div>
          </div>
          <div className="settings-row">
            <Wallet size={16} className="settings-row-icon" aria-hidden="true" />
            <div className="settings-row-main">
              <span className="settings-row-title">{t.capTitle}</span>
              <p className="settings-row-help">{t.capHelp}</p>
              <label className="routing-inline-field">
                <span>{t.capInput}</span>
                <input type="number" className="settings-input routing-number" min={0} step={1} inputMode="decimal" placeholder={t.capNone}
                  aria-label={t.capInput} value={policy.dailyApiCapUsd ?? ""} aria-invalid={capBad || undefined}
                  onChange={(e) => edit((p) => {
                    const { dailyApiCapUsd: _, ...rest } = p;
                    return e.target.value === "" ? (rest as Policy) : { ...rest, dailyApiCapUsd: Number(e.target.value) };
                  })} />
              </label>
              {capBad && <span className="inline-error">{t.capBad}</span>}
            </div>
          </div>
        </div>
      </>}
    </section>
  );
}

/** The candidates as cards, reordered by a handle's drag, its arrow keys, or the arrows beside each card. */
function CandidateList({ policy, t, keys, accounts, open, problems, refusedId, refusedCondition, colourOf, onOpen, onMove, onEdit, onRemove }: {
  policy: Policy; t: Text; keys: RoutingKey[] | null; accounts: AccountsView | null; open: string | null;
  problems: Map<string, { at: string; text: string }[]>; refusedId?: string; refusedCondition?: number;
  colourOf: (id: string) => number; onOpen: (id: string | null) => void; onMove: (from: number, to: number, focus?: boolean) => void;
  onEdit: (id: string, change: (c: Candidate) => Candidate) => void; onRemove: (id: string) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number; y0: number; line: number } | null>(null);
  const cards = () => [...(list.current?.querySelectorAll<HTMLLIElement>(":scope > .routing-cand") ?? [])];
  const start = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ from: index, to: index, dy: 0, y0: event.clientY, line: -1 });
  };
  const follow = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dy = event.clientY - drag.y0;
    const items = cards();
    const dragged = items[drag.from];
    if (!dragged || !list.current) return;
    const top = list.current.getBoundingClientRect().top;
    const middle = dragged.getBoundingClientRect().top - (drag.dy) + dragged.offsetHeight / 2 + dy;
    // The place among the others whose middles are above the dragged card's.
    const others = items.filter((_, i) => i !== drag.from);
    let to = 0;
    for (const other of others) if (other.getBoundingClientRect().top + other.offsetHeight / 2 < middle) to++;
    const edge = to < others.length ? others[to].getBoundingClientRect().top - 4 : others.at(-1) ? others.at(-1)!.getBoundingClientRect().bottom + 4 : 0;
    setDrag({ ...drag, dy, to, line: edge - top });
  };
  const end = () => {
    if (drag && drag.to !== drag.from) onMove(drag.from, drag.to);
    setDrag(null);
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onMove(index, index + (event.key === "ArrowUp" ? -1 : 1), true);
  };
  if (!policy.candidates.length) return <p className="settings-block-help routing-none">{t.none}</p>;
  return (
    <ol ref={list} className={`routing-list${policy.enabled ? "" : " is-off"}`} aria-label={t.orderTitle}>
      {policy.candidates.map((c, i) => {
        const title = titleOf(c);
        const name = nameOf(c);
        const cred = credentialWords(c, t, keys, accounts);
        const issues = problems.get(c.id) ?? [];
        const expanded = open === c.id;
        const dragging = drag?.from === i;
        const readingBound = c.conditions.some((x) => x.kind === "quota") || c.credential.kind === "pool";
        return (
          <li key={c.id} className={`routing-cand${c.enabled ? "" : " is-disabled"}${dragging ? " is-dragging" : ""}${refusedId === c.id ? " is-refused" : ""}`}
            data-cand={c.id} style={{ ["--cc" as string]: `var(--route-c${colourOf(c.id)})`, ...(dragging ? { transform: `translateY(${drag.dy}px)` } : {}) }}>
            <div className="routing-cand-head">
              <button type="button" className="routing-grip" aria-label={t.grip(name)} aria-roledescription="sortable"
                onPointerDown={(e) => start(e, i)} onPointerMove={follow} onPointerUp={end} onPointerCancel={() => setDrag(null)} onKeyDown={(e) => keyMove(e, i)}>
                <GripVertical size={16} aria-hidden="true" />
              </button>
              <span className={`routing-num${colourOf(c.id) === 4 ? " is-light" : ""}`} aria-hidden="true">{i + 1}</span>
              <div className="routing-cand-main">
                <div className="routing-cand-title">
                  <span>{title}</span>
                  {c.credential.kind === "apiKey" ? <span className="settings-tag">{t.tagApi}</span>
                    : c.harness !== "opencode" && <span className="settings-tag">{t.tagSub}</span>}
                  {issues.length > 0 && !expanded && <span className="settings-tag is-error">{t.needsFix}</span>}
                </div>
                <div className={`routing-cand-sub${cred.missing ? " is-missing" : ""}`}>{cred.missing && <CircleAlert size={12} className="routing-icon" aria-hidden="true" />} {cred.text}</div>
              </div>
              <div className="routing-cand-end">
                <span className="routing-move">
                  <button type="button" className="icon-button" aria-label={t.moveUp(name)} disabled={i === 0} onClick={() => onMove(i, i - 1)}><ChevronUp size={16} /></button>
                  <button type="button" className="icon-button" aria-label={t.moveDown(name)} disabled={i === policy.candidates.length - 1} onClick={() => onMove(i, i + 1)}><ChevronDown size={16} /></button>
                </span>
                <input type="checkbox" role="switch" className="settings-toggle" aria-label={t.enable(name)} checked={c.enabled}
                  onChange={(e) => onEdit(c.id, (x) => ({ ...x, enabled: e.target.checked }))} />
                <button type="button" className="icon-button" aria-expanded={expanded} aria-controls={`routing-edit-${c.id}`}
                  aria-label={expanded ? t.collapse(name) : t.edit(name)} onClick={() => onOpen(expanded ? null : c.id)}>
                  {expanded ? <ChevronUp size={15} /> : <Pencil size={15} />}
                </button>
              </div>
            </div>
            <div className="routing-cand-body">
              <div className="routing-chips">
                {c.conditions.map((cond, n) => {
                  const Icon = chipIcon(cond);
                  const chip = <span key={n} className="routing-chip"><Icon size={13} aria-hidden="true" /><span>{chipText(cond, t)}</span></span>;
                  // A time window's chip names its first period; its tip has every one (YN-44's Tip).
                  return isKnown(cond) && cond.kind === "timeWindow"
                    ? <Tip key={n} content={<TipText title={`${t.timeWindow} · ${zoneWords(cond.schedule, t)}`} status={cond.inside ? t.insideOption : t.outsideOption}
                        body={cond.schedule.slots.map((slot) => slotWords(slot, t)).join(t.slotJoin)} />}>{chip}</Tip>
                    : chip;
                })}
                {c.credential.kind === "pool" && <span className="routing-chip"><Layers size={13} aria-hidden="true" /><span>{t.chipPick}</span></span>}
                {readingBound && <span className="routing-chip"><CircleHelp size={13} aria-hidden="true" /><span>{c.unknown === "pass" ? t.chipPass : t.chipSkip}</span></span>}
              </div>
              {expanded && (
                <CandidateEditor c={c} t={t} keys={keys ?? []} accounts={accounts} issues={issues} refusedCondition={refusedId === c.id ? refusedCondition : undefined}
                  onEdit={(change) => onEdit(c.id, change)} onRemove={() => onRemove(c.id)} onClose={() => onOpen(null)} />
              )}
            </div>
          </li>
        );
      })}
      {drag && drag.to !== drag.from && <li className="routing-drop-line" aria-hidden="true" style={{ top: drag.line }} />}
    </ol>
  );
}

/** The credential choices a harness offers, by a value of the select: "login", "pool", "key:<id>", "home:<id>". */
function credentialChoices(harness: Harness, t: Text, keys: RoutingKey[], accounts: AccountsView | null, current: Credential): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = [
    { value: "login", label: harness === "claude" ? t.credLoginClaude : harness === "codex" ? t.credLoginCodex : t.credLoginOpencode },
  ];
  if (harness === "claude") choices.push({ value: "pool", label: t.credPool });
  if (harness === "codex") for (const h of accounts?.codexHomes ?? []) choices.push({ value: `home:${h.id}`, label: t.credHome(h.label) });
  for (const k of keys) if (keyFits(harness, k.provider)) choices.push({ value: `key:${k.id}`, label: t.credKey(providerName[k.provider] ?? k.provider, k.id) });
  // The saved one, even if it's no longer offered: it stays chosen, marked.
  const value = credentialValue(current);
  if (!choices.some((c) => c.value === value)) choices.push({ value, label: current.kind === "apiKey" ? t.keyMissing(current.keyId) : current.kind === "codexHome" ? t.codexHomeMissing(current.id) : value });
  return choices;
}
const credentialValue = (c: Credential) => (c.kind === "apiKey" ? `key:${c.keyId}` : c.kind === "codexHome" ? `home:${c.id}` : c.kind);
const credentialOf = (value: string): Credential =>
  value === "pool" ? { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }
    : value.startsWith("key:") ? { kind: "apiKey", keyId: value.slice(4) }
      : value.startsWith("home:") ? { kind: "codexHome", id: value.slice(5) } : { kind: "login" };

function CandidateEditor({ c, t, keys, accounts, issues, refusedCondition, onEdit, onRemove, onClose }: {
  c: Candidate; t: Text; keys: RoutingKey[]; accounts: AccountsView | null; issues: { at: string; text: string }[]; refusedCondition?: number;
  onEdit: (change: (c: Candidate) => Candidate) => void; onRemove: () => void; onClose: () => void;
}) {
  const choices = credentialChoices(c.harness, t, keys, accounts, c.credential);
  const api = usesApi(c);
  const has = (kind: string) => c.conditions.some((x) => x.kind === kind);
  const setConditions = (change: (list: AnyCondition[]) => AnyCondition[]) => onEdit((x) => ({ ...x, conditions: change(x.conditions) }));
  const pool = c.credential.kind === "pool" ? c.credential : null;
  const cswapAccounts = accounts?.cswap.accounts ?? [];
  const field = (key: string, value: unknown) => onEdit((x) => {
    const next = { ...x } as Candidate;
    if (value === "" || value == null) delete next[key]; else next[key] = value;
    return next;
  });
  return (
    <div className="routing-edit" id={`routing-edit-${c.id}`}>
      <div className="routing-edit-grid">
        <label className="routing-field"><span>{t.label}</span>
          <input className="settings-input" value={c.label ?? ""} maxLength={60} placeholder={t.labelPlaceholder} onChange={(e) => field("label", e.target.value)} />
        </label>
        <label className="routing-field"><span>{t.harness}</span>
          <select className="settings-select" value={c.harness} onChange={(e) => {
            const harness = e.target.value as Harness;
            onEdit((x) => {
              const { reasoningEffort: _, ...rest } = x;
              const keyKept = x.credential.kind !== "apiKey" || keys.some((k) => k.id === (x.credential as { keyId: string }).keyId && keyFits(harness, k.provider));
              // A reasoning effort is Codex's only (S3a); an account or key the new tool can't use goes back to the host's login.
              return { ...(harness === "codex" ? x : rest), harness, model: MODEL_HINTS[harness][0],
                ...(credentialFits(harness, x.credential) && keyKept ? {} : { credential: { kind: "login" } as Credential }) } as Candidate;
            });
          }}>
            {HARNESSES.map((h) => <option key={h} value={h}>{harnessName[h]}</option>)}
          </select>
        </label>
        <label className="routing-field"><span>{t.model}</span>
          <input className="settings-input" value={c.model ?? ""} list={`routing-models-${c.harness}`} spellCheck={false} placeholder={t.modelPlaceholder}
            onChange={(e) => onEdit((x) => ({ ...x, model: e.target.value }))} />
          <datalist id={`routing-models-${c.harness}`}>{MODEL_HINTS[c.harness].map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        {c.harness === "codex" && (
          <label className="routing-field"><span>{t.effort}</span>
            <select className="settings-select" value={c.reasoningEffort ?? ""} onChange={(e) => field("reasoningEffort", e.target.value)}>
              <option value="">{t.effortDefault}</option>
              {[...EFFORTS, ...(c.reasoningEffort && !EFFORTS.includes(c.reasoningEffort) ? [c.reasoningEffort] : [])].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        )}
        <label className="routing-field routing-field-wide"><span>{t.credential}</span>
          <select className="settings-select" value={credentialValue(c.credential)} onChange={(e) => {
            const credential = credentialOf(e.target.value);
            onEdit((x) => ({ ...x, credential,
              // A cap is for an API key, subscription left for an account.
              conditions: x.conditions.filter((cond) => (credential.kind === "apiKey" ? cond.kind !== "quota" : cond.kind !== "dailyApiCap")) }));
          }}>
            {choices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      {pool && (
        <fieldset className="routing-field routing-pool">
          <legend>{t.poolAccounts}</legend>
          <label><input type="radio" name={`pool-${c.id}`} checked={pool.accounts === "all"} onChange={() => onEdit((x) => ({ ...x, credential: { ...pool, accounts: "all" } }))} /> {t.poolAll}</label>
          <label><input type="radio" name={`pool-${c.id}`} checked={pool.accounts !== "all"}
            onChange={() => onEdit((x) => ({ ...x, credential: { ...pool, accounts: cswapAccounts.map((a) => a.fingerprint) } }))} /> {t.poolSome}</label>
          {pool.accounts !== "all" && (cswapAccounts.length ? (
            <div className="routing-pool-accounts">
              {cswapAccounts.map((a) => {
                const chosen = (pool.accounts as string[]).includes(a.fingerprint);
                return (
                  <label key={a.fingerprint}>
                    <input type="checkbox" checked={chosen} onChange={() => onEdit((x) => ({ ...x, credential: { ...pool,
                      accounts: chosen ? (pool.accounts as string[]).filter((f) => f !== a.fingerprint) : [...(pool.accounts as string[]), a.fingerprint] } }))} />
                    {t.account(a.number)} <code>{shortFingerprint(a.fingerprint)}</code>
                  </label>
                );
              })}
            </div>
          ) : <p className="settings-row-meta">{t.noAccounts}</p>)}
        </fieldset>
      )}
      <div className="routing-field routing-conditions">
        <span>{t.conditions}</span>
        {c.conditions.length === 0 && <p className="settings-row-meta">{t.noConditions}</p>}
        <ul className="routing-conds">
          {c.conditions.map((cond, i) => (
            <li key={i} className={`routing-cond${refusedCondition === i ? " is-refused" : ""}`}>
              <ConditionEditor cond={cond} n={i} t={t} onChange={(next) => setConditions((list) => list.map((x, k) => (k === i ? next : x)))} />
              <button type="button" className="icon-button routing-cond-remove" aria-label={`${t.removeCondition} (${chipText(cond, t)})`}
                onClick={() => setConditions((list) => list.filter((_, k) => k !== i))}><X size={14} /></button>
              {issues.filter((p) => p.at === String(i)).map((p) => <span key={p.text} className="inline-error routing-cond-error">{p.text}</span>)}
            </li>
          ))}
        </ul>
        <div className="routing-add-menu">
          {!has("timeWindow") && <button type="button" className="quiet-button" onClick={() => setConditions((l) => [...l, { kind: "timeWindow", inside: false, schedule: DEEPSEEK_PEAK, minMinutesLeft: 30 }])}><Plus size={13} /> {t.addTime}</button>}
          {!has("quota") && !api && <button type="button" className="quiet-button" onClick={() => setConditions((l) => [...l, { kind: "quota", fiveHourLeftPct: 15, weekLeftPct: 10 }])}><Plus size={13} /> {t.addQuota}</button>}
          {!has("dailyApiCap") && api && <button type="button" className="quiet-button" onClick={() => setConditions((l) => [...l, { kind: "dailyApiCap", usd: 5 }])}><Plus size={13} /> {t.addCap}</button>}
        </div>
      </div>
      <fieldset className="routing-field routing-unknown">
        <legend>{t.unknown}</legend>
        {(["skip", "pass"] as const).map((v) => (
          <label key={v}><input type="radio" name={`unknown-${c.id}`} checked={c.unknown === v} onChange={() => onEdit((x) => ({ ...x, unknown: v }))} /> {v === "skip" ? t.skip : t.pass}</label>
        ))}
      </fieldset>
      {issues.filter((p) => p.at === "").map((p) => <p key={p.text} className="inline-error">{p.text}</p>)}
      <div className="routing-form-actions">
        <button type="button" className="quiet-button routing-danger" onClick={onRemove}><Trash2 size={14} /> {t.remove}</button>
        <span className="routing-spacer" />
        <button type="button" className="secondary-button" onClick={onClose}>{t.done}</button>
      </div>
    </div>
  );
}

const numberOrUnset = (value: string) => (value === "" ? undefined : Number(value));
/** `to` as a time field shows it: 24:00, midnight at the end, is 00:00 there. */
const toField = (to: string) => (to === "24:00" ? "00:00" : to);
const fromField = (value: string) => (value === "00:00" ? "24:00" : value);

function ConditionEditor({ cond, n, t, onChange }: { cond: AnyCondition; n: number; t: Text; onChange: (next: AnyCondition) => void }) {
  if (!isKnown(cond)) return <span className="routing-cond-kind">{t.chipUnknownKind(cond.kind)}</span>;
  if (cond.kind === "quota") {
    const set = (key: "fiveHourLeftPct" | "weekLeftPct", value: string) => {
      const next: Condition = { ...cond };
      const v = numberOrUnset(value);
      if (v == null) delete next[key]; else next[key] = Math.max(0, Math.min(100, v));
      onChange(next);
    };
    return <>
      <b className="routing-cond-kind">{t.quota}</b>
      <label className="routing-inline-field">{t.fiveHour}
        <input type="number" className="settings-input routing-number" min={0} max={100} value={cond.fiveHourLeftPct ?? ""} onChange={(e) => set("fiveHourLeftPct", e.target.value)} />%</label>
      <label className="routing-inline-field">{t.week}
        <input type="number" className="settings-input routing-number" min={0} max={100} value={cond.weekLeftPct ?? ""} onChange={(e) => set("weekLeftPct", e.target.value)} />%</label>
    </>;
  }
  if (cond.kind === "dailyApiCap") {
    return <>
      <b className="routing-cond-kind">{t.cap}</b>
      <label className="routing-inline-field">{t.capOwn}
        <input type="number" className="settings-input routing-number" min={0} step={1} inputMode="decimal" value={Number.isFinite(cond.usd) ? cond.usd : ""}
          aria-invalid={!(cond.usd > 0) || undefined} onChange={(e) => onChange({ ...cond, usd: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
    </>;
  }
  const deepseek = sameSchedule(cond.schedule, DEEPSEEK_PEAK);
  const schedule = cond.schedule;
  const setSlots = (slots: Slot[]) => onChange({ ...cond, schedule: { ...schedule, slots } });
  const setSlot = (i: number, slot: Partial<Slot>) => setSlots(schedule.slots.map((s, k) => (k === i ? { ...s, ...slot } : s)));
  return (
    <div className="routing-window">
      <div className="routing-window-head">
        <b className="routing-cond-kind">{t.timeWindow}</b>
        <select className="settings-select" aria-label={`${t.timeWindow} ${n + 1}`} value={cond.inside ? "inside" : "outside"} onChange={(e) => onChange({ ...cond, inside: e.target.value === "inside" })}>
          <option value="outside">{t.outsideOption}</option>
          <option value="inside">{t.insideOption}</option>
        </select>
        <label className="routing-inline-field">{t.timeZone}
          <select className="settings-select" value={schedule.timeZone} onChange={(e) => onChange({ ...cond, schedule: { ...schedule, timeZone: e.target.value as Schedule["timeZone"] } })}>
            <option value="UTC">{t.utc}</option>
            <option value="local">{t.local}</option>
          </select>
        </label>
        <button type="button" className="quiet-button" aria-pressed={deepseek} onClick={() => onChange({ ...cond, schedule: DEEPSEEK_PEAK })}>{t.useDeepseek}</button>
      </div>
      {deepseek && <p className="settings-row-meta">{t.deepseekHelp}</p>}
      <ol className="routing-slots">
        {schedule.slots.map((slot, i) => (
          <li key={i} className="routing-slot">
            <span className="routing-days" role="group" aria-label={t.slot(i + 1)}>
              {t.days.map((day, d) => (
                <button type="button" key={day} aria-pressed={slot.days.includes(d + 1)} aria-label={t.dayOf(i + 1, day)}
                  onClick={() => setSlot(i, { days: slot.days.includes(d + 1) ? slot.days.filter((x) => x !== d + 1) : [...slot.days, d + 1].sort((a, b) => a - b) })}>
                  {day.replace("周", "")}
                </button>
              ))}
            </span>
            <input type="time" className="settings-input routing-time" aria-label={t.from(i + 1)} value={slot.from} step={900} onChange={(e) => e.target.value && setSlot(i, { from: e.target.value })} />
            <span aria-hidden="true">–</span>
            <input type="time" className="settings-input routing-time" aria-label={t.to(i + 1)} value={toField(slot.to)} step={900} onChange={(e) => e.target.value && setSlot(i, { to: fromField(e.target.value) })} />
            <button type="button" className="icon-button" aria-label={t.removeSlot(i + 1)} onClick={() => setSlots(schedule.slots.filter((_, k) => k !== i))}><X size={13} /></button>
          </li>
        ))}
      </ol>
      <div className="routing-form-actions">
        <button type="button" className="quiet-button" disabled={schedule.slots.length >= 16}
          onClick={() => setSlots([...schedule.slots, { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }])}><Plus size={13} /> {t.addSlot}</button>
        <span className="settings-row-meta">{t.toHelp}</span>
      </div>
      <label className="routing-inline-field">{t.minLeft}
        <input type="number" className="settings-input routing-number" min={1} max={1440} step={5} value={cond.minMinutesLeft ?? ""}
          aria-invalid={(cond.minMinutesLeft != null && cond.minMinutesLeft > 1440) || undefined}
          onChange={(e) => { const next = { ...cond }; const v = numberOrUnset(e.target.value); if (!v) delete next.minMinutesLeft; else next.minMinutesLeft = v; onChange(next); }} />
        {t.minutes}
      </label>
    </div>
  );
}


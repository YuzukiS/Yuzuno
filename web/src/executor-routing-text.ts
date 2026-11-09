/** Executor routing's words (YN-49 S4a), in English and Chinese, and what
 * a candidate, a condition or a schedule is called in a line; and what keeps a
 * candidate from being saved, as YN-34 S3a's check refuses it. */
import { DEEPSEEK_PEAK, credentialFits, isKnown, keyFits, modelShort, sameSchedule, type AnyCondition, type Candidate, type Harness, type PresetId, type Schedule, type Slot } from "./executor-routing";
import { strings } from "./i18n";
import type { AccountsView, RoutingKey } from "./routing-keys";


export const harnessName: Record<Harness, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
export const providerName: Record<string, string> = { deepseek: "DeepSeek", anthropic: "Anthropic", openai: "OpenAI" };

export const text = strings({
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
  /** The pill is a button that opens the candidate's editor (YN-57). */
  fixIt: (title: string) => `Needs a fix: edit ${title}`,
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
  fixIt: (title) => `需要修改：编辑 ${title}`,
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
export type Text = ReturnType<typeof text>;

/** One period in a few words: its days and hours. */
export function slotWords(slot: Slot, t: Text): string {
  const days = [...slot.days].sort((a, b) => a - b);
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = days.length === 7 ? "" : contiguous ? t.dayRange(t.days[days[0] - 1], t.days[days.at(-1)! - 1]) : days.map((d) => t.days[d - 1]).join(" ");
  return `${dayText ? `${dayText} ` : ""}${slot.from}–${slot.to}`;
}
export const zoneWords = (schedule: Schedule, t: Text) => (schedule.timeZone === "UTC" ? t.utc : t.local);
/** A schedule in a few words, for its chip: its zone, its first period, and how many more. */
export function scheduleWords(schedule: Schedule, t: Text): string {
  const slot = schedule.slots[0];
  if (!slot) return t.timeWindow;
  return `${zoneWords(schedule, t)} ${slotWords(slot, t)}${schedule.slots.length > 1 ? t.moreSlots(schedule.slots.length - 1) : ""}`;
}

export function chipText(c: AnyCondition, t: Text): string {
  if (!isKnown(c)) return t.chipUnknownKind(c.kind);
  if (c.kind === "quota") return t.chipQuota(c.fiveHourLeftPct, c.weekLeftPct) || t.quota;
  if (c.kind === "dailyApiCap") return t.chipCap(c.usd);
  if (sameSchedule(c.schedule, DEEPSEEK_PEAK)) return c.inside ? t.chipPeakOn : t.chipPeakOff(c.minMinutesLeft);
  return (c.inside ? t.chipInside : t.chipOutside)(scheduleWords(c.schedule, t), c.minMinutesLeft);
}

/** What a candidate's account or key is, in a line. */
export function credentialWords(c: Candidate, t: Text, keys: RoutingKey[] | null, accounts: AccountsView | null): { text: string; missing: boolean } {
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
export const titleOf = (c: Candidate) => c.label?.trim() || [harnessName[c.harness] ?? c.harness, modelShort(c.model ?? "")].filter(Boolean).join(" · ");
/** A candidate's name where its card's API tag isn't beside it (labels,
 * announcements, a newer version's order): one with an API key says so, so
 * "Claude Code · opus" by subscription and by API key are told apart. */
export const nameOf = (c: Candidate) => (c.label?.trim() || c.credential.kind !== "apiKey" ? titleOf(c) : `${titleOf(c)} · API`);

export const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const usdFits = (n: number | undefined) => n != null && n > 0 && n <= 10_000;

/** What keeps a candidate from being saved, by where it is ("" the candidate,
 * else a condition's place), as Core's check (YN-34 S3a) would refuse it, so
 * it is said here before a save. */
export function problemsOf(c: Candidate, t: Text, keys: RoutingKey[] | null, accounts: AccountsView | null): { at: string; text: string }[] {
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

/**
 * What this window can tell about its own failures, for the user to copy and
 * paste into a report when something goes wrong, without developer tools.
 * Nothing here is sent anywhere.
 *
 * It keeps a bounded, de-duplicated record of the UI's errors on this device,
 * made only of what this product defines: each error's kind, a name and codes
 * from fixed lists, a fixed summary for common failures and positions in this
 * product's own bundle. No text an error carries is kept: not its message, a
 * rejection's reason, a name or code outside those lists, or a schema's keys
 * other than the product's own. Whatever a request, a conversation or a draft
 * held can't reach the record that way. Recording can never raise another
 * error.
 */
import { API_BASE, isTauri } from "./api";

const STORE = "yuzuno.diagnostics.v1";
const MAX_ENTRIES = 12;
const MAX_FRAMES = 4;
const MAX_STORED = 8_000;
const READ_MS = 2_000;

/** render: the whole app failed to draw; section: one Brief section did;
 * error / rejection: an uncaught error or promise rejection in the window. */
export type ErrorKind = "render" | "section" | "error" | "rejection";
export type ErrorEntry = {
  kind: ErrorKind;
  name: string;
  codes: string[];
  summary: string;
  where: string[];
  first: string;
  last: string;
  count: number;
};
/** A read of Core's health or the desktop's version, kept with its time. */
export type CoreRead = { at: string; version: string; releaseId: string | null; apiReady: boolean | null; storageReady: boolean | null };
export type DesktopRead = { at: string; version: string };
/** Core's memory counters (T-140), read only when the text is made and never
 * stored: numbers, and only the names of the reasons Core defines. */
export type MemoryRead = {
  at: string;
  os: { rss: number | null; hwm: number | null; anon: number | null; file: number | null; swap: number | null; threads: number | null } | null;
  allocator: { arena: number | null; uordblks: number | null; fordblks: number | null; hblkhd: number | null } | null;
  held: number | null;
  heldMax: number | null;
  inFlight: number | null;
  includesThisRequest: boolean | null;
  tick: boolean | null;
  waiting: string[] | null;
  otherWaiting: number;
  last: { result: string; at: string | null; rssBefore: number | null; rssAfter: number | null } | null;
};
type Stored = { errors: ErrorEntry[]; core?: CoreRead; desktop?: DesktopRead };

export const pageLoadedAt = new Date().toISOString();
let stored: Stored | null = null;
let recording = false;

const identifier = (value: unknown, max = 60) =>
  typeof value === "string" && new RegExp(`^[\\w$.:-]{1,${max}}$`).test(value) ? value : null;

/** Error names kept as they are: the language's, the browser's and this
 * product's own. Any other name is kept as "Error". A thrown value that is not
 * an error is named by its type. */
const NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError",
  "DOMException", "AbortError", "NotAllowedError", "NotFoundError", "NotSupportedError", "NotReadableError",
  "NetworkError", "TimeoutError", "QuotaExceededError", "SecurityError", "InvalidStateError", "DataCloneError",
  "HttpError", "ZodError", "ResultError", "BriefError", "ResultChunkError", "SnapshotTimeoutError",
  "string", "number", "bigint", "boolean", "symbol", "undefined", "object", "function", "null",
]);
/** A schema's issue codes (zod 4). */
const ISSUE_CODES = new Set([
  "invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys",
  "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom",
]);
/** Codes this product gives its own errors: Core's that the UI acts on, and
 * the result and Brief contracts' (intelligent-ui). Any other code is kept as
 * "other code". */
const CODES = new Set([
  "message_not_submitted",
  "ask_required", "ask_without_reply", "attachment_location", "block_too_long", "chart_attachment", "chart_data",
  "columns_widths", "component_count", "duplicate_attachment", "duplicate_id", "extra_action", "extra_result",
  "extra_root", "invalid_field", "invalid_json", "invalid_result", "invalid_section", "invalid_source",
  "misplaced_field", "missing_attachment", "missing_component", "missing_field", "missing_source",
  "multiple_results", "not_a_tree", "root", "row_mismatch", "status_required", "too_large", "too_long",
  "too_many", "too_many_points", "too_many_refs", "unfinished", "unknown_component", "unknown_field",
  "unused_attachment", "unused_component",
]);
/** Keys a schema may name that this product adds itself (BriefSectionBody's
 * change mark); any other key is only counted. */
const KEYS = new Set(["yuzunoChange"]);

/** A fixed summary for common failures. It is chosen by the message but never
 * made from it: only the summary's own text is kept. */
const SUMMARIES: [RegExp, string][] = [
  [/^Cannot read propert(?:y|ies) of null\b/, "read a property of null"],
  [/^Cannot read propert(?:y|ies) of undefined\b/, "read a property of undefined"],
  [/^Cannot set propert(?:y|ies) of (?:null|undefined)\b/, "set a property of null or undefined"],
  [/^(?:null|undefined) is not an object\b|\bis (?:null|undefined)$/, "read a property of null or undefined"],
  [/\bis not a function\b/, "called something that is not a function"],
  [/\bis not iterable\b/, "went through something that can't be iterated"],
  [/\bis not defined$/, "used a name that is not defined"],
  [/^Maximum call stack size exceeded$|^too much recursion$/, "too much recursion"],
  [/^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/, "a request did not reach the server"],
  [/\bnot valid JSON\b|^JSON\.parse\b|^Unexpected (?:token|end of JSON input)\b/, "a text that is not valid JSON"],
  [/dynamically imported module|Importing a module script failed/i, "a part of the web UI could not be loaded"],
  [/^ResizeObserver loop\b/, "a ResizeObserver loop"],
  [/^Script error\.?$/, "an error the browser hides (a script from another origin)"],
];
const REACT_ERROR = /^Minified React error #(\d{1,4})\b/;
const OTHER = "other message, not kept";
const SUMMARY_TEXTS = new Set([...SUMMARIES.map(([, summary]) => summary), OTHER]);

function summaryOf(message: unknown) {
  if (typeof message !== "string" || !message.trim()) return "";
  const text = message.replace(/^Uncaught (?:\w+: )?/, "").trim().slice(0, 400);
  const react = text.match(REACT_ERROR);
  if (react) return `React error #${react[1]}`;
  return SUMMARIES.find(([pattern]) => pattern.test(text))?.[1] ?? OTHER;
}

/** A schema issue's keys: the product's own by name, the others counted. */
function keysOf(keys: unknown[]) {
  const own = [...new Set(keys.filter((key): key is string => typeof key === "string" && KEYS.has(key)))];
  const other = keys.filter((key) => typeof key !== "string" || !KEYS.has(key)).length;
  return [...own, ...(other ? [`${other} other`] : [])].join(",");
}

/** An error's codes: a schema's issue codes with the keys they name, an
 * error's own code and an HTTP status, each from the lists above. */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  const value = error as { issues?: unknown; code?: unknown; status?: unknown } | null;
  if (value && Array.isArray(value.issues))
    for (const issue of value.issues.slice(0, 4)) {
      const raw = (issue as { code?: unknown } | null)?.code;
      const code = typeof raw === "string" && ISSUE_CODES.has(raw) ? raw : "other issue";
      const keys = (issue as { keys?: unknown } | null)?.keys;
      codes.push(Array.isArray(keys) && keys.length ? `${code}:${keysOf(keys.slice(0, 50))}` : code);
    }
  if (value && typeof value.code === "string") codes.push(CODES.has(value.code) ? value.code : "other code");
  else if (value && Number.isSafeInteger(value.code) && value.code !== 0 && Math.abs(value.code as number) < 100_000) codes.push(`code ${value.code}`);
  if (value && Number.isInteger(value.status) && (value.status as number) >= 100 && (value.status as number) <= 599) codes.push(`http ${value.status}`);
  return [...new Set(codes)];
}

const KINDS: ErrorKind[] = ["render", "section", "error", "rejection"];
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const keptName = (value: unknown) => (typeof value === "string" && NAMES.has(value) ? value : "Error");
function keptCode(value: unknown) {
  if (typeof value !== "string") return "other code";
  if (CODES.has(value) || ISSUE_CODES.has(value) || value === "other code" || value === "other issue") return value;
  if (/^(?:http [1-5]\d\d|code -?[1-9]\d{0,4})$/.test(value)) return value;
  const issue = value.match(/^([a-z_ ]{1,40}):([\w ,]{1,200})$/);
  if (issue && (ISSUE_CODES.has(issue[1]) || issue[1] === "other issue") &&
      issue[2].split(",").every((part) => KEYS.has(part) || /^\d{1,4} other$/.test(part)))
    return value;
  return "other code";
}
function keptFrame(value: unknown) {
  if (typeof value !== "string") return null;
  const frame = value.match(/(?:^| @ )([\w.-]{1,80}\.js:\d{1,7}:\d{1,7})$/);
  if (frame) return frame[1];
  return /^\+\d{1,3} frames? outside Yuzuno$/.test(value) ? value : null;
}
/** A kept entry as these rules write it, or null. A record from an earlier
 * version, or one changed by hand, goes through the same lists: none of its
 * text is shown unless these rules would have kept it. */
function normalized(value: unknown): ErrorEntry | null {
  const e = value as (Partial<ErrorEntry> & { message?: unknown }) | null;
  if (!e || !KINDS.includes(e.kind as ErrorKind) || !TIME.test(String(e.first)) || !TIME.test(String(e.last))) return null;
  const summary = typeof e.summary === "string" && (SUMMARY_TEXTS.has(e.summary) || /^React error #\d{1,4}$/.test(e.summary))
    ? e.summary
    : summaryOf(e.message);
  return {
    kind: e.kind as ErrorKind,
    name: keptName(e.name),
    codes: Array.isArray(e.codes) ? [...new Set(e.codes.slice(0, 8).map(keptCode))] : [],
    summary,
    where: Array.isArray(e.where) ? (e.where.slice(0, MAX_FRAMES + 1).map(keptFrame).filter(Boolean) as string[]) : [],
    first: e.first as string,
    last: e.last as string,
    count: Number.isSafeInteger(e.count) && e.count! > 0 ? e.count! : 1,
  };
}

function load(): Stored {
  if (stored) return stored;
  stored = { errors: [] };
  try {
    const raw = localStorage.getItem(STORE);
    const value = JSON.parse(raw || "null");
    if (value && Array.isArray(value.errors)) {
      stored = {
        errors: value.errors.map(normalized).filter(Boolean).slice(0, MAX_ENTRIES) as ErrorEntry[],
        core: value.core && identifier(value.core.version, 80) && TIME.test(String(value.core.at))
          ? { at: value.core.at, version: value.core.version, releaseId: identifier(value.core.releaseId, 80),
              apiReady: typeof value.core.apiReady === "boolean" ? value.core.apiReady : null,
              storageReady: typeof value.core.storageReady === "boolean" ? value.core.storageReady : null }
          : undefined,
        desktop: value.desktop && identifier(value.desktop.version, 40) && TIME.test(String(value.desktop.at))
          ? { at: value.desktop.at, version: value.desktop.version }
          : undefined,
      };
      // An earlier record is stored again as these rules keep it, so its text
      // doesn't stay on the device either. Only this record is touched.
      if (JSON.stringify(stored) !== raw) save();
    }
  } catch {
    /* Unreadable or unavailable storage: this visit's record only. */
  }
  return stored;
}

function save() {
  const value = stored!;
  try {
    let text = JSON.stringify(value);
    while (text.length > MAX_STORED && value.errors.length > 1) {
      value.errors.pop();
      text = JSON.stringify(value);
    }
    localStorage.setItem(STORE, text);
  } catch {
    /* Without storage the record lasts for this visit. */
  }
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** This product's own frames ("file.js:line:column", the bundle's file name
 * only, no function names), at most MAX_FRAMES; frames from anywhere else are
 * counted. A V8 stack starts with the error's message, which may hold
 * anything, so frames are read only after it. */
export function productFrames(stack: unknown, message?: unknown): string[] {
  if (typeof stack !== "string") return [];
  let text = stack;
  if (typeof message === "string" && message) {
    const at = text.indexOf(message);
    if (at >= 0) text = text.slice(at + message.length);
  }
  const frames: string[] = [];
  let other = 0;
  for (const line of text.split("\n").slice(0, 50)) {
    const match =
      line.match(/^\s*at\s+(?:.*?\s+\()?(\S+?):(\d{1,7}):(\d{1,7})\)?\s*$/) ??
      line.match(/^\s*[^@\s]*@(\S+?):(\d{1,7}):(\d{1,7})\s*$/);
    if (!match) continue;
    const [, location, row, column] = match;
    let file: string | null = null;
    try {
      const url = new URL(location, window.location.href);
      if (url.origin === window.location.origin) file = url.pathname.match(/\/assets\/([\w.-]{1,80}\.js)$/)?.[1] ?? null;
    } catch {
      file = null;
    }
    if (!file) {
      other++;
      continue;
    }
    if (frames.length < MAX_FRAMES) frames.push(`${file}:${row}:${column}`);
  }
  if (other) frames.push(`+${Math.min(other, 999)} ${other === 1 ? "frame" : "frames"} outside Yuzuno`);
  return frames;
}

function describe(error: unknown) {
  if (error && typeof error === "object" && (error instanceof Error || "message" in error)) {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown; issues?: unknown; status?: unknown };
    // A schema error's message repeats its issues, data included, and an HTTP
    // error's message is the response's text: their codes say what failed.
    const summary = Array.isArray(value.issues) || typeof value.status === "number" ? "" : summaryOf(value.message);
    return { name: keptName(value.name), codes: codesOf(error), summary, where: productFrames(value.stack, value.message) };
  }
  return { name: error === null ? "null" : typeof error, codes: [], summary: summaryOf(error), where: [] };
}

/** Keeps one error: the same one again only counts and moves up. */
export function recordError(kind: ErrorKind, error: unknown) {
  if (recording) return;
  recording = true;
  try {
    const record = load();
    const entry = describe(error);
    const now = new Date().toISOString();
    const same = (e: ErrorEntry) =>
      e.kind === kind && e.name === entry.name && e.summary === entry.summary &&
      e.codes.join(" ") === entry.codes.join(" ") && (e.where[0] ?? "") === (entry.where[0] ?? "");
    const found = record.errors.find(same);
    if (found) {
      found.count += 1;
      found.last = now;
    } else record.errors.unshift({ kind, ...entry, first: now, last: now, count: 1 });
    record.errors.sort((a, b) => b.last.localeCompare(a.last));
    record.errors.length = Math.min(record.errors.length, MAX_ENTRIES);
    save();
  } catch {
    /* Recording never raises another error. */
  } finally {
    recording = false;
  }
}

export const recordedErrors = () => {
  try {
    return [...load().errors];
  } catch {
    return [];
  }
};

let capturing = false;
/** Uncaught errors and rejections in this window are recorded too. */
export function installErrorCapture() {
  if (capturing) return;
  capturing = true;
  window.addEventListener("error", (event) => recordError("error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => recordError("rejection", event.reason));
}

function within<T>(promise: Promise<T>, ms = READ_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const why = (error: unknown) =>
  error instanceof Error && error.message === "timeout" ? "no answer within 2 s" :
  error instanceof Error && /^http \d+$/.test(error.message) ? error.message :
  "not reachable";

export type Facts = {
  at: string;
  core: { now: CoreRead | null; failed: string | null; last: CoreRead | null };
  memory?: { now: MemoryRead | null; failed: string | null };
  desktop: { now: DesktopRead | null; failed: string | null; last: DesktopRead | null } | null;
};

const WAITING = ["heldRecords", "requestsInFlight", "updateOperation", "sealed", "idleGrace", "interval", "freeBelowThreshold", "rssGrowthBelowThreshold"];
const CHECKS = ["freeBelowThreshold", "rssGrowthBelowThreshold", "trimmed"];
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
const time = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : null);
const part = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

/** Core's memory report, reduced to numbers and the names Core defines. */
export function memoryRead(report: unknown, at: string): MemoryRead | null {
  const r = part(report);
  if (r.format !== 1) return null;
  const os = part(r.os), allocator = part(r.allocator), reclaim = part(r.reclaim), gate = part(reclaim.gate), last = part(gate.lastCheck);
  const waiting = Array.isArray(gate.waitingFor) ? gate.waitingFor : null;
  const result = typeof last.result === "string" && CHECKS.includes(last.result) ? last.result : null;
  const reclaimed = part(last.reclaim);
  return {
    at,
    os: os.available === true ? { rss: count(os.rssBytes), hwm: count(os.hwmBytes), anon: count(os.anonBytes), file: count(os.fileBytes), swap: count(os.swapBytes), threads: count(os.threads) } : null,
    allocator: allocator.available === true ? { arena: count(allocator.arena), uordblks: count(allocator.uordblks), fordblks: count(allocator.fordblks), hblkhd: count(allocator.hblkhd) } : null,
    held: count(part(r.store).heldRecords),
    heldMax: count(part(r.store).maxHeldRecords),
    inFlight: count(part(r.admission).inFlight),
    includesThisRequest: flag(part(r.admission).includesThisRequest),
    tick: flag(reclaim.maintenanceTickRunning),
    waiting: reclaim.available === true && waiting ? waiting.filter((w): w is string => typeof w === "string" && WAITING.includes(w)) : null,
    otherWaiting: waiting ? waiting.filter((w) => typeof w !== "string" || !WAITING.includes(w)).length : 0,
    last: result ? { result, at: time(last.at), rssBefore: count(reclaimed.rssBeforeBytes), rssAfter: count(reclaimed.rssAfterBytes) } : null,
  };
}

/** Read within 2 s; a failure is said, and never stops the rest of the text. */
async function readMemory(at: string): Promise<NonNullable<Facts["memory"]>> {
  try {
    const response = await within(fetch(`${API_BASE}/api/diagnostics/memory`, { headers: { "X-Yuzuno-Client": "desktop" }, cache: "no-store" }));
    if (!response.ok) throw new Error(`http ${response.status}`);
    const now = memoryRead(await within(response.json()), at);
    return now ? { now, failed: null } : { now: null, failed: "not a memory report" };
  } catch (error) {
    return { now: null, failed: why(error) };
  }
}

/** Core's health and the desktop app's version, read now, each within 2 s;
 * what was read last stays as evidence when a read fails. Core's memory is
 * read at the same time, and only for this text. */
export async function gatherFacts(): Promise<Facts> {
  const record = load();
  const at = new Date().toISOString();
  const facts: Facts = { at, core: { now: null, failed: null, last: record.core ?? null }, desktop: null };
  const memory = readMemory(at);
  try {
    const response = await within(fetch(`${API_BASE}/api/health`, { headers: { "X-Yuzuno-Client": "desktop" }, cache: "no-store" }));
    if (!response.ok) throw new Error(`http ${response.status}`);
    const health = (await within(response.json())) as Record<string, unknown>;
    const version = identifier(health.version, 80);
    if (!version) throw new Error("not a Yuzuno Core");
    facts.core.now = {
      at,
      version,
      releaseId: identifier(health.releaseId, 80),
      apiReady: typeof health.apiReady === "boolean" ? health.apiReady : null,
      storageReady: typeof health.storageReady === "boolean" ? health.storageReady : null,
    };
    record.core = facts.core.now;
  } catch (error) {
    facts.core.failed = error instanceof Error && error.message === "not a Yuzuno Core" ? "not a Yuzuno Core" : why(error);
  }
  if (isTauri) {
    facts.desktop = { now: null, failed: null, last: record.desktop ?? null };
    const invoke = (window as Window & { __TAURI__?: { core?: { invoke?: (command: string) => Promise<unknown> } } })
      .__TAURI__?.core?.invoke;
    try {
      if (!invoke) throw new Error("no command bridge");
      // The desktop's own update status names its version (desktop/src/update.rs);
      // every desktop with in-app updates answers it, no newer command is needed.
      const status = (await within(invoke("desktop_update_status"))) as { version?: unknown } | null;
      const version = identifier(status?.version, 40);
      if (!version) throw new Error("no version");
      facts.desktop.now = { at, version };
      record.desktop = facts.desktop.now;
    } catch (error) {
      facts.desktop.failed = error instanceof Error && error.message === "timeout" ? "no answer within 2 s" : "it did not say";
    }
  }
  facts.memory = await memory;
  save();
  return facts;
}

function webBuild() {
  const scripts = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')];
  for (const script of scripts) {
    const file = script.src.match(/\/assets\/([\w.-]+\.js)(?:$|[?#])/)?.[1];
    if (file) return file;
  }
  return "unknown";
}

function pageOrigin() {
  const { protocol, hostname, port } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return protocol.replace(/:$/, "");
  return LOOPBACK.test(hostname) ? window.location.origin : `${protocol}//<remote host>${port ? `:${port}` : ""}`;
}

/** The page's browser engine (major version) and system, as its user agent
 * says them; never the user agent itself. */
export function pageEnvironment(agent = navigator.userAgent) {
  const engine =
    agent.match(/\b(Edg|Chrome|Firefox|Version)\/(\d{1,4})/) ??
    agent.match(/\b(jsdom|AppleWebKit)\/(\d{1,4})/);
  const name = engine ? ({ Edg: "Edge (Chromium)", Chrome: "Chromium", Firefox: "Firefox", Version: "Safari", jsdom: "jsdom", AppleWebKit: "WebKit" } as Record<string, string>)[engine[1]] : null;
  const system = /Windows/.test(agent) ? "Windows" : /Mac OS X|Macintosh/.test(agent) ? "macOS" : /Android/.test(agent) ? "Android" : /Linux|X11/i.test(agent) ? "Linux" : "unknown system";
  return `${name ? `${name} ${engine![2]}` : "unknown browser"} on ${system}`;
}

const yes = (value: boolean | null) => (value === null ? "unknown" : value ? "yes" : "no");
const mib = (bytes: number | null) => (bytes === null ? "unknown" : `${(bytes / 1048576).toFixed(1)} MiB`);

function memoryLines(memory: MemoryRead) {
  const { os, allocator } = memory;
  const lines = [`Core memory: read ${memory.at}, one part after another, not one snapshot`];
  lines.push(os
    ? `  Process: RSS ${mib(os.rss)}, peak ${mib(os.hwm)}, anonymous ${mib(os.anon)}, file ${mib(os.file)}, swap ${mib(os.swap)}, ${os.threads ?? "unknown"} threads`
    : "  Process: not available on this Core");
  lines.push(allocator
    ? `  glibc malloc, its own counts (free space need not be resident): arena ${mib(allocator.arena)}, uordblks ${mib(allocator.uordblks)}, fordblks ${mib(allocator.fordblks)}, hblkhd ${mib(allocator.hblkhd)}`
    : "  glibc malloc: not available on this Core");
  lines.push(`  Held records: ${memory.held ?? "unknown"} of ${memory.heldMax ?? "unknown"}; requests in flight: ${memory.inFlight ?? "unknown"}${memory.includesThisRequest ? " (this one included)" : ""}`);
  if (memory.waiting === null) lines.push("  Idle trim: not available on this Core");
  else {
    const reasons = [...memory.waiting, ...(memory.otherWaiting ? [`${memory.otherWaiting} other`] : [])];
    const waiting = reasons.length ? reasons.join(", ") : "nothing";
    const last = memory.last
      ? `${memory.last.result}${memory.last.at ? ` at ${memory.last.at}` : ""}${memory.last.result === "trimmed" ? `, RSS ${mib(memory.last.rssBefore)} to ${mib(memory.last.rssAfter)}` : ""}`
      : "none since Core started";
    lines.push(`  Idle trim: maintenance tick running ${yes(memory.tick)}; waiting for ${waiting}; last check ${last}`);
  }
  return lines;
}
const coreLine = (read: CoreRead) =>
  `${read.version}${read.releaseId ? ` (release ${read.releaseId})` : ""}, API ready ${yes(read.apiReady)}, storage ready ${yes(read.storageReady)}`;

/** The text the user copies. Unknown is said as unknown. */
export function diagnosticsText(facts: Facts | null) {
  const lines = ["Yuzuno diagnostics", `Copied: ${new Date().toISOString()}`];
  lines.push(`Page: loaded ${pageLoadedAt}; web UI ${webBuild()}; from ${pageOrigin()}; browser ${navigator.onLine ? "online" : "offline"}`);
  if (!facts) lines.push("Core: not read");
  else if (facts.core.now) lines.push(`Core: ${coreLine(facts.core.now)}; read ${facts.core.now.at}`);
  else
    lines.push(
      `Core: unknown now (${facts.core.failed}, ${facts.at})` +
        (facts.core.last ? `; last read ${facts.core.last.at}: ${coreLine(facts.core.last)}` : "; never read on this device"),
    );
  if (facts?.memory?.now) lines.push(...memoryLines(facts.memory.now));
  else lines.push(facts?.memory ? `Core memory: unknown (${facts.memory.failed}, ${facts.at})` : "Core memory: not read");
  if (!isTauri) lines.push("Desktop app: not a desktop window", "WebView: not a desktop window");
  else {
    const desktop = facts?.desktop;
    if (desktop?.now) lines.push(`Desktop app: ${desktop.now.version}; read ${desktop.now.at}`);
    else
      lines.push(
        `Desktop app: unknown${desktop?.failed ? ` (${desktop.failed}, ${facts!.at})` : ""}` +
          (desktop?.last ? `; last read ${desktop.last.at}: ${desktop.last.version}` : ""),
      );
    lines.push("WebView: unknown (the desktop app does not report it)");
  }
  lines.push(`Page environment (as the page reads it, not a report from the desktop app): ${pageEnvironment()}`);
  const errors = recordedErrors();
  lines.push(errors.length ? `Recent errors on this device: ${errors.length} (newest first, at most ${MAX_ENTRIES} kept)` : "Recent errors on this device: none");
  errors.forEach((error, index) => {
    const when = error.count === 1 ? `once, ${error.last}` : `${error.count} times, ${error.first} to ${error.last}`;
    const what = [error.kind, error.name, ...error.codes].join(" · ");
    lines.push(`${index + 1}. ${what} · ${when}${error.summary ? `\n   ${error.summary}` : ""}${error.where.length ? `\n   at ${error.where.join("; ")}` : ""}`);
  });
  lines.push("This text stays on this device until you paste it somewhere. It holds no conversations, drafts, requests, credentials, file paths or error messages.");
  return lines.join("\n");
}

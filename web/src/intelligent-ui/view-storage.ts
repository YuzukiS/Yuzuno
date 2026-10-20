// Result views are disposable preferences. Drafts and delivery protection always
// take priority; this module only ever removes keys in its own namespace.
export const VIEW_PREFIX = "yuzuno.result-view.";
export const VIEW_MAX_ENTRIES = 100;
export const VIEW_MAX_BYTES = 128 * 1024;
export const VIEW_ENTRY_MAX_BYTES = 16 * 1024;
// A conservative UTF-16 estimate, below the usual 5 MiB localStorage quota.
// Stop caching when other application data needs the space. Quotas can differ,
// so a failed write also releases all of our reconstructible preferences.
const ORIGIN_SOFT_LIMIT = 3 * 1024 * 1024;
export type ViewState = {
  selected: string[];
  filter: string;
  sort: { id: string; desc: boolean }[];
};
export type Views = Record<string, ViewState>;
type StorageLike = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
type Entry = { key: string; value: string; bytes: number; touched: number };
const bytes = (key: string, value: string) => (key.length + value.length) * 2;
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[a-zA-Z][\w-]{0,63}$/.test(id) &&
  !(id in Object.prototype) &&
  id !== "prototype";

// Two independent 32-bit accumulators + length; this is a cache identity, not
// a security digest. The original result remains solely in its native message.
export function resultFingerprint(raw: string): string {
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    a = Math.imul(a ^ char, 16777619);
    b = Math.imul(b, 33) ^ char;
  }
  return `${raw.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

function cleanViews(value: unknown): Views {
  const views: Views = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return views;
  for (const [id, candidate] of Object.entries(value).slice(0, 32)) {
    if (!validId(id) || !candidate || typeof candidate !== "object") continue;
    const v = candidate as Partial<ViewState>;
    if (!Array.isArray(v.selected)) continue;
    views[id] = {
      selected: [...new Set(v.selected.filter(validId))].slice(0, 100),
      filter: typeof v.filter === "string" ? v.filter.slice(0, 200) : "",
      sort: Array.isArray(v.sort)
        ? v.sort
            .filter((s) => s && validId(s.id) && typeof s.desc === "boolean")
            .slice(0, 1)
        : [],
    };
  }
  return views;
}

function keys(storage: StorageLike) {
  return Array.from({ length: storage.length }, (_, i) =>
    storage.key(i),
  ).filter((key): key is string => key !== null);
}

function releaseViews(storage: StorageLike) {
  try {
    for (const key of keys(storage))
      if (key.startsWith(VIEW_PREFIX)) storage.removeItem(key);
  } catch {
    /* Storage may be entirely unavailable. */
  }
}

function collect(storage: StorageLike) {
  const entries: Entry[] = [];
  let otherBytes = 0;
  for (const key of keys(storage)) {
    const value = storage.getItem(key) || "";
    const size = bytes(key, value);
    if (!key.startsWith(VIEW_PREFIX)) {
      otherBytes += size;
      continue;
    }
    let saved;
    try {
      if (size <= VIEW_ENTRY_MAX_BYTES) saved = JSON.parse(value);
    } catch {
      /* Discard invalid cache. */
    }
    if (
      saved?.version !== 2 ||
      typeof saved.fingerprint !== "string" ||
      !/^\d{1,5}:[a-f0-9]{1,8}:[a-f0-9]{1,8}$/.test(saved.fingerprint) ||
      !Number.isFinite(saved.touched) ||
      !saved.views ||
      typeof saved.views !== "object" ||
      Array.isArray(saved.views) ||
      "raw" in saved
    ) {
      storage.removeItem(key); // Includes the old unbounded full-raw format.
    } else entries.push({ key, value, bytes: size, touched: saved.touched });
  }
  return { entries, otherBytes };
}

function trim(
  storage: StorageLike,
  entries: Entry[],
  budget: number,
  count: number,
) {
  let size = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  entries.sort((a, b) => a.touched - b.touched || a.key.localeCompare(b.key));
  while (entries.length > count || size > budget) {
    const oldest = entries.shift();
    if (!oldest) break;
    storage.removeItem(oldest.key);
    size -= oldest.bytes;
  }
}

// Run once at app startup too: legacy caches must not block draft persistence
// just because the initially selected conversation has no interactive result.
export function pruneResultViewCache(storage?: StorageLike) {
  try {
    storage ??= localStorage;
    const { entries, otherBytes } = collect(storage);
    trim(
      storage,
      entries,
      Math.max(0, Math.min(VIEW_MAX_BYTES, ORIGIN_SOFT_LIMIT - otherBytes)),
      VIEW_MAX_ENTRIES,
    );
  } catch {
    if (storage) releaseViews(storage);
  }
}

export function readViews(
  key: string,
  fingerprint: string,
  storage?: StorageLike,
): Views {
  try {
    storage ??= localStorage;
    pruneResultViewCache(storage);
    const saved = JSON.parse(storage.getItem(key) || "null");
    return saved?.fingerprint === fingerprint ? cleanViews(saved.views) : {};
  } catch {
    return {};
  }
}

export function saveViews(
  key: string,
  fingerprint: string,
  views: Views,
  storage?: StorageLike,
) {
  if (!key.startsWith(VIEW_PREFIX)) return;
  try {
    storage ??= localStorage;
    const { entries, otherBytes } = collect(storage);
    const value = JSON.stringify({
      version: 2,
      fingerprint,
      touched: Date.now(),
      views: cleanViews(views),
    });
    const size = bytes(key, value);
    const budget = Math.max(
      0,
      Math.min(VIEW_MAX_BYTES, ORIGIN_SOFT_LIMIT - otherBytes),
    );
    if (size > VIEW_ENTRY_MAX_BYTES || size > budget) {
      storage.removeItem(key);
      trim(
        storage,
        entries.filter((entry) => entry.key !== key),
        budget,
        VIEW_MAX_ENTRIES,
      );
      return;
    }
    // Reserve space for this write before touching storage, keeping the most
    // recently changed result and evicting older preferences first.
    trim(
      storage,
      entries.filter((entry) => entry.key !== key),
      budget - size,
      VIEW_MAX_ENTRIES - 1,
    );
    storage.setItem(key, value);
  } catch {
    if (storage) releaseViews(storage);
  }
}

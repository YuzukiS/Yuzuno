/**
 * The page's visibility since it loaded (YN-221 S8), for Copy diagnostics:
 * its last changes, as the browser said them (visibilitychange, pageshow,
 * pagehide), each with its time since the page loaded and the visibility it
 * left the page in, and how long the page was visible and hidden in all.
 * Kept in this page only; nothing is stored or sent. `pageVisibility()` is
 * what each API request says of it (api.ts, `X-Yuzuno-Visibility`).
 */
export type PageVisibility = "visible" | "hidden";
export type VisibilityChange = { sinceLoadMs: number; event: "load" | "visibilitychange" | "pageshow" | "pagehide"; state: PageVisibility };

/** The changes kept, the newest last. */
export const VISIBILITY_KEPT = 32;

export const pageVisibility = (): PageVisibility =>
  typeof document !== "undefined" && document.visibilityState === "hidden" ? "hidden" : "visible";

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const loadedAt = clock();
const changes: VisibilityChange[] = [{ sinceLoadMs: 0, event: "load", state: pageVisibility() }];
let dropped = 0;
let current = pageVisibility();
let since = loadedAt;
const totals: Record<PageVisibility, number> = { visible: 0, hidden: 0 };

function note(event: VisibilityChange["event"]) {
  const now = clock();
  // pagehide leaves the page hidden whatever visibilityState still says (the bfcache, a closing tab).
  const state: PageVisibility = event === "pagehide" ? "hidden" : pageVisibility();
  totals[current] += now - since;
  since = now;
  current = state;
  changes.push({ sinceLoadMs: Math.round(now - loadedAt), event, state });
  if (changes.length > VISIBILITY_KEPT) {
    changes.shift();
    dropped += 1;
  }
}

let installed = false;
/** Starts the log; main.tsx calls it once, as the page starts. */
export function installVisibilityLog() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => note("visibilitychange"));
  window.addEventListener("pageshow", () => note("pageshow"));
  window.addEventListener("pagehide", () => note("pagehide"));
}

/** What the log holds now: the visibility now, the milliseconds in each, the changes kept and how many fell out. */
export function visibilityLog() {
  const now = clock();
  const spent = { ...totals, [current]: totals[current] + (now - since) };
  return {
    now: current,
    sinceLoadMs: Math.round(now - loadedAt),
    visibleMs: Math.round(spent.visible),
    hiddenMs: Math.round(spent.hidden),
    changes: changes.map((change) => ({ ...change })),
    dropped,
  };
}

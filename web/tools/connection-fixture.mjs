// Synthetic, local-only fault injection shared by JSDOM and the isolated lab.
// The production app does not import this module. No requests reach a Core.
/** The Workspace this fixture's Core answers as. Session-private state is
 * kept per Workspace (T-195), so a script that seeds or reads a draft, an
 * unsent message or saved answers needs this id. */
export const FIXTURE_WORKSPACE = "ws-connection";

export function installConnectionFixture(options = {}) {
  const timer = window.setTimeout.bind(window);
  if (options.deadlineMs) {
    window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 10_000 ? options.deadlineMs : ms, ...args);
  }
  const agent = (id, harness) => ({
    id, harness, name: harness === "claude" ? "Claude fixture" : "Codex fixture",
    goal: "Connection fault simulation", cwd: "/fixture", model: "fixture-model",
    color: "sage", status: "idle", createdAt: "2026-10-13", updatedAt: "2026-10-13",
    unreadCount: 0, pendingCount: id === "a" ? 1 : 0, lastSeq: 1, reviewedSeq: 1,
  });
  const agents = [agent("a", "codex"), agent("b", "claude")];
  const pending = [{
    id: "kept-pending", agentId: "a", method: "item/commandExecution/requestApproval",
    params: { command: "fixture-command", cwd: "/fixture" },
    createdAt: "2026-10-13", status: "pending",
  }];
  const state = window.connectionFixture = {
    mode: "ok", catalogError: false, marker: "initial fixture reply", version: 1,
    calls: [], streams: [], held: [],
    emit(kind) {
      const stream = this.streams.filter(s => !s.closed).at(-1);
      if (stream) {
        stream.readyState = kind === "open" ? 1 : kind === "error" ? 0 : stream.readyState;
        stream[`on${kind}`]?.({ data: "{}" });
      }
    },
    // With the stream open, the GUI refetches only when Core says so (a
    // reset); without it, focus and polling do.
    refresh() {
      const stream = this.streams.filter(s => !s.closed).at(-1);
      if (stream?.readyState === 1) stream.onmessage?.({ data: '{"type":"reset","reason":"fixture"}' });
      else window.dispatchEvent(new Event("focus"));
    },
    scenario(mode) {
      this.mode = mode === "catalog" || mode === "sse" ? "ok" : mode;
      this.catalogError = mode === "catalog";
      this.emit(mode === "offline" || mode === "sse" ? "error" : "open");
      this.refresh();
    },
    release() { for (const item of this.held.splice(0)) item.resolve(item.body); },
    // The browser's own report (navigator.onLine and its event), apart from
    // whether Core answers; set only when a test asks (T-170).
    network(online) {
      if (!this.browserNetwork) Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => this.browserNetwork.online });
      this.browserNetwork = { online };
      window.dispatchEvent(new Event(online ? "online" : "offline"));
    },
  };
  window.EventSource = class {
    constructor(url) {
      this.url = url; this.closed = false; this.readyState = 0;
      state.streams.push(this);
      timer(() => {
        if (!this.closed) { this.readyState = 1; this.onopen?.({}); }
      }, 0);
    }
    close() { this.closed = true; this.readyState = 2; }
  };
  window.fetch = async (url, init = {}) => {
    const path = new URL(String(url), location.href).pathname;
    state.calls.push({ path, method: init.method || "GET", signal: init.signal });
    if (!path.startsWith("/api/") || (init.method && init.method !== "GET")) {
      throw new Error("Fault fixture never forwards requests or writes");
    }
    const snapshot = path === "/api/workspace" || /^\/api\/agents\/[ab]$/.test(path);
    if (snapshot && state.mode === "offline") throw new TypeError("Simulated network disconnected");
    // Reads get no answer while the event stream stays open (WebKit's offline
    // emulation did this), with WebKit's own text.
    if (snapshot && state.mode === "fetch-down") throw new TypeError("Load failed");
    if (snapshot && state.mode === "invalid-json") return {
      ok: true, status: 200, json: async () => JSON.parse("malformed snapshot"),
    };
    if (snapshot && state.mode === "http500") return {
      ok: false, status: 500, text: async () => JSON.stringify({ error: "Simulated HTTP 500" }),
    };
    let body = {};
    if (path === "/api/workspace") body = {
      // A real Core always says which Workspace this is, and the page keeps
      // drafts and unsent messages per Workspace (T-195).
      // FIXTURE_WORKSPACE; spelled here because this function's source is
      // what runs in the page, with no module scope around it.
      workspace: { id: "ws-connection" },
      agents: agents.map(a => ({ ...a })), defaultCwd: "/fixture",
      runtime: { connected: !state.catalogError, ...(state.catalogError ? { error: "Simulated Codex catalog failure" } : {}) },
    };
    else if (/^\/api\/agents\/[ab]$/.test(path)) {
      const a = agents.find(a => path.endsWith(`/${a.id}`));
      body = { agent: a, pending: a.id === "a" ? pending : [], artifacts: [], turns: [{
        id: `turn-${a.id}`, status: "completed", items: [{
          id: `reply-${a.id}`, type: "agentMessage", phase: "final_answer", text: `${a.name}: ${state.marker}`,
        }],
      }] };
    } else if (path === "/api/machines") body = { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] };
    else if (path === "/api/catchup") body = { items: [], generatedAt: "2026-10-13", source: "records" };
    const frozen = JSON.parse(JSON.stringify(body));
    // Deliberately ignore AbortSignal: tests can release this old body later and
    // prove a timed-out/abandoned request cannot overwrite newer state.
    const hold = snapshot && (state.mode === "hang" || state.mode === "hold-a" && path === "/api/agents/a");
    return { ok: true, status: 200, text: async () => JSON.stringify(frozen), json: () => hold
      ? new Promise(resolve => state.held.push({ resolve, body: frozen, path, signal: init.signal }))
      : Promise.resolve(frozen) };
  };
}

// T-170: the production web build with every API answered here (no Core),
// on 127.0.0.1, for a browser that Playwright does not drive: Mobile Safari in
// an iOS Simulator, run on the same Mac (ios.yml). It serves the synthetic
// Workspace of safe-area-check.mjs: one Agent, Mori, with a finished
// conversation, and the Jobs, Tasks and Settings dialogs. Every HTML page it
// serves gets phone-measure.js, which posts what the page measured to
// /__measure; each post becomes one JSON line in YUZUNO_MEASURE_OUT. A write
// the page tries is answered 400 and written there too, as a "refused" line.
// YUZUNO_EXTRA=/connection=<dir> also serves <dir> (the iOS app's connection
// page) under /connection/, measured the same way. YUZUNO_INJECT=<file> adds
// one more script to every page, after phone-measure.js (another probe).
// YUZUNO_FIXTURE=conversation serves phone-conversation-fixture.mjs's
// crowded conversations instead (the same Workspace, Mori among them), as
// phone-conversation-probe.js measures them.
// A path that is no file (and not /api/) gets the app's page, so the app's
// own addresses open it: /#/message?w=ws-phone&a=a&t=t7 opens Mori's
// conversation at its last turn.
//   YUZUNO_UI_DIST=<build> YUZUNO_MEASURE_OUT=<file> [YUZUNO_PORT=4510] \
//     [YUZUNO_EXTRA=/connection=<dir>] [YUZUNO_INJECT=<file>] [YUZUNO_FIXTURE=conversation] \
//     node tools/phone-fixture-server.mjs
// Synthetic data only; it listens on 127.0.0.1 and answers only that host.
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { childPath, conversationWorkspace } from "./phone-conversation-fixture.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "YUZUNO_UI_DIST: the web build to serve");
assert.ok(process.env.YUZUNO_MEASURE_OUT, "YUZUNO_MEASURE_OUT: where the measurements go");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const out = resolve(process.env.YUZUNO_MEASURE_OUT);
const port = Number(process.env.YUZUNO_PORT || 4510);
const mounts = [["/", dist]];
if (process.env.YUZUNO_EXTRA) {
  const [prefix, dir] = process.env.YUZUNO_EXTRA.split("=");
  assert.match(prefix, /^\/[a-z-]+$/, "YUZUNO_EXTRA=/<name>=<dir>");
  mounts.unshift([`${prefix}/`, resolve(dir)]);
}
const measureScript = await readFile(new URL("./phone-measure.js", import.meta.url));
const injected = process.env.YUZUNO_INJECT ? await readFile(resolve(process.env.YUZUNO_INJECT)) : null;
const scripts = '<script src="/__measure.js" defer></script>' + (injected ? '<script src="/__inject.js" defer></script>' : "");

const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const agents = [{ ...base, id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", connectionState: "connected", threadId: "thread-a" }];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const turns = Array.from({ length: 8 }, (_, n) => ({
  id: `t${n}`,
  status: "completed",
  items: [
    { id: `u${n}`, type: "userMessage", content: [{ type: "text", text: `Step ${n + 1}: check the next part.` }] },
    { id: `r${n}`, type: "agentMessage", text: `Reply ${n + 1}. ${"The layout keeps clear of the screen's edges. ".repeat(4)}` },
  ],
}));
const now = new Date().toISOString();
const home = { generatedAt: now, order: ["p1"], needsYou: [], projects: [] };
const task = {
  id: "T-1", title: "Use Yuzuno from a phone", status: "doing", description: "The app keeps clear of the screen's edges.",
  assigneeAgentId: "a", projectId: "p1", createdAt: now, updatedAt: now, version: 1, blocker: "",
};
const reads = {
  "/api/workspace": { workspace: { id: "ws-phone" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns },
  "/api/home": home,
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
  "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
};
assert.ok(["", "conversation"].includes(process.env.YUZUNO_FIXTURE || ""), "YUZUNO_FIXTURE: conversation, or unset");
const crowded = process.env.YUZUNO_FIXTURE === "conversation" ? conversationWorkspace() : null;
if (crowded) {
  delete reads["/api/agents/a"];
  Object.assign(reads, crowded.reads);
}
const agentIds = crowded ? crowded.agents.map((agent) => agent.id) : ["a"];
// Tasks & messages reads its lists by POST, as the Agents' tools do.
const collaborationReads = {
  task_list: { tasks: [task], counts: { doing: 1 }, hasMore: false, nextAfterSeq: null },
  peers_list: { peers: [{ id: "a", name: "Mori" }] },
  peer_read: { messages: [], hasMore: false, nextAfterSeq: 0 },
  github_repositories: { repositories: [], links: [] },
};
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

const record = (value) => appendFile(out, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
const body = (req) => new Promise((done, fail) => {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 64 * 1024) { fail(new Error("body over 64 KiB")); req.destroy(); } else chunks.push(chunk);
  });
  req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  req.on("error", fail);
});
const json = (res, value, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
};

async function file(res, path) {
  const [prefix, root] = mounts.find(([prefix]) => path.startsWith(prefix));
  const relative = path.slice(prefix.length) || "index.html";
  const target = resolve(root, relative.endsWith("/") ? `${relative}index.html` : relative);
  if (target !== root && !target.startsWith(root + sep)) return json(res, { error: "outside the served folder" }, 404);
  let content;
  try {
    content = await readFile(target);
  } catch {
    // An address of the app's own (no file extension) opens its page.
    if (prefix === "/" && !extname(relative)) return file(res, "/");
    return json(res, { error: `no ${path}` }, 404);
  }
  if (extname(target) === ".html") {
    const html = content.toString("utf8");
    assert.ok(html.includes("</head>"), `${path} has no </head>`);
    content = html.replace("</head>", `${scripts}</head>`);
  }
  res.writeHead(200, { "Content-Type": types[extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(content);
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
      return json(res, { error: "this fixture answers 127.0.0.1 only" }, 421);
    const { pathname: path, searchParams } = new URL(req.url, `http://127.0.0.1:${port}`);
    const method = req.method;
    if (path === "/__measure.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      return res.end(measureScript);
    }
    if (path === "/__inject.js" && injected) {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      return res.end(injected);
    }
    if (path === "/__measure" && method === "POST") {
      const line = JSON.parse(await body(req));
      await record({ kind: "measure", ...line });
      res.writeHead(204);
      return res.end();
    }
    if (path === "/api/events") {
      // Live updates never open: the request is held unanswered, so the page
      // stays as safe-area-check.mjs's stubbed EventSource leaves it. An open
      // stream makes the page read more (the backlog, usage) than this
      // fixture answers. Closed with the server.
      return;
    }
    if (agentIds.some((id) => path === `/api/agents/${id}/reading`))
      return json(res, method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 });
    if (method === "POST" && agentIds.some((id) => path === `/api/agents/${id}/review`)) return json(res, {});
    if (method === "POST" && path.startsWith("/api/collaboration/")) {
      const request = JSON.parse((await body(req)) || "{}");
      const read = !request.action && collaborationReads[path.split("/").at(-1)];
      if (read) return json(res, read);
    }
    if (method !== "GET" && method !== "HEAD") {
      await record({ kind: "refused", method, path });
      return json(res, { error: `Unexpected ${method} ${path} in this fixture` }, 400);
    }
    // A crowded conversation is read a window at a time.
    const agent = crowded?.agents.find((a) => path === `/api/agents/${a.id}`);
    if (agent) return json(res, crowded.detail(agent, searchParams));
    if (crowded && path === childPath) return json(res, crowded.childDetail);
    if (reads[path]) return json(res, reads[path]);
    if (path.startsWith("/api/")) return json(res, {});
    return file(res, path);
  } catch (error) {
    await record({ kind: "error", message: String(error && error.message || error) }).catch(() => {});
    if (!res.headersSent) json(res, { error: String(error) }, 500);
    else res.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`phone fixture: http://127.0.0.1:${port}/ (measurements: ${out})`));
// Live-update streams never end by themselves: close them with the server.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});

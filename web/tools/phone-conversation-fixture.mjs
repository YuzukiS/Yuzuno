// T-170: a synthetic Workspace that crowds a phone's conversation, as the
// user's did: an Agent with 1408 Turns (four-digit Turn numbers), the latest
// a long Chinese reply with a long link that failed with an error, jobs, CI
// runs and a sub-agent (three groups in the work dock), Codex in Plan mode
// (the composer's mode) and the composer's notice to resume the session; a
// second Agent waiting to be reconnected, with the recovery notice; a third
// asking to run a long command. phone-conversation-check.mjs reads it in
// Chromium, and phone-fixture-server.mjs serves it to Mobile Safari with
// YUZUNO_FIXTURE=conversation. The Workspace, its Agents and the Agent list
// address are those of the server's default fixture (ws-phone, Mori is "a"),
// so its checks find the same buttons. Synthetic content only.

export const TURNS = 1408;
export const errorText = "The previous attempt stopped: the connection to the native session closed before the reply finished; nothing was sent twice.";
const child = "01a1418f-0000-7000-8000-000000000001";
/** Where the app reads Mori's sub-agent. */
export const childPath = `/api/agents/a/subagents/${child}`;

/** The Workspace, with its times counted back from `now` (ms). */
export function conversationWorkspace(now = Date.now()) {
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  // A Turn's times are Unix seconds, as Codex reports them.
  const seconds = (minutesAgo) => Math.floor((now - minutesAgo * 60_000) / 1000);
  const base = { color: "sage", createdAt: at(9000), updatedAt: at(1), unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", cwd: "/fixture", model: "gpt-6", projectId: "p1" };
  // Mori is offline: the composer asks for a message to resume the session.
  // Hana was cut off mid-Turn: Reconnect above, and the composer says so.
  // Sora asks to run a command.
  const agents = [
    { ...base, id: "a", name: "Mori", status: "offline", harness: "codex", connectionState: "disconnected", threadId: "thread-a" },
    { ...base, id: "b", name: "Hana", status: "offline", harness: "codex", connectionState: "disconnected", threadId: "thread-b" },
    { ...base, id: "c", name: "Sora", status: "waiting", harness: "codex", connectionState: "connected", threadId: "thread-c", pendingCount: 1 },
  ];
  const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: at(9000), updatedAt: at(9000) }];
  const longChinese = "手机上读这一段时，正文应该占满整个宽度，左右两侧不再留给常驻的竖栏。".repeat(6);
  const longLink = "https://example.com/a/very/long/path/that/does/not/break/on/its/own/" + "segment-".repeat(12) + "end";
  // Mori started a sub-agent three Turns before the last.
  const subAgent = (kind) => ({ type: "subAgentActivity", id: `${kind}-child`, kind, agentThreadId: child, agentPath: "/root/child-1", model: kind === "started" ? "gpt-6-astra" : null });
  // Mori's latest Turn failed (its error shows under it, where the
  // conversation opens); Hana's was still running when she was cut off.
  const turn = (who, n, last) => ({
    id: `${who}-t${n}`,
    status: last && who === "Hana" ? "inProgress" : last && who === "Mori" ? "failed" : "completed",
    startedAt: seconds(TURNS - n + 2),
    completedAt: last && who === "Hana" ? undefined : seconds(TURNS - n + 1),
    items: [
      { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} step ${n + 1}: check the next part.` }] },
      ...(who === "Mori" && n === TURNS - 3 ? [subAgent("started"), subAgent("completed")] : []),
      { id: `${who}-r${n}`, type: "agentMessage", text: last ? `${longChinese}\n\n打开：\n\n${longLink}\n\nThen check it again.` : `${who} reply ${n + 1}.` },
    ],
    ...(last && who === "Mori" ? { error: { message: errorText } } : {}),
  });
  const longCommand = "node tools/a-long-script-name-for-the-phone-check.mjs --output=/fixture/" + "nested/".repeat(10) + "report.json";
  const approval = {
    id: "req-1", agentId: "c", method: "item/commandExecution/requestApproval", createdAt: at(3),
    params: { command: longCommand, cwd: "/fixture", reason: "Run the check that writes its report", itemId: "cmd-1", turnId: "Sora-t11", availableDecisions: ["accept", "decline", "cancel"] },
  };
  const allTurns = Object.fromEntries(agents.map((agent) => [agent.id, agent.id === "c"
    ? Array.from({ length: 12 }, (_, n) => ({ ...turn(agent.name, n, false), ...(n === 11 ? { status: "inProgress", completedAt: undefined } : {}) }))
    : Array.from({ length: TURNS }, (_, n) => turn(agent.name, n, n === TURNS - 1))]));
  // As Core sends a long conversation: a window of Turns, the latest unless a
  // Turn or a page before or after a cursor is asked for, and an index of all.
  const WINDOW = 12;
  /** An Agent's conversation, for its address's query (URLSearchParams). */
  const detail = (agent, query) => {
    const all = allTurns[agent.id];
    const cursor = (name) => all.findIndex((t) => t.id === JSON.parse(query.get(name))[0]);
    const start = query.has("turnId") ? Math.max(0, all.findIndex((t) => t.id === query.get("turnId")))
      : query.has("before") ? Math.max(0, cursor("before") - WINDOW)
      : query.has("after") ? Math.min(all.length - 1, cursor("after") + 1)
      : Math.max(0, all.length - WINDOW);
    const turns = all.slice(start, start + WINDOW);
    return {
      agent, pending: agent.id === "c" ? [approval] : [], messageReceipts: [], artifacts: [], turns,
      // Codex reports Plan mode: the composer shows its mode.
      codexPlan: { generation: 1, reported: { mode: "plan", source: "settings", observedAt: at(5) }, switch: null },
      conversation: {
        index: all.map((t, i) => ({ ...t, number: i + 1, itemCount: t.items.length, items: [t.items[0]] })),
        questions: [], nativeClientIds: [],
        start: JSON.stringify([turns[0].id, turns[0].items[0].id]),
        end: JSON.stringify([turns.at(-1).id, turns.at(-1).items.at(-1).id]),
        hasBefore: start > 0, hasAfter: start + WINDOW < all.length,
        totalItems: all.reduce((sum, t) => sum + t.items.length, 0),
      },
    };
  };
  const childDetail = {
    threadId: child, parentThreadId: "thread-a", nickname: null, role: null, path: "/root/child-1", depth: 1, model: "gpt-6-astra", status: "idle",
    turn: { id: "child-turn", status: "completed", error: null },
    result: { text: "子 agent 的结论：布局在窄屏上不再横向溢出。", truncated: false }, readFrom: "history", readAt: new Date(now).toISOString(),
  };
  const resources = { cpuMillis: 2000, memoryMiB: 4096, swapMiB: 0 };
  const job = (id, name, status, minutes) => ({
    id, requestId: id, name, taskRef: "T-170", agentId: "a", agent: { name: "Mori" }, machine: { name: "Core host" }, status,
    reserved: status === "running", reason: status === "failed" ? "exit-code" : null, resources, reservation: resources,
    cursor: minutes, createdAt: at(minutes + 2), startedAt: at(minutes + 1), finishedAt: status === "running" ? null : at(minutes),
    argv: ["/usr/bin/true"], cwd: "/fixture", env: {}, outputs: [],
  });
  const jobs = { jobs: [job("j1", "a build with a long name for the phone check", "running", 1), job("j2", "the layout check", "failed", 5), job("j3", "unit tests", "succeeded", 9)], liveJobs: [], hasMore: false, nextBefore: null };
  const run = (n, status, conclusion) => ({
    id: `github:1:4${n}:1`, name: `CI ${n}`, repository: "o/r", runId: `4${n}`, attempt: "1", headSha: "a".repeat(40), status,
    rawStatus: status === "running" ? "in_progress" : "completed", conclusion, url: `https://github.com/o/r/actions/runs/4${n}`, observedAt: at(n), cursor: n,
  });
  const ci = { runs: [run(1, "running", null), run(2, "passed", "success")], subscriptions: [], hasMore: false, nextBefore: null };
  return {
    agents, detail, childDetail,
    /** The rest of what the app reads, by path. */
    reads: {
      "/api/workspace": { workspace: { id: "ws-phone" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/home": { generatedAt: new Date(now).toISOString(), order: ["p1"], needsYou: [], projects: [] },
      "/api/jobs": jobs, "/api/ci": ci, "/api/ci/live": ci,
    },
  };
}

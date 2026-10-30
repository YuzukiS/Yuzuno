// Synthetic records shared by product-bundle DOM and Chromium checks.
// No workspace data, external network, real Job or acceptance assertion.
export function outcomeFixture() {
  const at = "2026-10-01T14:45:00Z";
  const author = { kind: "agent", id: "writer", name: "Mina" };
  const owner = { kind: "agent", id: "reviewer", name: "Iris" };
  const attempt = "00000000-0000-4000-8000-000000000001";
  const ref = {
    jobId: "job-synthetic",
    attempt,
    path: "checks/desktop.json",
    sha256: "a".repeat(64),
  };
  const criterion = {
    id: "desktop",
    label: "按输入定位与继续阅读",
    report: "作者报告：索引和继续阅读入口已实现。",
    reportedStatus: "met",
    artifacts: [ref],
  };
  const current = {
    id: "result-current",
    taskVersion: 4,
    status: "review",
    summary: "阅读界面已可使用；手机版操作仍需补齐证据。",
    links: [{ label: "阅读界面成果", url: "https://example.invalid/outcome" }],
    reportedAt: at,
    reportedBy: author,
    outcome: {
      criteria: [
        criterion,
        {
          id: "mobile",
          label: "手机版触控与键盘操作",
          report: "作者报告：已调整操作区，尚未完成手机检查。",
          reportedStatus: "not_met",
          artifacts: [],
        },
      ],
      remaining: "手机版触控与键盘操作的核对证据",
      nextStep: "补齐 390 宽度下的操作记录",
      nextAgentId: "writer",
      nextAgent: author,
    },
    acceptanceContext: {
      text: "桌面与手机均可完成定位、阅读和返回。",
      source: "registration",
      taskVersion: 1,
      activitySeq: 1,
      capturedAt: at,
    },
  };
  const earlier = {
    ...current,
    id: "result-earlier",
    taskVersion: 2,
    summary: "旧版完成基础阅读，尚未调整手机操作区。",
    outcome: {
      criteria: [
        {
          ...criterion,
          id: "old-mobile",
          label: "旧版手机基础阅读",
          report: "作者报告：旧版检查记录。",
          artifacts: [
            { ...ref, path: "checks/mobile-v1.json", sha256: "b".repeat(64) },
          ],
        },
      ],
      remaining: "调整手机版操作区",
    },
  };
  const base = {
    description: "改善任务成果的阅读与证据追溯。",
    status: "review",
    version: 7,
    projectId: "project",
    progress: "",
    blocker: "",
    github: [],
    assigneeAgentId: owner.id,
    assignee: owner,
    createdAt: at,
    updatedAt: at,
    createdBy: author,
    updatedBy: author,
    materials: { acceptance: "任务之后编辑的说明，不能漂移旧成果的验收文本。" },
  };
  const tasks = [
    { ...base, id: "T-1", title: "历史阅读体验", result: current },
    {
      ...base,
      id: "T-2",
      title: "旧记录兼容",
      result: {
        summary: "Legacy author says all checks passed",
        links: [],
        reportedBy: author,
        reportedAt: at,
      },
    },
    {
      ...base,
      id: "T-3",
      title: "尚未提交的任务",
      status: "doing",
      result: null,
    },
  ];
  const history = [current, earlier].map((r, i) => ({
    resultId: r.id,
    seq: 10 - i,
    taskVersion: r.taskVersion,
    summary: r.summary,
    reportedAt: r.reportedAt,
    reportedBy: r.reportedBy,
    status: r.status,
  }));
  const agents = [author, owner].map((a) => ({
    ...a,
    projectId: "project",
    harness: "codex",
    cwd: "/synthetic",
    model: "test",
    settings: {},
    color: "sage",
    status: "idle",
    createdAt: at,
    updatedAt: at,
    unreadCount: 0,
    pendingCount: 0,
    lastSeq: 0,
    reviewedSeq: 0,
  }));
  const projects = [
    {
      id: "project",
      name: "Northstar",
      defaultDirs: {},
      createdAt: at,
      updatedAt: at,
    },
  ];
  const retained = new Map([
    [current.id, current],
    [earlier.id, earlier],
  ]);
  const calls = [];
  let failed = false;
  let legacyPaging = false;
  const outcome = (body) => {
    if (failed) return { error: "synthetic read failure" };
    const task = tasks.find((t) => t.id === body.taskId);
    const result = body.resultId
      ? task.id === "T-1"
        ? retained.get(body.resultId)
        : undefined
      : task.result;
    if (body.resultId && !result) return { error: "result_not_found" };
    const artifact =
      body.resultId === earlier.id
        ? {
            ...earlier.outcome.criteria[0].artifacts[0],
            criterionId: "old-mobile",
            state: "artifact_mismatch",
            downloadable: false,
          }
        : {
            ...ref,
            criterionId: "desktop",
            state: "recorded_match",
            downloadable: true,
          };
    return {
      taskId: task.id,
      taskVersion: task.version,
      currentResultId: task.result?.id || null,
      result,
      history:
        task.id === "T-1"
          ? history
          : task.id === "T-2"
            ? [
                {
                  resultId: null,
                  seq: 2,
                  summary: "Legacy earlier",
                  taskVersion: null,
                },
                {
                  resultId: null,
                  seq: 1,
                  summary: "Another legacy report",
                  taskVersion: null,
                },
              ]
            : [],
      hasMore: legacyPaging && task.id === "T-2" && body.before == null,
      nextBefore:
        task.id === "T-1" ? 9 : legacyPaging && task.id === "T-2" ? 1 : null,
      artifacts:
        task.id === "T-1"
          ? [
              {
                ...artifact,
                jobStatus: "succeeded",
                index: 0,
                checkedAt: null,
                finishedAt: at,
                bytes: 255,
                machineName: "Synthetic host",
              },
            ]
          : [],
    };
  };
  const answer = (path, body = {}) => {
    calls.push({ path, body });
    if (path === "/api/workspace")
      return {
        workspace: { id: "outcome-fixture" },
        projects,
        agents,
        runtime: { connected: false },
        defaultCwd: "/synthetic",
      };
    if (path.endsWith("/task_list"))
      return { tasks, hasMore: false, counts: { review: 2, doing: 1 } };
    if (path.endsWith("/task_get"))
      return {
        task: tasks.find((t) => t.id === body.taskId),
        activities: [],
        executions: [],
        hasMore: false,
      };
    if (path.endsWith("/task_result_get")) return outcome(body);
    if (path.endsWith("/task_submit_result")) {
      const task = tasks.find((t) => t.id === body.taskId);
      task.version++;
      task.result = {
        ...current,
        ...body,
        id: "new-submission",
        taskVersion: task.version,
        reportedBy: { kind: "user", id: "user", name: "You" },
      };
      return { task };
    }
    if (path.includes("/github_"))
      return { links: [], repositories: [], refreshing: false };
    if (path.endsWith("/delivery_get"))
      return { flow: null, settings: { harness: "codex", model: "test" } };
    if (path.endsWith("/pr-reviews"))
      return {
        reviews: [],
        settings: { harness: "codex", model: "test" },
        hasMore: false,
      };
    if (path.endsWith("/pr-operations"))
      return { operations: [], repositories: [], hasMore: false };
    if (path.endsWith("/machines")) return { machines: [] };
    if (path.endsWith("/catchup")) return { items: [], coverage: {} };
    if (path.endsWith("/home"))
      return { order: [], needsYou: [], projects: [] };
    if (path.endsWith("/backlog")) return { agents: {} };
    if (path.endsWith("/jobs/live")) return { agents: {} };
    if (path.endsWith("/jobs"))
      return { jobs: [], liveJobs: [], hasMore: false };
    if (path.endsWith("/reviews")) return { reviews: [], hasMore: false };
    if (path.endsWith("/ci"))
      return { runs: [], subscriptions: [], hasMore: false };
    if (path.endsWith("/models")) return { models: [] };
    if (path.endsWith("/updates")) return { managed: false, reason: "Fixture" };
    return {};
  };
  return {
    tasks,
    current,
    earlier,
    history,
    agents,
    projects,
    calls,
    answer,
    enableLegacyPaging() {
      legacyPaging = true;
    },
    failReads(value = true) {
      failed = value;
    },
    addNewResult() {
      tasks[0].result = {
        ...current,
        id: "result-new",
        taskVersion: 8,
        summary: "A new author report",
      };
      tasks[0].version = 8;
      retained.set(tasks[0].result.id, tasks[0].result);
      history.unshift({
        resultId: tasks[0].result.id,
        seq: 11,
        taskVersion: 8,
        summary: tasks[0].result.summary,
        reportedAt: at,
        reportedBy: author,
        status: "review",
      });
    },
  };
}

// YN-209: synthetic report and status sections as Core keeps them (a normalized
// body; attachments as Core took them), for card-face.test.mjs and, in Chromium,
// card-face-check.mjs. Names, numbers and text are made up. They have the shapes
// R-18 replayed: a lead whose limit falls past the clamp, a 5 × 5 table a wide
// card draws 3 × 3, a summary naming only its lead whose picture falls back to the
// first kept image, a one-line status; and a visual naming a PDF, an English
// opening, Markdown conditions, a small card's two numbers and Metrics past
// the card's four.
const md = (text) => ({ type: "Markdown", props: { text } });
const root = (children, summary) => ({ type: "BriefBody", props: summary ? { summary } : {}, children });
const body = (summary, elements) => ({ root: "body", elements: { body: root(Object.keys(elements), summary), ...elements } });
const TAKEN = "2026-11-17T20:00:00Z";
const image = (name, caption) => ({ name, kind: "image", mime: "image/svg+xml", size: 900, snapshot: true, mayChange: false, takenAt: TAKEN, width: 640, height: 400, ...(caption ? { caption } : {}) });
const pdf = (name) => ({ name, kind: "pdf", mime: "application/pdf", size: 4096, snapshot: true, mayChange: false, takenAt: TAKEN });
const status = { asOf: TAKEN, validFor: 86400 * 365, stale: false };
const metrics = (items) => ({ type: "Metrics", props: { items: items.map(([label, value, unit]) => ({ label, value, ...(unit ? { unit } : {}) })) } });

const LABELS = ["例子", "请求", "路由结果", "耗时", "备注", "来源"];
const ROUTES = ["新卡", "新卡", "新卡", "回答", "挂已有卡"];
const table = (rows, columns) => ({
  type: "Table",
  props: {
    id: "cases", title: "首五例",
    columns: Array.from({ length: columns }, (_, c) => ({ key: `c${c}`, label: LABELS[c] ?? `列${c}` })),
    rows: Array.from({ length: rows }, (_, r) => ({
      id: `r${r}`,
      cells: Object.fromEntries(Array.from({ length: columns }, (_, c) => [`c${c}`, c === 0 ? `例 ${r + 1}` : c === 2 ? ROUTES[r % 5] : c === 3 ? `${((r + 1) * 1.7).toFixed(1)} s` : `合成值 ${r + 1}-${c}`])),
    })),
  },
});

/** The fixtures; `browser: false` ones need what a browser page cannot be given here (a refresh, a requested summary). */
export const CARD_FACE_FIXTURES = [
  {
    id: "long-lead",
    what: "a lead whose limit falls past the clamp; Metrics beside it, Checklist conditions",
    section: {
      key: "cpu-window", kind: "status", title: "CPU 调查 · 日用窗口", status,
      body: body({ lead: "lead", visual: "numbers", conditions: "limits", size: "wide" }, {
        lead: md("日用 Core 在合成的 20 分钟窗口里平均 0.33 核、峰值 1.8 核；隔离 Core 在同类负载下为 0.09–0.17 核。两组数字来自不同负载，不能相减当作安装收益。**根因未定**：WebView 后台节流和 Job 采样都可能贡献，需要日用窗口内的系统读数才能区分。\n\n第二段：采样方法与窗口选择见下方说明，原始读数留在任务上。"),
        numbers: metrics([["日用平均", 0.33, "核"], ["日用峰值", 1.8, "核"], ["隔离下限", 0.09, "核"], ["隔离上限", 0.17, "核"]]),
        limits: { type: "Checklist", props: { items: [
          { id: "a", text: "两组负载不同", done: false }, { id: "b", text: "日用窗口只有一个", done: false },
          { id: "c", text: "未测 WebView 前台", done: false }, { id: "d", text: "Job 采样间隔 1 s", done: true }, { id: "e", text: "Linux Chromium", done: true }] } },
        findings: { type: "Findings", props: { items: [1, 2, 3, 4].map((n) => ({ id: `f${n}`, source: "合成", severity: "info", text: `发现 ${n}` })) } },
        sources: { type: "Sources", props: { items: [1, 2, 3].map((n) => ({ id: `s${n}`, label: `来源 ${n}`, href: `https://example.test/${n}` })) } },
      }),
      attachments: [],
    },
  },
  {
    id: "table-wide",
    what: "an explicit visual: a 5 × 5 table, of which a wide card draws 3 × 3",
    section: {
      key: "route-five", kind: "report", title: "路由首五例复盘",
      body: body({ lead: "lead", visual: "cases", size: "wide" }, { lead: md("首五例里 3 例发新卡、1 例回答、1 例挂已有卡；每例都按请求的原意路由。"), cases: table(5, 5) }),
      attachments: [],
    },
  },
  {
    id: "table-large",
    what: "the same table on a large card: six columns drawn, fewer fit a phone",
    section: {
      key: "route-five-large", kind: "report", title: "路由首五例复盘（大卡）",
      body: body({ lead: "lead", visual: "cases", size: "large" }, { lead: md("首五例里 3 例发新卡、1 例回答、1 例挂已有卡；每例都按请求的原意路由。"), cases: table(5, 6) }),
      attachments: [],
    },
  },
  {
    id: "fallback",
    what: "a summary naming only its lead: the picture falls back to the first kept image",
    section: {
      key: "review-v1", kind: "report", title: "上一版三项审查",
      body: body({ lead: "lead", size: "large" }, {
        lead: md("三项审查都已交付：会话、路由和 Jobs。核心判断见对照图。"),
        detail: md("对照图比较了改前与改后的卡面。"),
        files: { type: "Attachments", props: { items: [{ name: "conversation.svg", caption: "会话截图" }, { name: "comparison.svg", caption: "核心对照图" }, { name: "notes.pdf" }] } },
      }),
      attachments: [image("conversation.svg", "会话截图"), image("comparison.svg", "核心对照图"), pdf("notes.pdf")],
    },
  },
  {
    id: "visual-dropped",
    what: "a visual naming a PDF: not a picture, so the first kept image is",
    section: {
      key: "review-pdf", kind: "report", title: "审查 PDF 与对照图",
      body: body({ lead: "lead", visual: "pdf", size: "wide" }, {
        lead: md("审查报告是 PDF；对照图另附。"),
        pdf: { type: "Attachments", props: { items: [{ name: "review.pdf" }] } },
        pictures: { type: "Attachments", props: { items: [{ name: "comparison.svg" }] } },
      }),
      attachments: [pdf("review.pdf"), image("comparison.svg")],
    },
  },
  {
    id: "simple-text",
    what: "a one-line status",
    section: {
      key: "mac-lab", kind: "status", title: "Mac 更新实验通过", status,
      body: body({ lead: "lead", size: "small" }, { lead: md("Lab 中的 Mac 更新实验通过；正式版待验。") }),
      attachments: [],
    },
  },
  {
    id: "unnamed-en",
    what: "no summary named: a long English opening; the table after it is not on the card",
    section: {
      key: "import-notes", kind: "report", title: "Importer notes",
      body: body(null, {
        opening: md("The importer now keeps every row it can read and reports the rest by line number, so a partly broken export no longer stops the whole run; the three files that failed before all import, but one of them still loses its time zone, which is the next fix."),
        rows: table(4, 3),
      }),
      attachments: [],
    },
  },
  {
    id: "en-bold-metrics",
    what: "an English lead with bold and numbers; five Metrics, of which a wide card draws four",
    section: {
      key: "queue-wait", kind: "report", title: "Queue wait after the budget change",
      body: body({ lead: "lead", visual: "waits", size: "wide" }, {
        lead: md("Median wait fell from **610 s to 41 s** across 196 synthetic Jobs once the budget counted held CPU; the 90th percentile is still **4.2 min**, because three large builds queue behind each other at 09:00 UTC."),
        waits: metrics([["Median wait", 41, "s"], ["P90 wait", 4.2, "min"], ["Jobs", 196], ["Held CPU", 1.1, "cores"], ["Builds queued", 3]]),
      }),
      attachments: [],
    },
  },
  {
    id: "md-conditions",
    what: "a small card with Markdown conditions longer than two lines",
    section: {
      key: "restore-drill", kind: "report", title: "恢复演练通过（小库）",
      body: body({ lead: "lead", conditions: "limits", size: "small" }, {
        lead: md("合成小库的备份、校验与恢复都通过，身份与条目一致。"),
        limits: md("只在 2.6 MB 的合成库上验证；大库的恢复时间、真实 SSH 中断和生产库的来源链接都没有验证，不能据此推断线上恢复耗时。"),
      }),
      attachments: [],
    },
  },
  {
    id: "small-numbers",
    what: "a small card whose visual is two Metrics: drawn as two numbers",
    section: {
      key: "review-times", kind: "status", title: "审查耗时", status,
      body: body({ lead: "lead", visual: "times", size: "small" }, {
        lead: md("最近 100 次审查的中位与 P90。"),
        times: metrics([["中位", 69.2, "s"], ["P90", 121.2, "s"]]),
      }),
      attachments: [],
    },
  },
  {
    id: "refreshing",
    what: "a card that refreshes itself, with no size named: wide, and it keeps its page",
    refreshes: true,
    browser: false,
    section: {
      key: "daily-digest", kind: "report", title: "每日摘要",
      body: body(null, { opening: md("今天没有新的论文。") }),
      attachments: [],
    },
  },
  {
    id: "repaired-visual",
    what: "the author named a visual Core's repair removed: the card says so and shows its fallback",
    requested: { lead: "lead", visual: "tabs" },
    browser: false,
    section: {
      key: "repaired", kind: "report", title: "修复后的摘要",
      body: body({ lead: "lead", size: "wide" }, {
        lead: md("修复移除了 visual。"),
        shots: { type: "Attachments", props: { items: [{ name: "after.svg" }] } },
      }),
      attachments: [image("after.svg")],
    },
  },
];

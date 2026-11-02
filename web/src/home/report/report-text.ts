import { strings } from "../../i18n";

type Reason = "seen" | "resolved" | "removed";

/** A Home report's own words (T-18); the section's title and body are shown as written. */
export const reportText = strings({
  report: "Report",
  page: (title: string) => `Report: ${title}`,
  home: "Home",
  backHome: "Back to Home",
  backToMessage: "Back to the message",
  copyLink: "Copy link",
  openReport: "Open report",
  openReportLabel: (title: string) => `Open the report “${title}”`,
  version: (n: number) => `version ${n}`,
  onThisPage: "On this page",
  contents: "Contents",
  summary: "Summary",
  blocksUpdated: (n: number) => (n === 1 ? "1 block updated since you last saw it" : `${n} blocks updated since you last saw it`),
  sources: (n: number) => (n === 1 ? "1 source" : `${n} sources`),
  attachments: (n: number) => (n === 1 ? "1 attachment" : `${n} attachments`),
  showAll: "Show all",
  showLess: "Show less",
  reading: "Reading Home…",
  readFailed: "Home couldn't be read just now; this is the last reading.",
  later: (linked: number, now: number) =>
    `This link is to version ${linked}. The report is at version ${now} now, and Home keeps only its newest version.`,
  arrived: (shown: number, now: number) => `You are reading version ${shown}. Version ${now} has arrived.`,
  openVersion: (n: number) => `Open version ${n}`,
  history: (reason: Reason): string =>
    reason === "seen"
      ? "You marked this report seen; it is in History."
      : reason === "resolved"
        ? "This was resolved; it is in History."
        : "Its author removed this report; it is in History.",
  historyVersion: (linked: number, kept: number) => `The link is to version ${linked}; History keeps version ${kept}.`,
  unknown: "Home has no report it can tell is the one linked. It may have left History, or another report has its name now.",
  gone: "This report's project is not on Home.",
  showProject: "Show the project on Home",
  otherWorkspace: "This report link is to another Workspace's Home. Open the Yuzuno that holds that Workspace.",
  actions: "Report actions",
}, {
  report: "报告",
  page: (title: string) => `报告：${title}`,
  home: "Home",
  backHome: "返回 Home",
  backToMessage: "返回消息",
  copyLink: "复制链接",
  openReport: "打开报告",
  openReportLabel: (title: string) => `打开报告“${title}”`,
  version: (n: number) => `第 ${n} 版`,
  onThisPage: "本页内容",
  contents: "目录",
  summary: "摘要",
  blocksUpdated: (n: number) => `自你上次查看以来有 ${n} 个部分更新`,
  sources: (n: number) => `${n} 个来源`,
  attachments: (n: number) => `${n} 个附件`,
  showAll: "展开全部",
  showLess: "收起",
  reading: "正在读取 Home…",
  readFailed: "暂时无法读取 Home；这是上次读取的内容。",
  later: (linked: number, now: number) => `此链接指向第 ${linked} 版。报告现在是第 ${now} 版，Home 只保留最新版本。`,
  arrived: (shown: number, now: number) => `你正在阅读第 ${shown} 版。第 ${now} 版已送达。`,
  openVersion: (n: number) => `打开第 ${n} 版`,
  history: (reason: Reason): string =>
    reason === "seen" ? "你已将此报告标为已读，它在历史中。" : reason === "resolved" ? "此项已解决，它在历史中。" : "作者已移除此报告，它在历史中。",
  historyVersion: (linked: number, kept: number) => `链接指向第 ${linked} 版；历史中保留的是第 ${kept} 版。`,
  unknown: "Home 中没有能确认是此链接所指的报告。它可能已离开历史，或另一份报告现在用了它的名称。",
  gone: "此报告所属的项目不在 Home 上。",
  showProject: "在 Home 上显示该项目",
  otherWorkspace: "此报告链接属于另一个工作区的 Home。请打开包含该工作区的 Yuzuno。",
  actions: "报告操作",
});

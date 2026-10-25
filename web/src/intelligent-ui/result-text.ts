import { strings } from "../i18n";

/**
 * The words around an interactive result, in the interface language (T-189):
 * its frame, the line said in its place while it loads or when it can't be
 * shown, and the details folded under that line. What the Agent wrote (the
 * result's title, text, labels and instructions), the result's JSON, the
 * validator's code, place and reason, and what goes into a draft are shown
 * as they are.
 */
export const resultText = strings({
  details: "Details",
  detailsJson: "Details and result JSON",
  json: "Result JSON",
  code: "Code",
  where: "Where",
  reason: "Reason",
  copy: "Copy result JSON",
  unavailable: {
    format: "This interactive result couldn’t be shown: its format isn’t valid.",
    unfinished: "This interactive result couldn’t be shown: the reply stopped before it was complete.",
    multiple: "Only one interactive result is shown per reply. This one is kept below as JSON.",
    load: "The interactive result viewer couldn’t be loaded.",
    render: "This interactive result couldn’t be displayed.",
    fetch: "This interactive result couldn’t be loaded.",
    missing: "This interactive result is no longer available.",
  },
  tryAgain: "Try again",
  reload: "Reload Yuzuno",
  placeholder: {
    result: "Loading interactive result…",
    generating: "Generating interactive result…",
    reply: "Loading the full reply…",
  },
  restFailed: "The rest of this reply couldn’t be loaded.",
  // The result's frame
  title: "Interactive result",
  viewJson: "View result JSON",
  sources: "Sources",
  partFailed: "This part of the result couldn’t be displayed.",
  selected: (count: number) => `${count} selected`,
  selectFirst: "Select an item to continue",
  ready: "Ready when you are",
  added: "Added to your draft. You can edit it before sending.",
  adds: "Adds to your draft · you choose when to send",
}, {
  details: "详情",
  detailsJson: "详情与结果 JSON",
  json: "结果 JSON",
  code: "代码",
  where: "位置",
  reason: "原因",
  copy: "复制结果 JSON",
  unavailable: {
    format: "此交互结果无法显示：它的格式无效。",
    unfinished: "此交互结果无法显示：回复在完成之前就停止了。",
    multiple: "每条回复只显示一个交互结果。这一个以 JSON 形式保留在下面。",
    load: "无法加载交互结果查看器。",
    render: "此交互结果无法呈现。",
    fetch: "无法加载此交互结果。",
    missing: "此交互结果已不可用。",
  },
  tryAgain: "重试",
  reload: "重新加载 Yuzuno",
  placeholder: {
    result: "正在加载交互结果…",
    generating: "正在生成交互结果…",
    reply: "正在加载完整回复…",
  },
  restFailed: "无法加载这条回复的其余部分。",
  title: "交互结果",
  viewJson: "查看结果 JSON",
  sources: "来源",
  partFailed: "结果的这一部分无法显示。",
  selected: (count) => `已选择 ${count} 项`,
  selectFirst: "选择一项后即可继续",
  ready: "准备好后即可继续",
  added: "已加入你的草稿。发送前可以修改。",
  adds: "加入你的草稿 · 由你决定何时发送",
});

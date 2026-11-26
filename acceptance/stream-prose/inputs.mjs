// The replies acceptance/stream-prose/profile.mjs streams (YN-234), also
// streamed by differential.mjs: each a text already shown and 30 appends.
import assert from "node:assert/strict";

export const APPENDS = 30;
// The paragraph of the earlier measurement (Job 77051c80): Chinese with bold,
// italic, a link and inline code.
export const para = "本段比较 **请求卡** 和 *项目状态*。查看 [这份记录](https://example.invalid/report)，再核对 `currentState` 的结果。";
/** Appends that go on writing paragraphs like it, a new one every few. */
function paragraphAppends(count) {
  const pieces = ["本段比较 ", "**请求卡** 和 *项目", "状态*。查看 [这份记录](https://example.invalid/", "report)，再核对 `currentState` 的结果。"];
  return Array.from({ length: count }, (_, i) => (i % 4 === 0 ? "\n\n" : "") + pieces[i % 4]);
}
/** A reply of headings, paragraphs, lists, a table and code, ~`chars` long. */
function mixed(chars) {
  const sections = [];
  for (let n = 1; sections.join("").length < chars; n++)
    sections.push(
      `## 第 ${n} 部分：结果\n\n${para}\n\nThe run took **${n * 3} s** on \`main\`; see [the log](results/yn234/run-${n}.log:12) and [the job](https://example.invalid/jobs/${n}).\n\n` +
        `- 第一项：*已合入*，随 core.${40 + n} 生效\n- 第二项：待审查\n  - 子项 ${n}\n- 第三项：\`npm test\` 通过\n\n` +
        `1. 构建\n2. 测试\n3. 发布\n\n| 项目 | 基线 | 候选 |\n|---|---:|---:|\n| 耗时 | ${n}.5 ms | ${n}.1 ms |\n| 节点 | ${n * 10} | ${n} |\n\n` +
        "```ts\nconst blocks = new ProseBlocks(root);\nblocks.show(text, false);\n```\n\n> 注意：这只是 Linux Chromium 的机制验证。\n\n",
    );
  return sections.join("").trim();
}
/** Appends of the mixed kind: a paragraph, then a list, then a fence still open. */
function mixedAppends() {
  const pieces = [
    "\n\n## 最后一部分\n\n", "这一段继续写 **加粗", "的内容** 和 [链接](https://example.invalid/x)。", "再补一句，", "说明 `ProseBlocks` 的用途。",
    "\n\n- 第一项", "：说明", "\n- 第二项", "：*斜体*", "\n- 第三项\n\n", "1. 步骤一", "\n2. 步骤二", "\n\n| a | b |\n|---|---|\n", "| 1 | 2 |\n", "| 3 | 4 |\n\n",
    "```ts\n", "const a = 1;\n", "const b = a + 1;\n", "\n// 空行之后\n", "console.log(b);\n", "```\n\n", "> 引用", "继续\n\n", "结尾段落，",
    "还有几个字，", "**最后的", "结论**。", "\n\n补充：", "全部完成。", " 谢谢。",
  ];
  assert.equal(pieces.length, APPENDS);
  return pieces;
}
// A reply shows once it has some text: it starts as "好的".
const shortAppends = () =>
  ["，我", "来看", "看。", "\n\n", "已经", "找到", "原因：", "`detail-sync`", " 每", " 100 ms", " 合并", "一批。", "\n\n", "- 第一", "点", "\n- 第二", "点", "\n\n", "Done", ".", " 需要", "我继续", "吗？", "\n\n", "（", "补充", "说明", "）", "。", "谢谢。"];

export const scenarios = [
  { name: "long-160", text: Array.from({ length: 160 }, () => para).join("\n\n"), appends: paragraphAppends(APPENDS) },
  { name: "long-16", text: Array.from({ length: 16 }, () => para).join("\n\n"), appends: paragraphAppends(APPENDS) },
  { name: "mixed-14k", text: mixed(14_000), appends: mixedAppends() },
  { name: "short", text: "好的", appends: shortAppends() },
];


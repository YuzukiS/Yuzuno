// Markdown for the tests of src/prose-blocks.ts (YN-234): samples of what
// replies are made of, and documents made of random blocks, the same for
// tools/prose-blocks.test.mjs (JSDOM) and acceptance/stream-prose/differential.mjs
// (Chromium). Kept free of imports, so a page can be given it as it is.

/** Cuts after every `size` characters. */
export const every = (text, size) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => (i + 1) * size);

/** A fixed sequence of numbers in [0, 1), so that a failure is the same every run. */
export function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

export const para = "本段比较 **请求卡** 和 *项目状态*。查看 [这份记录](https://example.invalid/report)，再核对 `currentState` 的结果。";
export const corpus = {
  paragraphs: Array.from({ length: 8 }, () => para).join("\n\n"),
  chinese:
    "**结论：**先做这个。\n\n这是**「重要」**的事，*斜体。*字。\n\n中文**\"引号\"**中文和 `code` 与 [链接](notes.md:42)。\n\n最后一段没有结尾",
  headings:
    "# 标题一\n\n第一段。\n## 标题二\n第二段\n跨两行。\n\nSetext 标题\n===\n\n再一段\n---\n\n2024 年的数字开头。\n\n结束。",
  lists:
    "Steps:\n- one\n- two\n\n- three, now loose\n\n  continued in the item\n\n1. first\n2. second\n   - nested *a*\n   - nested b\n\n3) other delimiter\n\n* [ ] task\n* [x] done\n\nAfter the lists.\n\n+ plus\n+ list\n\nend",
  fences:
    "Before.\n\n```ts\nconst a = 1;\n\nconst b = `x`;\n```\n\nBetween.\n\n~~~\ntilde\n~~~\n\n```\nunclosed fence\n\n# not a heading\n\n- not a list",
  indented: "Text.\n\n    indented code\n\n    still code\n\nAfter code.\n\n    more code\n\tand a tab\n\nEnd.",
  quotes: "> quoted\nlazy line\n\n> second quote\n> > nested\n\nAfter.\n\n> - list in quote\n>   more\n\nDone.",
  tables:
    "A table:\n\n| a | b |\n|---|:-:|\n| 1 | **2** |\n| 中文 | `x` |\n\nAfter the table.\nnot a | table\n|---|\n\nEnd.",
  breaks: "Hard  \nbreak and\\\nbackslash.\n\n***\n\n___\n\n- - -\n\nText with trailing spaces   \n\n   \n\nAfter a line of spaces.",
  links:
    "Autolink https://example.invalid/a and <https://example.invalid/b> and www.example.invalid.\n\n[file](src/App.tsx:12) and [msg](yuzuno://message/x) and **[bold link](https://example.invalid/c)**.\n\n![image](https://example.invalid/i.png) is dropped.",
  references:
    "See [the report][r] and [Other].\n\n[Other] again, and [r].\n\n[r]: https://example.invalid/report \"Report\"\n[other]: <https://example.invalid/other>\n\nAfter the definitions [r].",
  html: "Some <b>bold\n\ntext</b> and <em>more.\n\n<div>\n\n*inside*\n\n</div>\n\n<details><summary>s</summary>\n\nhidden\n\n</details>\n\nend <script>alert(1)</script>",
  crlf: "Windows\r\nline\r\n\r\n- a\r\n- b\r\n\r\nend\r",
  emphasis: "*a\n\nb*\n\n**open bold\n\nnext**\n\n`open code\n\nspan`\n\n_under_score_ and __strong__.",
};

const lines = [
  "word", "中文**粗体。**汉字", "- item", "* item", "+ item", "1. one", "2) two", "10. ten", "  indented", "    code", "\tcode",
  "> quote", ">", "# heading", "###### six", "===", "---", "***", "___", "```", "```js", "~~~", "| a | b |", "|---|---|",
  "1 starts with a digit", "-not a list", "[x]: https://example.invalid", "<div>", "</div>", "<b>", "text <i>tag</i>",
  "trailing  ", " ", "   ", "a | b", "`code", "**bold", "_em_", "[link](https://example.invalid)", "\\*escaped",
  "  - nested", "   1. nested", "> - quoted list", "* [ ] task", "| 1 | 2 |", "[ref] and [ref][]", "<!-- note -->", "&amp; &lt;",
  "*斜体开始", "结束。*字", "\\", "Setext", "b*", "~~struck~~", "https://example.invalid/auto", "0. zero",
];

/** A document of 3–16 random lines, each followed by one, two or three newlines. */
export function randomDocument(next) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const parts = [];
  const count = 3 + Math.floor(next() * 14);
  for (let i = 0; i < count; i++) parts.push(pick(lines), next() < 0.45 ? "\n\n" : next() < 0.2 ? "\n\n\n" : "\n");
  return parts.join("");
}

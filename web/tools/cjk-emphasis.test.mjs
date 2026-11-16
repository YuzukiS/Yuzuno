// YN-172: `*` and `**` next to Chinese, Japanese or Korean text, as the
// conversation and Home read Markdown (src/markdown.ts), follow the CommonMark
// CJK-friendly amendments
// (https://github.com/tats-u/markdown-cjk-friendly/blob/main/specification.md).
// Text without such characters renders exactly as plain marked renders it.
import test from "node:test";
import assert from "node:assert/strict";
import { Marked } from "marked";
import { markdownHtml } from "../src/markdown.ts";

const plain = new Marked({ gfm: true });
/** What marked made of it before YN-172. */
const before = (text) => plain.parse(text, { async: false });

test("bold or italic that ends with CJK punctuation closes before a CJK character", () => {
  for (const [markdown, html] of [
    ["**粗体。**汉字", "<p><strong>粗体。</strong>汉字</p>\n"],
    ["*斜体。*字", "<p><em>斜体。</em>字</p>\n"],
    ["**结论：**先做这个", "<p><strong>结论：</strong>先做这个</p>\n"],
    ["**太好了！**我们走吧", "<p><strong>太好了！</strong>我们走吧</p>\n"],
    ["中文**\"引号\"**中文", "<p>中文<strong>&quot;引号&quot;</strong>中文</p>\n"],
    ["**強調。**日本語", "<p><strong>強調。</strong>日本語</p>\n"],
    ["**강조。**한국어", "<p><strong>강조。</strong>한국어</p>\n"],
  ])
    assert.equal(markdownHtml(markdown), html, markdown);
});

test("bold opens after a CJK character before CJK punctuation", () => {
  assert.equal(markdownHtml("这是**「重要」**的事"), "<p>这是<strong>「重要」</strong>的事</p>\n");
});

test("in a list, a table and a quote as in a paragraph", () => {
  assert.equal(
    markdownHtml("- **第一步：**合入\n- **第二步：**发布"),
    "<ul>\n<li><strong>第一步：</strong>合入</li>\n<li><strong>第二步：</strong>发布</li>\n</ul>\n",
  );
  assert.match(markdownHtml("| 项 | 值 |\n|---|---|\n| **状态：**通过 | 1 |"), /<td><strong>状态：<\/strong>通过<\/td>/);
  assert.equal(markdownHtml("> **注意：**这是引用"), "<blockquote>\n<p><strong>注意：</strong>这是引用</p>\n</blockquote>\n");
});

test("CJK emphasis that already rendered renders as before", () => {
  for (const markdown of ["**粗体**。", "_斜体_。", "（**注意**）后面", "**中文**English", "**好！**😀", "[**链接。**](https://example.com)文字"]) {
    assert.equal(markdownHtml(markdown), before(markdown), markdown);
    assert.match(markdownHtml(markdown), /<(strong|em)>/, markdown);
  }
});

test("`_`, `__` and `~~` read as CommonMark and marked read them", () => {
  // The amendments keep `_` between two characters from closing, as CommonMark does;
  // strikethrough is not part of them.
  for (const markdown of ["_斜体。_字", "__粗体。__汉字", "~~删除。~~汉字"]) {
    assert.equal(markdownHtml(markdown), before(markdown), markdown);
    assert.doesNotMatch(markdownHtml(markdown), /<(em|strong|del)>/, markdown);
  }
});

test("code keeps its asterisks", () => {
  assert.equal(markdownHtml("`**代码。**汉字`"), "<p><code>**代码。**汉字</code></p>\n");
  assert.equal(markdownHtml("```\n**代码。**汉字\n```"), "<pre><code>**代码。**汉字\n</code></pre>\n");
  assert.equal(markdownHtml("    **代码。**汉字"), "<pre><code>**代码。**汉字\n</code></pre>\n");
  assert.equal(markdownHtml("**粗体。**汉字和`**代码。**汉字`"), "<p><strong>粗体。</strong>汉字和<code>**代码。**汉字</code></p>\n");
});

test("text without CJK characters is byte for byte as before", () => {
  const samples = [
    "Bold **text.** here", 'a**"foo"**b', "**foo**bar", "*a*b", "foo*bar*", "_foo_bar", "snake_case_name",
    "2 * 3 * 4", "***strong em***", "**a *b* c**", "**foo*bar**baz*", "*(*a*)*", "~~gone~~ and ~x~",
    "Ünïcödé **wörds.**ok", "😀**x.**😀", "**«quote»**text", "[**link.**](https://example.com)x",
    "# Title\n\n- **one:**two\n- `**code**`\n\n> *quoted.*text\n\n```\n**fenced**\n```\n",
  ];
  for (const markdown of samples) assert.equal(markdownHtml(markdown), before(markdown), markdown);
  // Short random strings of letters, spaces, delimiters and ASCII punctuation, seeded.
  const alphabet = ["a", "b", " ", "*", "*", "_", "_", "~", "~", ".", "(", ")", '"', "!", "`", "\\", "é", "😀", "\n", "1", "-", "#"];
  let seed = 172;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 20000; i++) {
    const markdown = Array.from({ length: 1 + Math.floor(random() * 18) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    assert.equal(markdownHtml(markdown), before(markdown), JSON.stringify(markdown));
  }
});

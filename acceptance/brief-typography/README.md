# Home's writing has levels (T-9)

A Home card drew an Agent's `h1`, `h2` and `h3` at one size, a block's title
smaller than the body under it, and emphasis one weight step from plain text.
The user, reading a Chinese card, could not tell the levels apart.

This check measures what a build actually draws, and photographs it. Run it
twice to get a before and an after:

```sh
# from web/, against an isolated build (never web/dist)
node_modules/.bin/vite build --outDir /tmp/yuzuno-md-dist --emptyOutDir
YUZUNO_BASELINE=1 YUZUNO_UI_DIST=/tmp/yuzuno-md-dist \
  YUZUNO_CHECK_OUTPUT=../acceptance/brief-typography/before node tools/brief-typography-check.mjs
YUZUNO_UI_DIST=/tmp/yuzuno-md-dist node tools/brief-typography-check.mjs
```

`YUZUNO_BASELINE=1` records measurements and screenshots without asserting,
so a build that does not have the fix can still be photographed.
`YUZUNO_BROWSER_BIN` selects another Chromium build (on a Mac, Google
Chrome's own executable).

It covers desktop and 320 px, light and dark, in both Home densities, on two
cards: a real Chinese progress card, and a sample holding every level at once.
It asserts three heading steps, each above body text; a block title above the
body and above the headings inside it, with only an explicit `h1` leading;
emphasis a full weight step; nothing running off 320 px; and that the page
sends nothing but what Home always sends (its seen marks, and the POST that
reads a Project's repositories).

## Chinese emphasis is not a CSS weight problem

`chinese-emphasis-options.png` is a separate finding, not part of the fix.
On this Mac, in Chrome, Chinese renders with **identical ink at 400, 600 and
700** — measured by drawing the same text at each weight and counting its
pixels — while Latin gains half as much ink again at 700. Forcing the bundled
`Yuzuno Han` face directly does not change it, and allowing weight synthesis
for that span alone does not either. Only CJK emphasis dots (`text-emphasis`)
made it visible. So no CSS weight value will make Chinese bold show until the
font asset or the font stack provides a heavier face; the weight here is for
Latin, and what Chinese emphasis should use is a design decision.

# Home's writing has levels (T-9)

A Home card drew an Agent's `h1`, `h2` and `h3` at one size, a block's title
smaller than the body under it, and emphasis one weight step from plain text.
The user, reading a Chinese card, could not tell the levels apart.

This check reads what a build resolved and laid out — `getComputedStyle` and
the boxes — and photographs it. It does not say which face was drawn: a
computed `font-weight` is not proof that a heavier one reached the screen,
which is what the probe below is for. Run it twice for a before and an
after:

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

It covers desktop and 320 px, light and dark, both Home densities and two
palettes, on two cards: a fixture in the shape of the Chinese progress card
the user was reading — its structure and wording written in the script, not
copied from a Brief — and a sample holding every level at once. The second
palette matters: outside Garden, `appearance.css` draws body, `strong` and
h1–h3 in one ink, so the levels there rest on size and spacing alone, and the
check asserts that heading and body really are the same colour before
measuring the levels.
It asserts three heading steps, each above body text; that an Agent writing
deeper than `h3` stays under it — `####` used to come out *smaller than body
text*, and under the first draft of this fix it would have come out larger
than `##` — a block title above the body and above every heading inside it,
including a written `h4`, with only an explicit `h1` leading;
emphasis a full weight step; nothing running off 320 px; and that the page
sends nothing but what Home always sends (its seen marks, and the POST that
reads a Project's repositories).

## Chinese weight: what is measured, and what is not concluded

`font-weight-probe.mjs` is a read-only probe for one question: does Chinese
text get a heavier face at 600 or 700 in a given build?

```sh
# from web/, against the same isolated build
YUZUNO_UI_DIST=/tmp/yuzuno-md-dist node ../acceptance/brief-typography/font-weight-probe.mjs
```

It writes its full record beside this file as `font-weight-probe.json`, with a
screenshot. The method is in the script's header; the parts that matter are
that canvas never loads a web font by itself (so every face is loaded with
`document.fonts.load(font, sample)` for the exact text first, and
`document.fonts.check` is recorded after), that `ctx.font` is read back
because the browser may reject a string silently, that the glyph bounding box
is reported so clipping cannot be mistaken for less ink, and that CJK glyphs
keep the same advance width at any weight — so weight shows as ink, never as
width.

**Measured on this Mac, in Google Chrome** (the record carries the build and
the date; another machine may differ, and Windows has not been measured):

| sample | ink | pixels over half alpha |
|---|---|---|
| 中文 at 400 | 1,347,885 | 5,000 |
| 中文 at 600 | 1,347,885 | 5,000 |
| 中文 at 700 | 1,347,885 | 5,000 |
| 中文 at 700, forced to `'Yuzuno Han'` | 1,347,885 | 5,000 |
| Latin at 400 | 1,389,461 | 5,482 |
| Latin at 700 | 2,105,889 | 8,304 |

Chrome's own answer for which file drew the glyphs
(`CSS.getPlatformFontsForNode`, which is the only one of these that says what
the DOM actually used — forcing a family name or a passing `fonts.check` does
not):

```
中文 400 / 600 / 700 → Noto Sans SC, NotoSansSC-Thin, isCustomFont: true
Latin 400 → .SFNS-Regular     Latin 700 → .SFNS-Bold
```

So the bundled face **is** the one drawing Chinese here, and no weight
changed what it drew. Two things that reading does *not* establish, both
settled elsewhere since:

- The face Chrome names, `NotoSansSC-Thin`, is a name, not a measurement. Its
  outlines turned out to be byte-identical to Regular — Chinese body text was
  never thin, and only bold was missing. `acceptance/cjk-font-weights` has
  the glyph-by-glyph comparison.
- Why it happened is in the file, not in CSS: the subset declared a weight
  axis while carrying no variation data. Allowing `font-synthesis-weight:
  auto` for one span changed nothing, because the face claimed the weight.

Nothing about this is fixed in this slice; the asset is rebuilt separately,
in `acceptance/cjk-font-weights`. This probe stays here because it is the way
to ask the question again on another machine — Windows has not been
measured.

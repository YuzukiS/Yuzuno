# Chinese bold really is bold (T-9)

`font-weight: 700` did nothing to Chinese. The asset was the reason, and it
is worth stating precisely, because two true-sounding explanations are wrong.

**What the shipped `yuzuno-han.woff2` was.** It declared `font-weight: 400
700` and `format("woff2-variations")`, carried `fvar` (wght 400-700), `avar`,
`STAT`, `HVAR` and `VVAR` — and no variation data at all. Its CFF2 TopDict
has no VarStore, no charstring has a blend, and `fontTools` cannot instance
it: it raises `AttributeError: VarStore`. One set of outlines, drawn at every
weight.

**What it was not.** Chrome reports its face as `NotoSansSC-Thin`, which
suggests Chinese was rendering thin. It was not: the outlines are
byte-identical to the rebuilt font's Regular, glyph for glyph and area for
area. The name was stale, inherited from the source family's Thin default
instance. Body text was always Regular, and only bold was missing. Nor was
`font-synthesis: none` the cause — allowing synthesis for a span changed
nothing, because the face claimed to have the weight.

**The rebuild.** `web/tools/cjk-subset.py` makes the asset from the official
Noto Sans SC variable font, pinned by SHA-256, subset to the same 3,631 code
points, with the weight axis *limited* to 400-700 and defaulted to 400 rather
than instanced away. It fails the build if the outlines do not change with
weight, so an asset cannot again promise a bold it cannot draw.

## Measured, on this Mac in Google Chrome

`font-weight-probe.mjs` is the same probe used in `acceptance/brief-typography`
(method in its header: fonts are loaded for the exact sample first, `ctx.font`
is read back, the glyph bounding box is reported so clipping cannot read as
less ink, and ink is measured rather than width, since CJK glyphs keep their
advance width at any weight).

| sample | before | after |
|---|---|---|
| 中文 at 400 | 1,347,885 | 1,325,583 |
| 中文 at 700 | 1,347,885 (same as 400) | **2,088,921** (+58%) |
| 中文 at 700, forced to `'Yuzuno Han'` | 1,347,885 | **2,088,921** |
| Latin at 400 | 1,389,461 | 1,389,461 |
| Latin at 700 | 2,105,889 | 2,105,889 |
| face Chrome used for 中文 | NotoSansSC-Thin | NotoSansSC-Regular |

Latin is untouched — it never came from this font. Chinese at 400 moves by
1.7% in rasterisation while its outlines are identical, so body text keeps the
weight it had.

```sh
# from web/, against an isolated build of this branch
node_modules/.bin/vite build --outDir /tmp/yuzuno-font-dist --emptyOutDir
YUZUNO_UI_DIST=/tmp/yuzuno-font-dist node ../acceptance/cjk-font-weights/font-weight-probe.mjs
```

## What this costs, and what is not covered

The file goes from 546,052 to 899,960 bytes (+65%): that is the variation data
the old one was missing. It is still fetched only when a page asks for a code
point in its `unicode-range`, so an English session never downloads it.

**Not covered:** a formal review cannot read a font binary. The checks above
are the evidence for the asset itself, and they were run on this Mac in
Chrome; **Windows has not been measured**, and which face a Windows browser
actually uses is still an open question for the font investigation.

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
suggests Chinese was rendering thin. It was not: **for every character
compared**, the old outlines are identical to the rebuilt font's Regular,
coordinate for coordinate and area for area — 3 characters here, and 25 in
the Lead's independent static check. That is a sample, not a comparison of
all 3,631: what it establishes is that the stale name does not describe
thinner outlines. The name came from the source family's Thin default
instance. Body text was Regular, and bold was what went missing. Nor was
`font-synthesis: none` the cause — allowing synthesis for a span changed
nothing, because the face claimed to have the weight.

**The rebuild.** `web/tools/cjk-subset.py` makes the asset from the official
Noto Sans SC variable font — pinned to a **commit**, not a branch, and to a
SHA-256 — subset to the same 3,631 code points, with the weight axis
*limited* to 400-700 and defaulted to 400 rather than instanced away.

It then writes the candidate to a temporary file and **checks the bytes that
would ship, read back from disk**: the `wght` axis and its default, a CFF2
VarStore, the exact code point set, that every sampled character is present
(a missing one fails rather than being skipped), that the file can be
instanced at 400 and 700, and that those instances' outlines differ. Only
then does it replace the asset. Checking the font in memory, or the subset
before its axis was limited, would miss exactly the failure that shipped:
variation data lost while limiting or serialising.

Three rejections are confirmed by hand:

| given | result |
|---|---|
| the font that actually shipped, as a candidate | rejected: "carries no variation data (CFF2 has no VarStore)" |
| the font that actually shipped, as a *source* | rejected while subsetting; nothing written |
| a sample character absent from the font | rejected: "missing the characters this check reads" |

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

The file goes from 546,052 to 899,612 bytes (+65%): that is the variation data
the old one was missing. It is still fetched only when a page asks for a code
point in its `unicode-range`, so an English session never downloads it.

The build is **not promised to be byte-identical**. Rebuilds here differed by
a few hundred bytes across runs of the same inputs, so the generated CSS
records the fontTools and brotli versions that made the file (fontTools
4.60.2, brotli 1.2.1 for the committed one). What is promised is the check
above, which the shipped bytes have to pass.

**Not covered:** a formal review cannot read a font binary — review
`becc7f18` covered 5 of this change's 6 paths and returned `unknown` for
exactly that reason, with no findings on the five it could read. The checks
above are the evidence for the asset itself. They were run on this Mac in
Chrome; **Windows has not been measured**, and which face a Windows browser
actually uses is still open for the font investigation.

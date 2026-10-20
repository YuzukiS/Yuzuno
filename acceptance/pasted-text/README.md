# Pasted text blocks (T-33)

Long pastes now occupy a compact, numbered block in the composer. Short text
remains ordinary text. The visible rule is **12 or more lines, or 2,000 or more
characters** (JavaScript UTF-16 length). Both thresholds are inclusive; CRLF is
one line break. The thresholds keep a modest paragraph editable while folding
logs/code or a long single-line payload before it fills the composer.

Hover shows at most six lines / 800 characters as plain text. Click, keyboard
activation or touch opens the complete, selectable source in the existing Radix
dialog. Saving an edit updates its line count without changing its ID/number;
removal, replacement, surrounding typing and edits support undo/redo. Esc closes
the viewer and returns focus. Enter in the composer sends; Shift+Enter inserts
a newline and an IME's composing Enter does not send.

## Implementation and preservation

- CodeMirror 6 state/view/commands provide the plain-text editor, native
  selection, composition and history. There are no language modes or rich-text
  controls. Paste bodies sit outside the editor document; one atomic widget
  occupies their ordered position. Copy/cut expands that position to raw text.
  Only ordinary text keybindings are installed; code-editor line-copy/move and
  character-transpose commands cannot duplicate internal marker characters.
- A draft consists of ordered text and paste parts, with stable UUIDs and a
  monotonically increasing number within that draft. Sending concatenates the
  actual parts, without trimming, labels, summaries or truncation. Both existing
  Harness routes are unchanged. New typing during a request prevents its
  success callback from clearing the changed draft.
- Untouched block bodies retain all original line endings, indentation and
  trailing blank lines. Editing a uniformly CRLF block retains CRLF. Editing
  mixed endings uses LF, as explained in the viewer; ordinary editor text uses
  LF. Viewing or saving without edits does not normalize a block.
- `yuzuno.composer.v1:<agent>` contains the small ordered manifest. Immutable
  bodies use separate `yuzuno.paste.v1:<agent>:<bodyId>` keys. Nearby keystrokes
  read and save only the manifest. An externally changed manifest invalidates
  cached body identities, so a stale window restores missing bodies from its
  full in-memory draft before publishing references. Existing immutable bodies
  are not removed when publication fails. Bodies are published before references; failed
  manifest publication rolls back new bodies. Unreferenced bodies are removed
  after publication; undo can restore them from its in-memory history.
- Old `yuzuno.drafts` string entries load lazily. A new manifest takes precedence;
  a cleared draft leaves an empty manifest so the old string cannot reappear.
  Other Agents' legacy entries are left intact. Missing/corrupt saved bodies
  block editing/sending with an error instead of dropping text. Quota failures
  retain the current in-memory draft with a visible warning.
  A blocked draft has an explicit **Reset saved draft…** action with a
  **Discard saved draft** confirmation. Cancel preserves stored data; failed
  resets leave the editor blocked. Successful reset writes an empty tombstone
  before removing readable references, affects only that Agent, and works even
  if the old manifest is malformed. This is deliberate discard, not partial
  recovery or automatic sending with missing blocks.
- Switching Agents retains the editor history in memory. Reload restores the
  current draft and IDs, not the undo stack. Forking copies the draft into the
  target Agent's own storage namespace.
- Failed Codex sends retain the existing retry identity. The existing outbox is
  now loaded once, rather than reparsed on each composer render. Claude retains
  its existing native-turn failure behavior.
- Appending from Continue/Add answer uses CodeMirror's normalized change length
  for the cursor, including CRLF/CR input. Internal ordinary-text drags use
  CodeMirror's normal move/copy behavior; only external long-text drops fold.
- Hover styling targets the actual CodeMirror wrapper, tagged through the
  public tooltip mount callback. Full-source text follows the reading size.
- Integrated the reviewed main baseline `5b3b36a` (T12/T36) before formal R2.
  The update window's Apply/Reload callback retries only local edits that
  have not been saved successfully, through the new body/manifest storage.
  Successful writes and confirmed resets clear the pending-save marker.
  Already-saved snapshots are never republished by Apply/Reload, even if another
  window has since changed or sent the draft. External changes do not mark a
  local snapshot as unsaved. Damaged drafts or failed writes stop
  the action and show the existing update error UI; an in-memory unsaved block
  is never replaced with an empty fallback. Ordinary typing remains per-Agent.
  T12's catch/admission behavior and all T36 production code match that baseline;
  the sender's only difference is the lazy outbox initialization.

Only the composer/draft integration and the outbox initialization changed in
App/send code. Shared `components.tsx`, Core, native runtimes, image upload,
interactive results and the main working directory were not changed.

Library choice: CodeMirror supplies composition, selections, atomic decorations
and invertible history effects that would be fragile to recreate in a custom
contenteditable. Installed contracts were checked in the pinned packages
(`view` 6.43.14, `state` 6.7.6, `commands` 6.11.1) and exercised above. For
maintenance evidence, the npm registry records view 6.43.14 published on
2026-10-07, one week before this validation. The GitHub archive reflects the
move to `code.haverbeke.berlin/codemirror/view`; direct access to the new site
returned 403 here, so that site was not treated as independently inspected
implementation evidence. The public [API reference](https://codemirror.net/docs/ref/)
and [registry metadata](https://registry.npmjs.org/@codemirror/view) identify the
library; local package contracts and browser tests establish its behavior here.

## Verification (2026-10-14)

- Typecheck and production build passed. All **29 web test files** passed,
  including the T-18 style-invalidation guard, T-34 composer/portal focus,
  connection recovery, Codex fork and session import tests.
- Fourteen draft/editor tests cover inclusive thresholds, multi-block selections,
  raw CRLF, merged and isolated history, stable IDs, legacy migration, refresh,
  bounded storage writes, missing bodies, quota failure, interrupted manifest
  publication, independent fork body retention and clearing an unopened Agent's
  body keys without touching another Agent's draft. R2 adds shared-storage
  instances, stale-cache rollback and explicit damaged-draft discard/failure.
- Full-App coverage (54 tests) includes exact ordered payloads and response loss
  for both Harnesses, editing/removal/Esc/undo without sending or interrupting,
  CRLF/CR Continue and Add answer, and confirmed/cancelled/failed draft reset.
  T12's updated test driver also checks that a failed pasted-body write blocks
  both Apply and Reload, and that retrying Apply saves the raw body first.
  A separate four-case test checks Apply/Reload after an independent writer
  changes or clears the saved block: no draft/body writes occur and the newer
  snapshot stays byte-for-byte intact.
- **Twelve Chromium checks passed** on the built UI at isolated port 4485. They
  use the shared connection fixture and intercept every API/SSE operation; no
  Core or CLI is involved. Native clipboard and keyboard input, CDP IME, touch,
  Agent switching/undo/reload, copy/cut, Backspace/Delete, failed-send refresh
  with Codex retry ID preservation, Chinese UTF-8 limit rejection, light/dark,
  20px text and 390px layouts are covered. R2 adds two actual same-origin pages
  with native shared localStorage (send/remove in A, type in stale B, reload),
  explicit missing-body recovery, and public DOM drag/drop events. Computed
  styles assert wrapper background, 7px radius, 10px padding, viewport bounds,
  fully visible hint, and 20px full-source text in both themes/narrow layouts.
  The full result is retained locally at
  `target/t33/browser-r2-final/report.json`; generated acceptance results are not tracked
  by this repository.
- With a **510,000-character / 30,001-line block**, 80 preceding rendered turns
  and 20 simulated deltas/second, typing 120 characters and holding Backspace
  for 120 deletions took **3,509 ms**, including the intentional 20 ms typing
  delay. All 240 draft writes were small manifests (maximum **304 characters**);
  62 deltas arrived, streamed text appeared, and no >=50 ms long tasks were
  observed during that window. No paste bodies were read during those keystrokes.
  The composer DOM stayed under 100 characters.
  These are synthetic browser measurements, not real Harness timing or a
  before/after benchmark.

Final integrated R2 screenshots/logs are in this worktree's
`target/t33/browser-r2-final/`, `target/t33/updates-r2-final/`,
`target/t33-r2-final-browser.log`, and `target/t33-r2-final-build-tests.log`.
The full-suite run passed 28 files; the new update test initially included
the update request ID in its draft-only comparison. After limiting that
assertion to draft/body keys, all six update tests passed in
`target/t33-r2-final-updates-ui.log`. Exact-commit CI reruns all 29 files.
The update browser run uses real
Chromium with every API mocked and verifies a CRLF pasted block across Apply,
another tab and explicit reload, including a locally edited draft's storage
rejection and retry (`target/t33-r2-final-updates-browser.log`).
The exact candidate HEAD/tree/base and SHA-256 of the tested index/assets are
recorded in `target/t33/r2-final-build-identity.json` and the PR handoff.
Original R1 evidence in `target/t33/browser/`, pre-integration evidence in
`target/t33/browser-r2/`, and the earlier integration attempt in
`target/t33/browser-r2-main/` / `target/t33/updates-r2-main/` are preserved.
The browser's temporary directory is the shorter project-local
`/home/developer/yuzuno-next/target/t33-browser-tmp` (Unix socket path limit).

## Reproduce

Build this worktree's web UI, then run a static preview on an unoccupied port:

```sh
cd web
npm run build
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4485 --strictPort
# In another terminal, through the shared heavy-slot wrapper:
TMPDIR=/home/developer/yuzuno-next/target/t33-browser-tmp \
  node tools/pasted-text-browser.mjs
# Existing CI discovery includes composer-draft.test.mjs automatically:
../.github/scripts/web-tests.sh
```

Use the project's heavy-slot wrapper for builds/tests/browser runs, and a
project-local temporary directory. The browser accepts `T33_UI_URL` and
`YUZUNO_BROWSER_BIN`; it must point to an isolated static build.

## Limits

Core still rejects input over **100,000 UTF-8 bytes**. Blocks do not bypass or
silently truncate that limit; rejected sends keep the draft. The larger browser
fixture above checks editing/storage performance, not a larger send allowance.
Browser storage quota still applies, and undo history ends on reload.

Actual local edits still use last-writer-wins across windows; Apply/Reload
does not publish clean cached snapshots. This does not synchronize editors. Storage failure/crash injection uses a model
and browser prototype faults; the cross-page sequence uses actual localStorage.
IME evidence is CDP simulation, not a physical OS IME. The performance window
excludes the first paste and opening the full viewer. Copying from its textarea
uses browser-normalized LF; copying blocks from the composer preserves raw CRLF.
An old, unconfirmed Codex outbox created before this change may contain trimmed
text. Retrying an old draft with leading/trailing whitespace can therefore get
a new clientMessageId; no outbox migration system is introduced (R1 N3).

The dependency audit reports the same existing dompurify, source-map-js and
undici versions/advisories as the base lockfile; no CodeMirror dependency was
reported. Updating those unrelated packages is outside this change.

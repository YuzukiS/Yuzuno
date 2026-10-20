# Persistent pasted content (T-48)

Long pasted text keeps its ordered blocks after sending: outgoing delivery
previews, conversation history, both Your request views, the Turn dock, and
user-sourced rail/inspector summaries. Each label starts with ten grapheme
clusters from the original source. Hover previews are bounded; opening the
existing Radix dialog mounts the complete selectable text. Closing removes it
and restores focus. Composer previews remain editable.

The composer still folds at 12 lines or 2,000 UTF-16 code units. Ordinary text
and separate identical pastes retain their order and identities. The Harness
and copy operations receive the complete original text, including CRLF.

## Data and identity

`MessageInput.textBlocks` contains only `{ id, start, end }` ranges into the
existing `text`, measured in UTF-16 code units. Empty ranges allow an edited
empty block. Core validates unique IDs, ordered non-overlapping ranges and
Unicode boundaries; there are at most 128 blocks per message. An absent field
means older, flattened content; an empty array records ordinary text explicitly.
Older long text becomes one generic **Long text** block without claiming a
clipboard origin or rewriting storage.

Existing message receipts persist this metadata and a binding consisting of
turn ID, native item ID and the user-message position observed with the native
client ID. Native items carry `_yuzunoTextBlocks`. Receipt identities restore
the annotation before snapshot merge and before returning full history pages.
Codex's synthetic `item-N` history IDs use the previously recorded turn/position;
exact text equality guards that position. There is no search for similar prose.
Repeated identical user messages can therefore retain different block layouts.
If a native message transforms the submitted source, `_yuzunoInputText` retains
the exact source for display/copy; normal native echoes add no second text body.

Claude idle sends now use the existing durable receipt endpoint, extending the
T-38 start path. Its local optimistic input has boundaries immediately but gains
the client ID only after native acknowledgement. Unknown starts never confirm
their own receipt. Working sends retain queued/read/unknown semantics. A retry
keeps its first input and display boundaries: display-only edits cannot generate
a duplicate send after response loss, including old outboxes without metadata.

The implementation keeps `ws.stored`, the single writer, row-dirty planning,
SSE item projection and existing output truncation. No new transcript store or
database table is added. Rail summaries contain bounded text/preview parts
(up to 16 blocks, ten graphemes per label, 160 scalars per hover excerpt, 80
scalars per ordinary-text excerpt); full text is loaded by exact turn/item IDs
through the existing item payload endpoint. Agent progress keeps Agent authorship
and never acquires blocks by matching user prose.

## Reused capabilities

The existing CodeMirror widget/history and Radix dialog remain in place.
[Intl.Segmenter](https://tc39.es/ecma402/#segmenter-objects) supplies browser
grapheme boundaries; the pinned
[unicode-segmentation 1.13.3](https://docs.rs/unicode-segmentation/1.13.3/unicode_segmentation/)
provides equivalent UAX #29 segmentation for bounded Core summaries.
[Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog)
continues to provide modal focus, Escape and portal behavior. No editor or
preview platform was introduced.

## Verification

- Core: the complete suite passed (436 tests, five existing opt-in tests ignored),
  followed by the added restart/reconnect/pagination case. New tests exercise
  Codex start/steer over HTTP with a deterministic native process, Claude
  start/append through the bridge interface, exact Unicode/CRLF transport,
  retry identity, persisted receipt bindings, isolated Core reconstruction,
  synthetic history IDs, duplicate bodies, bounded rail summaries and authorship.
- Web: all 40 test files passed. The update test was run separately with its
  required `YUZUNO_UI_DIST`; the first all-file run omitted that environment
  variable. Full-App tests exercise both Harnesses, unknown retries, all
  content views, legacy fallback, copies and focus restoration. Image-only and
  mixed image/paste requests retain attachment captions without shifting text
  ranges; native `inputText` remains supported alongside `text`. An initial CI
  update test reached its composer before mounting completed; its fixture now
  waits for composer readiness within a bounded timeout.
- Chromium: `web/tools/message-content-browser.mjs` uses the built UI, real
  clipboard/keyboard interaction and intercepted API/SSE calls. It checks
  sending previews, reloads, Agent switches, exact block/full-turn copy,
  bounded hover, focus restoration, rail payload loading and a dark 390px
  viewport with 20px source text. It starts and stops its own static server
  on port 4496. Reports/screenshots are local at `target/t48/browser/`.

Use the shared `target/heavy-slot.sh`, cargo `-j 4` with serial tests and
4 GiB/zero-swap limits, or Node/browser 3 GiB/zero-swap with a 2 GiB V8 heap.
Clear inherited `YUZUNO_RESULT_VALIDATOR` and `YUZUNO_CLAUDE_BRIDGE` for Core
tests so they use this checkout's assets. The initial Core run inherited a
different daily-release validator and was repeated with the correct environment.

These checks use deterministic protocol peers, not paid live model tasks.
The daily Core, database and assets were untouched. Existing 100 KB message
and browser draft-storage limits still apply. A receipt with no observed native
identity cannot reconstruct lost clipboard boundaries from prose alone.

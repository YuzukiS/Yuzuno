# T73 follow-up: recover review tool arguments

T23 review `3a9e8b73-9e52-4b46-9899-02e32c134664` made 122 repeated
`source_search` calls without `cursor`, exhausting the 160-call limit while
using only about 13% of the context byte budget. The original failed review and
the first T73 delivery (PR50) remain unchanged.

Both reviewer tool schemas now advertise an optional initial search cursor,
defaulting to `0:1`. Rust applies the default only when the field is absent;
an explicit invalid value fails with a correction hint. Subsequent pages use
the returned cursor. Claude forwards the five authorized tools' original
arguments to Core before SDK validation so Core can retain the same validation
receipts, enforce the same retry bound, and apply the same recovery rules as
Codex. Tool names, fixed Git revisions and read-only isolation remain enforced.

An argument failure stays unresolved until a successful call to the same tool
preserves its valid supplied fields. Explicit paths/revisions cannot be changed
to clear a failure. Each recovered failure names its successful receipt; all
original requests and errors remain. This grants no synthetic source coverage.
Valid read ranges, including those attached to a missing/unknown-argument
failure, can be recovered by complete split reads from the same frozen
path/revision. A missing source identity binds to the first successful
correction, preventing ranges from different sources from being combined.
When a request has several mistakes, successful fixed-source metadata also
checks the original cursor/offset bounds before preserving pagination as a
recovery condition. Valid continuations remain required. Missing source,
partial coverage and terminal limits still produce an incomplete conclusion.

Three identical unsuccessful requests stop the shared Core review loop after
persisting the third receipt and terminal reason. Earlier errors return the
schema and correction instructions. The 160-call / 1.5 MB / 900-second budgets
are unchanged. Tests cover omitted and explicit cursors, malformed cursors,
other missing arguments, successful correction, source identity mismatches,
remaining line gaps, and durable termination through the shared harness entry.
Claude tests exercise actual SDK MCP transport and advertised schemas without
launching a model.

This fix requires its own PR, exact-head CI, and independent review by the
published Core. A separately identified candidate binary may serve the user's
single authorized T23 retry at head
`1c6e5c94ba9e0c981c4a07c85daf0beaae0d8a0f`, base
`6673c3ef237a934fd5220cb6ce15738ec78d79bf`. Dev3 owns that review. This does
not authorize publishing, changing the daily Core, altering T23, deleting failed
rounds, or increasing global review limits.

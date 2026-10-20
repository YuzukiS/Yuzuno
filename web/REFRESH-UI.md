# Refresh the daily window after UI edits

From `web/`, run `npm run refresh:ui`. After it reports success, refresh the
existing daily window at its current address. Core serves static assets from
disk, so no Core restart or new window is needed. This command builds in a fresh
temporary directory, type-checks, creates the standalone preview, and runs the UI
checks before publishing. It copies assets first and atomically replaces
`dist/index.html` last. Already-open windows retain their old hashed assets.
It never sends API requests, changes Core or database state, or refreshes a window.

For additional browser checks before publication:

```sh
npm run refresh:ui -- --stage-only
# Use the staged directory printed above:
YUZUNO_UI_DIST=/tmp/yuzuno-ui-EXAMPLE node tools/context-usage-check.mjs
npm run refresh:ui -- --publish /tmp/yuzuno-ui-EXAMPLE
```

Publication refuses if the source, staged output, or daily index changed after
validation. Stage again against the current files. A copy of the previous index
is retained at `STAGED_DIRECTORY/.previous-index.html` for manual rollback;
old assets are retained. Full `npm run build` still clears `dist` and should not
be used to update a window during ongoing work.

The context indicator is currently **UI only**. Real conversations show a neutral
dashed ring and an unavailable explanation. Hover, focus, or tap to view details;
Escape dismisses those details without interrupting the agent. The explicitly
labelled `/?preview=1` specimen shows Mikan at 46%, Mori at 78%, and Hana at 94%.
These sample values never appear in a real conversation. Colors are green below
70%, amber from 70%, and coral from 90%; the arc and textual percentage also
communicate the value without relying on color alone.

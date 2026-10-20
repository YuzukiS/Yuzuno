# Yuzuno desktop interface

A warm, compact desktop workspace: a persistent agent rail, turn-based conversation, and a collapsible context pane. Cream paper, yuzu yellow, leaf green, and the original Yuzuno character from an earlier project provide personality without a dashboard of oversized cards. Native windows retain the operating system’s decorations; browser mode never draws fake window controls.

## Run

Requires Node 22.12+ (Node 22.23.2 verified).

```sh
npm ci
npm run build
npm test
npm run dev
```

The development server listens on `127.0.0.1:5173` and proxies `/api` to the workspace core at `127.0.0.1:4317`. For the integrated app, start the core from the repository instructions; it serves `dist` directly.

The desktop client also uses the origin of the page it loaded for API calls, event streams, and artifacts. `?shell=desktop` changes presentation only: it does not redirect connections to a fixed port. A Windows Tauri window can therefore open a Core running in WSL without confusing the UI machine with the execution host. Working folders and the Codex login belong to the Core host. An explicit `VITE_API_BASE` remains available for separately hosted development configurations with an appropriate server boundary.

`npm run build` also writes **`dist/design-preview.html`**, a standalone file that opens without a server. Its persistent banner identifies it as a read-only visual specimen. The preview never sends API requests or creates real agents. `/?preview=1` exposes the same specimen through the app server. Normal mode always loads workspace data from the core and starts with a truthful empty or disconnected state.

## File references with line numbers

Agent replies can link to `[View code](web/src/App.tsx:42)` or `[View code](web/src/App.tsx#L42)`. Both open the existing read-only file dialog, show source line numbers, and scroll to the highlighted line. Paths resolve from the agent's working folder, as before; only the path is sent to the existing artifact API. The `path:line:column` form also locates the line. Blank lines and CRLF files retain their source positions; a trailing newline creates a final empty line. An empty file has zero lines. Invalid locations show the requested line and the available range without silently selecting another line.

Ordinary Markdown links retain rendered headings, tables, and other Markdown formatting. A Markdown link with a line number shows its numbered source instead. Plain text and image links still open in the same dialog. Copy contents copies the original file, excluding the line-number gutter. Closing with the close button or Escape preserves the conversation's reading position, focus, and unsent draft. Escape consumed by a dialog does not interrupt the agent.

`npm test` includes file-link routing, Markdown/source rendering, line bounds, copy fidelity, draft/reading-position preservation, and late-response checks. For actual scroll geometry and focus behavior, run the isolated Chromium fixture check after building:

```sh
YUZUNO_BROWSER_BIN=/usr/sbin/chromium node tools/file-lines-check.mjs
```

This uses a temporary local fixture server, never connects to Core, and writes its report and screenshots to `../acceptance/file-lines/`. It checks both link formats, first/last lines, out-of-range feedback, ordinary previews, draft preservation, and close/Escape behavior at 1440×960 and 940×650, with no mutation requests. It does not claim a live model or native WebView test. The first browser run exposed Escape falling through to the interrupt shortcut; `initial-escape-regression.json` retains that failure, and `report.json` records the passing retest.

## Current conversation search

The search button in the conversation header and Ctrl/Cmd+F open a search dialog for the selected agent's loaded messages. Matching is literal and case-insensitive, including Chinese. Each message appears once with its role, turn number, and matching snippet. User messages, agent progress, and replies are included; tools and other agents are excluded. Switching agents clears the query and results.

Selecting a result closes the dialog, focuses the exact message, and highlights it for 2.6 seconds. Automatic following stays paused even if the result is near the bottom and new execution events arrive. Use **Back to latest** to resume following. Escape inside search closes only the dialog. Search and navigation never send a review, pending-response, or interrupt request.

Build and test this slice separately from the daily UI, from `web/`:

```sh
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --outDir /tmp/yuzuno-conversation-search-dist --emptyOutDir
node --experimental-strip-types tools/conversation-search.test.mjs
YUZUNO_UI_DIST=/tmp/yuzuno-conversation-search-dist node tools/ui.test.mjs
YUZUNO_UI_DIST=/tmp/yuzuno-conversation-search-dist node tools/conversation-search-check.mjs
```

The browser check uses a temporary fixture server and a fresh headless Chromium, never Core or an existing browser window. It checks exact navigation across repeated message IDs, new execution events, Escape, agent switching, drafts and pending state, and light/dark themes at 20px across 1440, 940, and 390px widths. Its report and screenshots are in `../acceptance/conversation-search/`. Set `YUZUNO_BROWSER_BIN` to use a different Chromium executable.

For manual acceptance against the already-running Core, serve only the isolated bundle:

```sh
node_modules/.bin/vite preview --outDir /tmp/yuzuno-conversation-search-dist --host 127.0.0.1 --port 5174 --strictPort
```

Open `http://127.0.0.1:5174` in a separate test window. The existing Vite proxy reads the running Core on port 4317. Search a phrase from an earlier message and select its result while that agent continues working; verify the message stays visible until **Back to latest** is selected. Also try Chinese, mixed case, an absent phrase, switching agents, and Escape while working. Change appearance to light/dark and 20px in the test window. These commands neither replace `web/dist` nor restart Core; no daily window needs to be refreshed.

## Libraries and provenance

- React 19, TypeScript, Vite 8: interface and build pipeline.
- Radix Dialog: accessible modal focus management and dismissal.
- Lucide React: existing icon set.
- Marked 18 and DOMPurify 3: Markdown/GFM tables and code, with executable HTML, embedded frames, forms, and remote images removed. Files route through the agent-scoped artifact endpoint; HTML/SVG artifacts are shown as source text.
- Noto Sans SC subset from the earlier project’s font assets: the font’s SIL Open Font License is preserved beside it. No old workspace state model or components were copied.
- JSDOM: isolated interaction and sanitization checks. Playwright Core: actual Chromium layout and real Core interaction checks. Prettier: formatting.

Dependencies were installed from available npm cache tarballs in the restricted environment, then the canonical lockfile was generated by npm. A clean `npm ci --offline` was verified. The lock includes optional native dependencies for other supported platforms; macOS installation itself has not been exercised.

## Validation and limits

The production build and 18 JSDOM checks currently pass. They cover per-agent drafts, explicit read state, stale/submitted approvals, supported approval decisions, non-blocking questions, Escape versus dialog behavior, preview isolation, Markdown sanitization and file routing, API origin behavior, commentary outside collapsed tools, preservation of manually opened tool groups, persistent execution status at the conversation tail, and file-reference line navigation. These are component-level checks; they do not replace real harness or native acceptance.

The existing browser acceptance runners separately exercise Chromium layouts and real Core behavior. Native Tauri/WebView2 validation is separate.

`npm run test:browser` runs Chromium against the labelled design specimen and writes screenshots plus a JSON result under `acceptance/`. It uses an installed Chrome by default; set `YUZUNO_BROWSER_BIN` to an existing Chromium executable to use another installation. Screenshots disable finite entrance animations so inspection sees the settled interface.

`npm run test:browser -- --live` opens an existing Core without mutating its workspace. To exercise a real model, explicitly supply an isolated Core and working directory:

```sh
YUZUNO_CORE_URL=http://127.0.0.1:4317 \
YUZUNO_ACCEPTANCE_CWD=/absolute/path/to/an/acceptance-only-folder \
npm run test:browser -- --live --exercise
```

The exercise creates a named acceptance agent, requests a small file and an intentional tool failure, checks real reply/turn clipboard contents, opens the artifact, reloads the window, and interrupts a running wait command with Escape. It consumes actual Codex usage and leaves its agent/history and file available for inspection. It never injects events or automatically approves requests. If a real approval/question arrives, it records the request type and stops for review in the GUI. Approval/question handling, Core process restart, and a native WebView2 window have separate acceptance records; this general Chromium report does not claim those results. Add `--headed` to watch the browser.

Catch-up currently presents attributable workspace records. The interface explicitly labels model summarization as experimental and exposes no nonfunctional summary action. Reading Catch-up never clears unread or pending state. Approvals from an old connection and responses awaiting harness confirmation are read-only.

Keyboard shortcuts: Enter sends, Shift+Enter inserts a line break, Escape interrupts a running turn when no modal is open, Cmd/Ctrl+N creates an agent, and Cmd/Ctrl+K searches agents. Reading older turns does not follow new output; “Back to latest” resumes following.

Codex 0.162.1 can deliver a non-blocking question as an `agentMessage` item with `delivery: "async"` and structured `questions`, independently of the RPC request format. These items display a compact question card. Selecting or writing an answer and choosing “Add answer to draft” appends a reference to the original question without replacing an existing draft; the user then sends a normal message. This does not fabricate an approval/request, set Runtime to Waiting, steer a running turn, or infer a durable answered state. The existing real RPC controls remain separate.

The actual native asynchronous question round trip passed on 2026-10-12: the GUI displayed the real question, selected Sage, preserved a pre-existing draft, sent only after the ordinary Send action, and the model confirmed Sage. See `../acceptance/controls/async-question-report.json` and its two screenshots. This is a real model response, separate from the fixture-based component check.

## Workspace appearance

Open the palette icon in the top-right toolbar to change the theme or text size. The same settings are available in the browser and desktop window, including narrow layouts.

- **Light** keeps the Yuzu cream palette; **Dark** uses a warm charcoal and leaf palette; **System** follows the device’s appearance and updates when it changes.
- Conversation text defaults to **16 px**, with **14, 16, 18 and 20 px** choices. Supporting interface text, tool output and file previews adjust with it. This changes typography without zooming the page or enlarging the whole layout.
- Preferences apply immediately and are saved in this browser/desktop profile’s local storage (`yuzuno.appearance`). They restore before the workspace mounts. They are per device and origin, so another browser or Core address has its own preferences.
- Supported desktop builds also match the native caption to the selected light/dark palette. Older shells still apply the web theme.

`src/appearance.ts` owns preferences and system appearance updates. `src/AppearanceSettings.tsx` reuses the existing Radix dialog; `src/appearance.css` defines the settings UI and dark palette.

For the browser appearance checks, build the frontend, keep a Core serving `web/dist` running, then run from the repository root:

```sh
npm --prefix web run build
node web/tools/appearance-check.mjs
```

This uses the explicitly labelled read-only preview at `http://127.0.0.1:4317/?preview=1`, checks theme/font persistence and system changes, and captures 1440/940/390 px layouts. It does not create an Agent or send a task. Set `YUZUNO_CORE_URL` or `YUZUNO_BROWSER_BIN` when needed. Evidence is saved in `acceptance/appearance/`.

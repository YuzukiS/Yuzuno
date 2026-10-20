# T-8 Intelligent UI V1 acceptance

Branch: `feat/intelligent-ui-v1`. Base: `b1ede525505c3b240625b58514f4a35466408c98`.
Worktree: `/home/developer/yuzuno-next/.claude/worktrees/intelligent-ui`.

This slice changes only the frontend, its dependencies/tests and this acceptance tooling. Production assets are isolated in `target/intelligent-ui-dist`. The lab at **http://127.0.0.1:4387** uses its own binary copy, `acceptance/intelligent-ui/core-data`, fixtures and native test Agents. No daily Core, UI asset, existing Agent or user window was changed.

## What to try

Open the lab in a separate browser. Select **T-8 Native UI Acceptance** to see the actual Codex comparison or **T-8 Claude UI Acceptance** for the actual Claude metrics/chart result. Filter or sort the table, select an option/data row, and use its continuation button. The selected values append to that Agent's existing draft; nothing is sent until ordinary Send is used. Source links open the existing file preview at the cited line. Reload and switch Agents to check restoration and separation.

The composer has an **Interactive result** entry (icon on narrow screens). It prepares a comparison/report request in the existing draft. Expand its request template to inspect or copy the exact component format. Normal replies require no structured output or publishing tool. The diagram/table samples embedded in the request are explicitly illustrative.

## Results

- TypeScript and isolated Vite production build passed. No `npm run build` or daily `web/dist` writes.
- Existing frontend regressions: **101 passed** (46 conversation, 10 collaboration, 13 projects, 3 artifacts, 1 plan source, 6 Claude, 5 remote, 17 session import).
- New parser/schema checks: **13 passed**. Covers real format examples, incomplete/invalid/multiple/nested Markdown fences, repeated fence text in an earlier code example, forbidden renderer directives, prototype identities, graph/depth/size bounds, exact table shape and source validation.
- New storage checks: **7 passed**. Covers short fingerprints, count/byte eviction, legacy cleanup, quota exceptions, origin pressure, unavailable storage and preservation of draft/outbox keys.
- Final production Chromium fixture: **17 check groups passed**, no browser errors or API mutations. Includes filter/sort/empty states, keyboard selection and direct bar clicks without model SVG IDs, draft append, Escape versus Interrupt, existing file preview, per-Agent isolation, refresh restoration, continuing events/read position, unread/Pending, light/dark 20px, 390px width, reduced motion, closed-Agent controls, invalid JSON and failed lazy-asset fallback. Opening/cancelling the request dialog keeps live follow enabled.
- Actual Chromium storage pressure: seeded 140 large preference entries; startup retained the newest 12 at **130,536 bytes**, within 128 KiB. Adding 80 full-raw legacy entries reached an actual `QuotaExceededError`. Reload initially showed ordinary Markdown (no card), cleaned only result caches, and preserved the existing draft/outbox. Newly edited draft text, explicit continuation and selection survived subsequent reload. A separately injected smaller quota verified that failed preference writes leave controls usable, release only their own caches and preserve draft writes/refresh.
- Native Codex: one pure-output request, one completed Turn, valid result on its first output, no pending approval. Agent `1ae612be-9162-4cf3-b767-3a56bd970247`, Turn `01a133db-de56-7c30-87dd-3503e760873b`.
- Native Claude: one pure-output request, one completed Turn, valid metrics/chart/source result on its first output, no pending approval. Agent `4693c4b0-f7da-4c85-a68d-371fea05e503`, Turn `82a0b8db-f86b-45a0-ab1f-ae34928018d1`.
- Both native outputs were read from Core and passed the same parser used by the UI. Actual GUI selection, append without sending, exact file source lines and reload passed for both. The test then restarted **only owned port 4387**, reconnected both native sessions, and verified the original message IDs/specs, restored selection and draft in a fresh test browser.
- Daily listener identity and UI asset SHA-256 values remained unchanged (`daily-verification.json`).

Generated evidence stays local: `browser/report.json`, four fixture layout screenshots, `native-validation.json`, `claude-validation.json`, `native-browser.json`, `recovery-browser.json`, and `native-live.png` / `claude-live.png` / recovered screenshots. Native inputs, snapshots and browser storage are ignored by Git. Fixtures are separately identified; native screenshots do not contain injected fixture responses.

## Reproduce

From the worktree's `web` directory:

```sh
npm run typecheck
node_modules/.bin/vite build --outDir ../target/intelligent-ui-dist
YUZUNO_UI_DIST=../target/intelligent-ui-dist npm test
YUZUNO_UI_DIST=../target/intelligent-ui-dist node --experimental-strip-types tools/intelligent-ui-check.mjs
```

The old JSDOM harness evaluates classic scripts. `ui-test-bundle.mjs` flattens the actual production module graph with the same Rolldown version used by Vite; real lazy chunk loading is covered separately in Chromium. It does not rebuild or replace served files.

With the recorded owned native Agents available, run `node --experimental-strip-types tools/intelligent-ui-native-check.mjs`. After an explicit `lab.py stop`, `lab.py start` and reconnect of these two test Agents, `--recovered` reuses the saved test browser storage to verify recovery. `lab.py` checks PID/start time/cwd/port/data path before stopping; it refuses to stop active or uncertain work. It never signals 4317. The binary source is the existing integrated candidate; no Cargo build or Claude bridge/account edit was needed.

## Limits and review boundary

V1 supports one complete `yuzuno-ui` fence per native Agent message and a bounded static subset of json-render's catalog. Unsupported or unfinished content remains Markdown. This is not a general json-render/A2UI/MCP Apps host: no model HTML/JS, state expressions, watchers, automatic actions, arbitrary components or remote modules. Chart/table controls are local; only explicit clicks prepare drafts or open sources.

Results persist in original Harness/Core text. Selection/filter/sort preferences are per browser and scoped by Agent/Turn/message plus a short content fingerprint. The disposable cache holds at most 100 results / 128 KiB total / 16 KiB per result (UTF-16 key+value estimate), evicting the oldest changes first. Legacy full-text caches are removed at startup. A 3 MiB origin soft limit yields space to other application data; any cache write failure releases only `yuzuno.result-view.*` preferences. Draft/outbox keys are never modified by cache maintenance. Evicted, oversized or unavailable preferences remain usable in memory but cannot be restored; unrelated data can still exhaust the browser's shared quota. File citations view current file contents through the existing artifact bounds, not a historical file snapshot. Charts are bar charts with equivalent selectable data tables; selection/sorting do not claim to change evidence or execute work.

The main bundle is approximately 644 KB minified / 197 KB gzip; the result renderer, table and chart chunk is about 430 KB / 124 KB gzip and loads only for valid results. The existing Vite 500 KB warning is reported, not suppressed. This is browser/Chromium acceptance, not a native Tauri smoke test. No main merge or daily switch was performed. R1 identified the unbounded cache issue; this revision and its targeted validation are submitted for independent R2. Remaining non-blocking R1 observations (mixed-type table semantics, standalone preview inlining and unusual reference-link targets) are outside this repair.

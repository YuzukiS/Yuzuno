# Unified Slice acceptance

This lab owns **4367**, `acceptance/integrated/core-data`, the source snapshot's
`web/dist`, and `/tmp/yuzuno-next-integrated-target`. It never controls the daily
4317 Core or the other review labs on 4327, 4337, 4347, or 4357.

`lab.py` reuses the reading lab's process identity guards and read-only daily
verification. Its one-shot `prepare` takes a read-only SQLite backup of the
reading database, then imports accepted Codex history from a consistent in-memory
SQLite backup of the interaction lab. Journal sequence numbers and Agent read
cursors are translated on import to avoid collisions. Native sessions are not
resumed by this process. `fixture-manifest.json` distinguishes copied real history
from synthetic view cases.

```sh
python3 acceptance/integrated/lab.py prepare
python3 acceptance/integrated/lab.py start
python3 acceptance/integrated/lab.py add-source-fixtures
node acceptance/integrated/browser.mjs reading
node acceptance/integrated/browser.mjs visual
python3 acceptance/integrated/lab.py verify-daily
```

To repeat reading acceptance, stop only this owned Core, run `reset-read`, start
it, and run `add-source-fixtures` before the browser checks. The latter inserts
explicitly synthetic plan/scrolling snapshots after startup; it does not claim
native runtime activity.

Run the copied interaction fixture check from the root `web` directory:

```sh
YUZUNO_UI_DIST=/home/developer/yuzuno-next/acceptance/integrated/source/web/dist \
  node ../acceptance/integrated/interaction-check.mjs
YUZUNO_UI_DIST=/home/developer/yuzuno-next/acceptance/integrated/source/web/dist \
  YUZUNO_BROWSER_OUTPUT=/home/developer/yuzuno-next/acceptance/integrated/search \
  node tools/conversation-search-check.mjs
```

The interaction copy rejects `--real` and `--model-check`. It starts only an
ephemeral fixture HTTP server and never addresses the interaction lab's native
Core. Reading and visual modes allow only `/review` writes to the owned 4367 Core.

`node acceptance/integrated/live-browser.mjs` is a separately authorized bounded
native check: it creates a **new** Claude Agent without a purpose field, sends one
Haiku marker task with no tools, then checks the reply and automatic read state.
It does not resume imported history or change native authentication.

Limitations remain explicit in reports: headless Chromium uses DOM-emulated
background state; scrollbar intent may require a labeled event/geometry fallback.
These tests do not claim Windows native focus, WebView2, or DPI acceptance.

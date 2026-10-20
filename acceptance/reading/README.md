# Reading and Agent Rail acceptance

This lab owns only port **4357**, `acceptance/reading/core-data`, and the build
under `/tmp/yuzuno-next-reading-target`. It does not control the daily Core on
4317, the review labs on 4327/4337, or any Windows/native window.

The UI/Core source is a separate snapshot maintained by the implementation
agents. These acceptance scripts do not copy changes into the main project.

```sh
python3 acceptance/reading/lab.py prepare
python3 acceptance/reading/lab.py start
node acceptance/reading/browser.mjs reading
node acceptance/reading/browser.mjs visual
python3 acceptance/reading/lab.py verify-daily
```

`prepare` is one-shot. It uses SQLite's backup API with a **read-only** source
connection to retain a consistent copy of the accepted Claude transcript. It
then inserts clearly labeled synthetic browser fixtures. Nothing is executed or
resumed from that historical record. A separate fixture per case prevents one
case's read cursor from hiding errors in another.

To rerun reading checks, stop only the owned process and reset only synthetic
read cursors:

```sh
python3 acceptance/reading/lab.py stop
python3 acceptance/reading/lab.py reset-read
python3 acceptance/reading/lab.py start
python3 acceptance/reading/lab.py add-source-fixtures
node acceptance/reading/browser.mjs reading
```

`add-source-fixtures` inserts only synthetic plan/scrolling rows into the owned
lab database after startup. This is intentional: normal Core startup correctly
treats a historical in-progress turn as uncertain. The post-start fixture lets
the browser exercise a currently visible native-shaped plan without claiming a
live harness produced it. It does not modify the copied accepted Claude Agent or
the new bounded live Agent.

`browser.mjs live` is a separate, intentionally explicit command. It creates a
new Claude Agent in the GUI without a purpose, uses Haiku with the existing
native WSL login, asks for one marker response without tools, and verifies the
visible final response becomes read. Run it only after the implementation owner
confirms the isolated build is ready. It never writes credentials or switches
accounts.

The fixture browser modes permit GET/HEAD requests and `/review` writes only.
Unexpected creation, turn, approval, interrupt, or reconnect requests are blocked.
They are **UI/read-state acceptance, not evidence of new native execution**.

Visual checks cover 1440 px and 900 px, light/dark themes, and 20 px reading size.
They use isolated headless Chromium. Headless tabs always report visible/focused,
so the background case explicitly emulates document focus/visibility and records
that limitation. A real browser-scrollbar mouse drag is attempted first; when the
headless scrollbar does not reach the end, the script explicitly emulates its
pointer intent and scroll geometry, recording that fallback in the report.
These checks do not claim Windows WebView2 or DPI validation.

Generated JSON reports distinguish historical/synthetic checks from the bounded
live model check and preserve actual request watermarks. Screenshots are saved
next to the reports.

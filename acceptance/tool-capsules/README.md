# Tool activity capsules (T-9)

The capsule row in a Turn's Tool activity: one capsule per tool, carrying the
name the harness gave it, how many calls it holds and what those calls
reported. Calls that returned stay neutral — a capsule never reads as success,
because a call that returned is not work that succeeded.

What the check covers, on a synthetic Agent with no Core and nothing sent:

- one capsule per tool, fully rounded, with the name shown whole (a long MCP
  name is not cut down), its `×N` and, when there is something to say, the
  state in words;
- `failed` where a tool's own calls report a failure, with the number when it
  covers only some of them; `running` while the turn is followed; `not
  confirmed` once it is not;
- desktop (1280×900) and phone (390×844), light and dark, plus Simplified
  Chinese: the capsules' own words follow the interface language (T-189) and
  the tools' names never do;
- the row adds no control of its own, so the disclosure keeps the keyboard and
  shows its focus.

Run it from `web/`, against an isolated build (never `web/dist`):

```sh
node_modules/.bin/vite build --outDir /tmp/yuzuno-t9-capsules-dist --emptyOutDir
YUZUNO_UI_DIST=/tmp/yuzuno-t9-capsules-dist node tools/tool-capsule-check.mjs
```

It writes `report.json` and its screenshots here; both are generated, so
neither is kept in the repository. `YUZUNO_BROWSER_BIN` selects another
Chromium build (on a Mac, Google Chrome's own executable);
`YUZUNO_CHECK_OUTPUT` another directory.

The names in the capsules are `toolActivityCounts`'. This check says nothing
about how a Codex MCP call is named in its own expanded row, which is PR #394.

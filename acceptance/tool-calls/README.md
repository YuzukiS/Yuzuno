# Tool call capsules (T-9)

Each tool call in a Turn's Tool activity is one capsule on one line: its icon,
its name and its short result, cut short with an ellipsis rather than wrapped.
The heading keeps only an overview: how many steps, and how many failed, were
refused or are not confirmed.

The short result reads only the answer the row already holds. Yuzuno's
`task_comment`, `task_update`, `brief_get`, `brief_update`, `peer_read` and
`peer_send` say what their receipt says; every other tool says only its
state. A call that returned is not work that succeeded, a task's status is the
task record and not a release, and a mail's delivery is as it stood when it
was sent. A cut or unreadable answer says it is to expand; nothing is fetched
for it.

What the check covers, on a synthetic Codex Agent with no Core and nothing
sent:

- returned, refused, failed, queued, to-expand, running and not-confirmed
  calls, each on one line inside its row with its end in view, and nothing
  scrolling sideways;
- a resting mouse and keyboard focus show a few more facts in the window,
  which Escape and leaving hide, with the focus kept; Enter and a click open
  the row, which leads with the same facts above the raw input and result;
- on a 393 px touch phone a tap opens the row and shows no tip;
- desktop (1440×900) light and dark, and Simplified Chinese: the capsules' own
  words follow the interface language (T-189); tools' names, IDs and Core's
  codes never do;
- no item is read in full to say a result.

Run it from `web/`, against an isolated build (never `web/dist`):

```sh
node_modules/.bin/vite build --outDir /tmp/yuzuno-t9-calls-dist --emptyOutDir
YUZUNO_UI_DIST=/tmp/yuzuno-t9-calls-dist node tools/tool-call-check.mjs
```

It writes `report.json` and its screenshots here; both are generated, so
neither is kept in the repository. `YUZUNO_BROWSER_BIN` selects another
Chromium build (on a Mac, Google Chrome's own executable);
`YUZUNO_CHECK_OUTPUT` another directory.

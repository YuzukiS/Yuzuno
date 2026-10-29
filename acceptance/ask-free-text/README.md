# Free text on every Ask (T-9)

An open Ask always takes a reply in the user's own words. Options, a choice or
a form are extra ways to answer, never a reason for the writing field to
disappear, and `freeText.prompt` only names that field. Core has always taken
text for any ask, with or without a choice
(`core/src/project_brief/home.rs`); this is the Home side of it.

What the check covers, on a synthetic Workspace with no Core and no Agent:

- an ask declaring options, a choice, a form, a custom prompt, free text, or
  nothing at all — each one takes written words;
- what the Agent declared stays, with its own way to send: the options, the
  two choices, the form and its own Submit;
- an empty or blank field cannot be sent, and drawing the cards sends nothing;
- answering a choice-only ask in words sends one reply with the text and no
  choice id, and the card then waits for its owner;
- desktop (1280×1000) and phone (393×852), light and dark, with nothing
  running off the width.

Run it from `web/`, against an isolated build (never `web/dist`):

```sh
node_modules/.bin/vite build --outDir /tmp/yuzuno-t9-ask-dist --emptyOutDir
YUZUNO_UI_DIST=/tmp/yuzuno-t9-ask-dist node tools/ask-free-text-check.mjs
```

It writes `report.json` and its screenshots here; both are generated, so
neither is kept in the repository. `YUZUNO_BROWSER_BIN` selects another
Chromium build (on a Mac, Google Chrome's own executable);
`YUZUNO_CHECK_OUTPUT` another directory.

The same behaviour is guarded in CI by `web/tools/ask-free-text-ui.test.mjs`,
which renders the real `AskReply` in JSDOM.

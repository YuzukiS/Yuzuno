# T-45 check: a follow-up to a turn Claude runs on its own

`browser.mjs` starts an isolated lab Core on port 4545 (never 4317). The
Core uses a scripted Claude bridge, `fake_claude.py`: no model, no Claude
CLI, no login. The lab's data, task folder and home live in the `--run`
folder. The Core gets only the environment the script sets, so nothing of
the shell's own Core reaches it.

```
node acceptance/t45-native-followup/browser.mjs --core <yuzuno-workspace build> --web <isolated web build> \
  --run /var/tmp/<short> --out <report folder>
```

It checks one desktop window, 1440×900, in Chromium:

1. Claude runs a turn of its own, as after a background task's notice. No
   prompt of yours is in progress.
2. The composer says "Add a thought while your agent works…" and offers
   **Send while working**.
3. A message sent then goes to that turn (`expectedTurnId` is the native
   turn). The bridge receives one `append` to it and no prompt. The message
   shows in that turn as yours, marked not read yet.
4. Claude names the message in that same turn. The mark goes away, and its
   answer follows in that turn. Core keeps one turn, with the message once,
   and its receipt is accepted there.

It writes `report.json`, `core.log` and three screenshots to `--out`.

The scripted bridge shows the protocol only. Whether Claude Code folds a
queued message into a turn of its own the way it does into one it runs for a
prompt is not shown here; that needs a real model turn.

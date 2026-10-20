# Reconnect and check an unconfirmed offline Agent (T-15)

After Core restarts, an Agent whose last Turn was still running comes back offline, with that Turn still `inProgress` in its record and the error "Workspace 服务已重启；上次执行是否完成尚未确认". For Codex, the composer treated that Turn as running and tried to add to it. Core refuses that ("连接或执行结果尚未确认，请先重连核对"), yet no button offered the reconnect. Input stayed stuck until something outside the GUI reconnected the Agent.

## Behavior

- A notice under the conversation explains that the last result isn't confirmed. Its **Reconnect and check** button calls the existing `POST /api/agents/{id}/reconnect`.
  - Codex: resumes the same thread and reconciles the Turn with native history.
  - Claude: resumes the same session; the stale Turn is shown as unconfirmed.
  - Nothing is sent again. The draft, message receipts, approvals and the session reference stay as they were.
- It shows only for an open, local Agent that is not connected, has a session to resume, and has a Turn still `inProgress` or the status `uncertain`.
- It does not show:
  - when the Agent is closed, connected, or has no session;
  - for remote Agents, whose header already offers Reconnect;
  - when the writer-conflict or unconfirmed-delivery notice already offers its own reconnect.
- One request at a time:
  - while it runs, the button says "Reconnecting…" and is disabled, also while Core reports `connecting`;
  - a failure shows Core's reason ("Couldn't reconnect: …") and **Try again**.
- Whether input unlocks is decided by the refreshed detail, not by the click: Core's check sets the real state.
- **Codex:** while the stale Turn is shown, sending is held, since Core would refuse it. The send button is disabled, Enter does nothing, and the footer says "Reconnect above to check the last turn; your draft is kept".
- **Claude:** sending keeps working as before; sending also resumes the session. The notice offers the check without sending.

Code: `web/src/RecoveryNotice.tsx` (`recoveryReason` and the notice), `web/src/recovery.css`, and a small hunk in `web/src/App.tsx`. Core and the API are unchanged.

## Verified

- **UI tests:** `web/tools/recovery-ui.test.mjs`, 4 tests:
  - when the notice is offered and when not, covering Codex and Claude, connected, closed, no session, remote, writer conflict and unconfirmed delivery;
  - a double click sends one request, with busy feedback, and Core decides the result;
  - a failure shows its reason and can be retried;
  - the button waits while Core is connecting and is inert when disabled.
- **The CI web job locally:** typecheck, build and all 22 `web/tools/*.test.mjs` files pass.
- **Chromium against a real Core** (`lab.py` + `browser.mjs`), 8/8.
  - Setup:
    - an isolated Core on port 4415 with data under `target/t15/lab`, using a copy of the `main` `fe51b05` release binary, this branch's `web/dist`, and scripted runtimes;
    - a Codex and a Claude Agent each started a Turn that was still running when Core stopped;
    - Core restarted on the same data, leaving both offline with their last Turn `inProgress`. The Codex runtime had meanwhile finished natively.
  - Codex, light theme:
    - the notice shows, send is held, and Enter sends nothing;
    - a forced resume failure, triggered from the keyboard, shows the reason and Try again;
    - a double-clicked retry sent one request. The same thread then reported its real result ("Finished while Core was away."), the Agent became Ready, the draft was intact and sending was open again.
  - Claude, dark theme at 20 px: the notice fits without overflow. A double click sent one reconnect; the same session resumed and the draft was intact.
  - Writes: only the three reconnects. The runtimes received the original Turn once each: Codex one `turn/start` and no steer; Claude one `send`, and its second `start` reused the original session ID.

The daily Core, its data and `web/dist` were not touched. Screenshots and the report stay in the git-ignored `target/t15/lab`.

## Reproduction

```sh
(cd web && npm run build)
python3 acceptance/recovery/lab.py start      # leaves the isolated Core on 4415 running
node acceptance/recovery/browser.mjs
python3 acceptance/recovery/lab.py calls      # what the runtimes received
python3 acceptance/recovery/lab.py stop
```

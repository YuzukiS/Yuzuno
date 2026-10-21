# T-170: a phone on the lab Core, through Tailscale Serve

Checks [the phone entry](../../docs/independent-core.md#connect-from-a-phone-tailscale-serve) with a real phone. **It runs only after the user approves it, once.** The names below are examples; the real node name, login and port are in the task, not here.

It never touches the daily Core: [`lab.py`](lab.py) starts a lab Core of its own (its own two ports, never 4317, and a new data folder) with a scripted Codex stand-in instead of a model, and seeds a synthetic Workspace. On Tailscale it adds **one** Serve entry, on a port no existing entry uses, and removes only that entry at the end.

## What it covers, and what it does not

- **Covered:**
  - Home with a status section and an Ask, and a reply to it;
  - a conversation;
  - sending a message and its receipt;
  - a native command approval and its answer;
  - live updates;
  - the phone keyboard;
  - leaving the page or the network and coming back.
- **Not covered:**
  - **Native questions typed into a field** (`requestUserInput`): the stand-in raises approvals only.
  - **A real Codex or Claude session:** the conversation and the approval come from `acceptance/turn-cost/fake_codex.py`.
  - **The daily Workspace.**

## Before (read-only)

1. **The artifacts:** the lab Core, the web build and `runtimes/result-validator/` from the reviewed main commit, copied into one folder with a `manifest.json` that gives the commit and their digests. Check the digests before starting. The lab starts Core without the caller's `YUZUNO_*` settings, so a shell under the daily Core lends it nothing; Home sections are checked by the copied validator.
2. **Ports:** the lab's two loopback ports (e.g. 4419 and 4318) are free, and neither is 4317. `lab.py` checks this, and that the lab folder is new, before it writes anything.
3. **Serve:** on the machine running Tailscale, save `tailscale serve status --json`. If the chosen HTTPS port (e.g. 8444) is already in it, **stop**: nothing is overwritten, and no other port is picked without asking again.

## Run

1. **Start the lab and keep it up** for at most the agreed time:
   ```sh
   python3 acceptance/t170/lab.py --core <artifacts>/bin/yuzuno-workspace --web <artifacts>/web \
     --validator <artifacts>/runtimes/result-validator/validator.mjs --dir <new lab folder> \
     --port 4419 --remote-port 4318 --origin https://core.example-tailnet.ts.net:8444 --login person@example.com \
     --source-commit <commit> --hold 90
   ```
2. **Add the one Serve entry:** `tailscale serve --bg --https=8444 http://127.0.0.1:4318`. Then check that `tailscale serve status --json` shows it, and every saved entry unchanged.
3. **On the phone,** signed in to the same tailnet as the allowed login, open `https://core.example-tailnet.ts.net:8444`:
   - Home: the status section, then reply to the Ask;
   - the "Phone check" conversation: read it, send a message and see its receipt;
   - answer the waiting approval (`touch <lab>/again` raises another; the stand-in waits 600 s for each);
   - type with the phone keyboard: Return makes a new line, and the field stays visible;
   - switch apps or lock the phone for a minute, come back, and see live updates resume;
   - turn the network off, type, and send: the draft stays, the message is marked unconfirmed, and nothing is sent twice. Turn the network on.
4. If the page does not load (for example 502 from Serve: it could not reach the lab port), **stop** and report what the phone and `core.log` show.

## Stop and undo

1. `tailscale serve --https=8444 off`: removes only this entry. **Never** `tailscale serve reset`.
2. Check that `tailscale serve status --json` equals the saved one.
3. `touch <lab>/stop`. The lab Core stops; `report.json`, `core.log` and the lab's data stay in the lab folder as evidence.

A failed step is reported as it happened, with those files. Nothing is rerun to get a pass.

**What stays:** the lab folder (synthetic data only) until it is removed. Serve may obtain or renew a certificate for the node's name. Certificate Transparency logs record such certificates publicly, and that cannot be undone.

## Checked without a phone

`lab.py --verify` plays Serve's part on the remote port, with the headers Serve sends according to its source. It checks:
- the page, the API, Home and its Ask, live events, answering the approval, a message and its receipt, and a reply to the Ask, all through the remote entry;
- the refusals: no login, another login, another host, Funnel, and a change without the page's Origin;
- the local port refusing a proxied request.

It does not go through Serve, Tailscale or a phone.

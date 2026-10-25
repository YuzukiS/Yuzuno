# Phone access from Settings: checks (T-185)

`fake_tailscale.py` and `fake_curl.py` stand in for Windows' `tailscale.exe` and
`curl.exe`. They keep a Serve configuration in a JSON file and play Serve's part
for a request through it. The Rust tests in `core/src/remote_access/tests.rs`
include them, and `smoke.py` runs the real Core binary against copies of them:

```sh
python3 acceptance/t185-remote-access/smoke.py --core target/debug/yuzuno-workspace --out /tmp/t185-smoke-1
```

The smoke uses a fresh data folder and free loopback ports. It never uses port
4317, a daily Core, a real Tailscale or Serve. It needs a WSL host, as the
feature does. Run it as a bounded Job; it writes `report.json` in `--out`.

For a browser check of the page, `lab.py start --core … --out … [--web-dir web/dist] [--environment]`
leaves such a Core running and writes `lab.json` (its page, the local port to
apply, the stand-ins' state file, its pid and start time); `lab.py stop --out …`
stops only that Core. `--environment` starts it with `YUZUNO_REMOTE_*` and a
matching Serve entry, as a phone entry set up before Settings.

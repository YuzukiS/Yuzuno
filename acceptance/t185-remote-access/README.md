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

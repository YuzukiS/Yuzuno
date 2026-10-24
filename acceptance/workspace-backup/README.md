# Workspace backup (T-192)

`smoke.py` backs up, checks and restores a synthetic Workspace with the real Core
binary, then starts a Core on the restored copy and reads its Agents back.

```sh
cargo build -p yuzuno-workspace --bin yuzuno-workspace
T192_FIXTURE=/tmp/t192-fixture cargo test -p yuzuno-workspace --lib -- --ignored --exact workspace_backup::tests::write_fixture_workspace
python3 acceptance/workspace-backup/smoke.py --core target/debug/yuzuno-workspace \
    --fixture /tmp/t192-fixture/source --out /tmp/t192-smoke
```

Core runs with a private `HOME`, a clean environment, `--codex /bin/false` and
free loopback ports, never 4317. No real account, model or Workspace is used.
The run writes `report.json` and exits 0 only when every step passed.

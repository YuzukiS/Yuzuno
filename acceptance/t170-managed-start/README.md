# T-170: the phone's remote entry through an installed Core's start entry

[`smoke.py`](smoke.py) checks `updates/start start --remote-…`, `--no-remote` and `updates/start stop` (see [Connect from a phone](../../docs/independent-core.md#connect-from-a-phone-tailscale-serve)) with the real Core and update helper of a build, in an installation of its own:

```sh
cargo build --locked -p yuzuno-workspace --bins --target-dir <target>
python3 acceptance/t170-managed-start/smoke.py --run r1 --target <target>/debug
```

It packages those two binaries as a fixture release with `tools/package-release.py`, as [`desktop/tests/start-lab.py`](../../desktop/tests/start-lab.py) does, and registers it into a new folder under `/var/tmp`. Its Core runs on loopback ports of its own (4591, with the remote entry on 4594; never 4317), with its own Workspace and a fake Codex. It checks, in order:

1. Core started once with the documented command records how it started.
2. `stop` stops it.
3. `start --remote-…`: the remote entry answers for the login and refuses without it or with another one; Core's own port refuses Serve's header; the record holds the three settings.
4. While Core runs, a start with other settings or with `--no-remote` is refused, and neither the record nor Core changes.
5. `stop` stops that Core only: the start that stays, and another program on a port of its own, go on.
6. `start --no-remote`: the remote port is closed, and the record has none of the settings.
7. A remote port another program holds: Core exits before it records, so the record stays as it was.

**Not covered:** Tailscale Serve and a phone (requests carry the headers Serve sends); the Windows desktop app, which passes none of these options; a Core update between releases; and stop's second check that Core holds its port, right before the interrupt.

The lab folder and its `report.json` stay as evidence; every lab Core and start is stopped at the end. The daily Core is never read or changed.

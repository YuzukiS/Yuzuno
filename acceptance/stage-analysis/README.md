# Stage analysis gates

The ordinary Core suite covers durable gate state, final-stage completion,
independent branches, actor ownership, stale identities, replay/conflict,
concurrent cancellation, reuse and update drain. `job-runs-ui.test.mjs` covers
finished Job controls and the pending-run entry, including all-reused runs.

The ignored `jobs::run_tests::analysis_integration` test must run in a managed
Job with `T125_ACCEPTANCE_REPORT` set to an absolute output path. It reads the
outer Job's enforced CPU, memory, swap and PID limits and requires its Job ID.
It calls production Core run tools and executes the real host worker as a
child in that same cgroup. The worker verifies those limits itself, checks
frozen Git/inputs/upstream artifacts, and writes real logs and artifacts.

The harness drives each reservation and records the worker's actual exit and
artifact report. It never starts nested systemd services or another resource
manager. It uses no sleep/poll/watch loop, GPU, model or external API. The
unchanged per-stage systemd launcher, collector and their process-group cleanup
are **not** exercised by this test; they must not be claimed as its evidence.

Build the test binary first in a separate managed build Job with enough RAM for
compilation. Then run this acceptance with the same Cargo target/profile cache,
the project's heavy-slot wrapper, **600 millicores, 1024 MiB RAM and zero swap**.
The fixture uses the outer Job's exact limits. Its production admission check
also includes 100 millicores of collector overhead and derives a maximum from
the CPU count visible inside that cgroup; 600 + 100 fits the one-CPU maximum of
750. A two-CPU outer quota would make this fixture's 2100 millicore budget exceed
the corresponding 1500 millicore maximum. Do not disable that check.

Include the same user's `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` in the
Job's explicit environment so the production capability probe can read the
systemd user manager. For UID 1000 these are `/run/user/1000` and
`unix:path=/run/user/1000/bus`; use the actual user's values on another host.
This probe starts no units. Also set the absolute `T125_ACCEPTANCE_REPORT` path
as described above. Run (the ignored test is absent from routine CI execution):

```sh
cargo test --locked --offline -p yuzuno-workspace --lib \
  jobs::run_tests::analysis_integration -- --ignored --nocapture
```

Declare the report as a JSON artifact of the outer Job. It retains fixture run,
attempt, artifact, log, resource and rejection evidence; its lab uses a separate
database and working directory. No daily Core data or processes are changed.

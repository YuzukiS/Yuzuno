# The remote program behind Home's machine card

Home's machine card shows a row for each registered SSH machine: whether its
remote session is online, and its CPU, memory, data folder space and platform.
The card reads `GET /api/machine-live`; that read is also what asks Core to
open a session on each machine. Nothing else on Home connects to them.

This is S1 of the remote-machines design: a read-only status row. It is not
how Jobs, Claude, Codex or MCP reach a machine, and it starts no work there.

## When it connects

- The machine card is expanded and the page is visible. Collapsing it, hiding
  the tab, or leaving Home stops the read at once: the page aborts its request
  and sends nothing more.
- Core counts the last read as interest and closes the session 60 seconds
  after it. The page does not send a separate stop.
- Each read is one request at a time: the next starts about 2 seconds after the
  previous answer ends. Core starts a session on a machine the first time it is
  asked about it and it may start one.

There is no port, no daemon and no service left behind. The session is a child
of Core's SSH process: OpenSSH in batch mode with the machine's own
configuration and keys, with all forwarding disabled. Its only channel is
stdin/stdout, one JSON object per line. Nothing listens on the machine, and
nothing survives the connection except the program file below.

## The program file

- The first time a Core version connects to a machine, it uploads the program
  to `<data root>/remote/bin/<digest>.py`, where `<data root>` is the machine's
  data root (`~/.yuzuno` unless the machine entry names another).
- `<digest>` is the SHA-256 of the file exactly as installed. The file is the
  fixed header `# yuzuno-remote protocol 1` plus the session source; on this
  Core it is 31,065 bytes (measured from the current source, not an estimate).
- The `remote/bin` directory is created `0700`, the file is written `0600`, and
  it is replaced atomically.
- Every connection hashes the file that is already there and reuses it only if
  it matches. A wrong or partial file is replaced. An old Core version's file
  stays where it is; nothing deletes it by itself.
- To remove a program file, delete that exact `<digest>.py` under the
  machine's data root. Removing files is a manual step: Core does not clean up
  old digests, and the automatic cleanup that was cancelled (#880) is not
  restored. Removing the file only means the next connection uploads it again.

The program runs as the machine's account, and writes nothing but that file.
It reports only public facts: the platform, its Python version, a hash of the
machine id, a hash of the account and data root, and the readings shown on the
card. It never reports the hostname, user, paths or credentials, and the GPU is
not read: the card says "not enabled".

## When a session ends

A session ends cleanly when the program says goodbye after its own cleanup,
standard output is read to its end, and OpenSSH exits with status 0. Only that
counts as clean. Core then waits for the next interest; the card stays online
as long as complete answers arrive, and shows offline when none has for 30
seconds.

A session that ends any other way is not restarted automatically:

- Only OpenSSH reporting that it could not connect or resolve the host
  (connection refused, timed out, no route, network unreachable, host down, or
  a DNS failure) is retried. The wait starts at 1 second, doubles, and stops at
  60 seconds. The card shows the actual retry time only when Core has one.
- Authentication failure, a changed host key, an unrecognised SSH failure, a
  missing or too-old `python3`, an unsupported platform, an unsafe data root,
  a failed upload or start, or a protocol or version mismatch all stop that
  machine. So does a connection that drops without a proven clean exit, for
  example a sleeping laptop or a network change: Core cannot confirm the
  remote program has exited, and starting another could run two.
- A machine still connecting that is closed (the card folded, the page
  hidden, or Core stopping) has not proven a clean exit either, so it stops
  rather than being restarted.

To start that machine again, open its page in Settings → Machines and make a
check succeed, or change its target or data root, or restart Core. A later
`/api/machine-live` read alone does not clear a stopped session.

A change to a machine's `contained` or Codex setting does not restart its
session. Another machine with the same account and data root is marked as the
same machine on the card, but it never shares a session, and changing one does
not restart the other.

## Limits

- A data root on a file system that does not answer can leave the remote
  program stuck in the kernel until that read returns. The card shows what it
  has; the session cannot be interrupted from Core. After a manual check and a
  new connection, the earlier blocked process is neither cleaned up nor
  tracked, and no bound is promised on how many may remain.
- The macOS memory figure is an estimate (free, speculative and inactive
  pages), and differs from Linux's `MemAvailable`. The card marks it
  "estimated".
- This was tested on Linux and against a local OpenSSH server; it has not been
  run on a real macOS or Windows machine. The S1 Core side was tested on Linux.

## What it does not change

Jobs and Agents on a remote machine still use their own connection path: the
fixed helper, its own SSH command, and its own checks. Whether either can run
on a machine is decided by that path's check, not by this card. A remote
session that cannot start affects only its row on Home.

The design and its known limits are kept with the Task that implements it
(YN-83, S1).

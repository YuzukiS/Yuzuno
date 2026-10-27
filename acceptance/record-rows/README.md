# Agent records as rows (stage 4b)

Each Agent record (`AgentDetail`) is one JSON row in `agents`, 5–9 MB for long-lived Agents. Every full write serializes and rewrites all of it (~0.2 s for the largest daily record in the debug build Core runs as), and every load and payload request parses all of it. Most of it is tool payloads, not conversation.

`core/src/record_rows.rs` stores a record as rows instead, so a write touches only what changed and a load can leave payloads out. `Store::open` converts records stored whole (with a backup first), and `store.rs` reads and writes rows:

- **Writes** go by dirty set (below), planned and serialized before the writer is taken; the writer only runs the statements, with the `agent` header (journal position, unread count) spliced in.
- **Committed records stay held** in memory (bounded by `MAX_STREAMS`, dropped after `STREAM_IDLE`), so the several updates of a Turn start do not reload the record. A read mark on a held record is journaled on the unsynced connection, as for streaming records: a power loss (not a Core crash) can lose it, and the conversation then shows as unread again, which is harmless.
- **The detail API** (`Store::client_detail`) sends the held copy through `client_view`, else reads the rows without payloads, which already are the client view; Items a pending request refers to are read whole.
- **Payload endpoints** (`Store::payload_view`) answer from the held copy, else read the metadata and only the named Turn or Item rows.
- **Listed views** are built from the metadata, the Turn rows' own fields and the newest Turn's Items (`load_recent`): cheap, also through the writer's transaction.
- `Store::detail` stays the whole record, as its callers expect.

## Layout

| Table | Key | Holds |
|---|---|---|
| `agents.data`, `layout` = 1 | `id` | The record without `turns` (metadata, ≤ 42 KB in daily records). `layout` 0 is the old form. |
| `agent_turns` | `(agent_id, turn_id)`, `ord` | Each Turn with its Item count in place of its Items. |
| `agent_items` | `(agent_id, turn_id, item_id)`, `ord` | Each Item with `null` in place of each large field, noted under `_yuzunoTruncated`; `previews` holds the client view's preview of each. |
| `agent_payloads` | `(agent_id, turn_id, item_id, field)` | The full value of each large field. |

- A record assembles with payloads (exactly the record) or without them (previews instead: what the client view sends). A full load reads no previews; one without payloads never reads `agent_payloads`.
- Item IDs repeat across Turns, so everything is keyed by Turn. A Turn or Item without a usable ID (missing, repeated, or starting with `~`) is keyed by position (`~3`). Daily records have none.
- The metadata row has no `turns` member, so an older Core refuses to open a converted Workspace ("Workspace 记录无法读取", missing field `turns`) rather than show empty conversations.
- `agent_originals` keeps each Agent's whole row from before its conversion for 30 days (`ORIGINALS_KEPT`; +28.5 MiB on the daily database), for recovery (below).
- `serde_json` gets `float_roundtrip`. Without it, 13% of sampled doubles came back changed from their own JSON (e.g. a `usedPercent` of 39.430133835633676), which already made whole-record writes drift.
- `preserve_order` is off (members are sorted maps). The rows keep each member where it was anyway, so the round trip stays exact if it is ever enabled.

### Which fields are payloads

A top-level Item field is a payload exactly when `client_view::trim` trims it: over **8 KiB** (`client_view::TRIM_ABOVE`; compact JSON size, a string's UTF-8 length) and its 4 KiB preview leaves out at least half of it, in an Item `client_view::whole` does not keep whole (conversation text, a `fileChange` in progress). The stored previews are `client_view`'s, so a record loaded without payloads is the client's view: fields up to 8 KiB are sent whole, and a lower threshold would make every detail request read them back.

Distribution of Item field sizes in the five daily records (29.8 MB of records; conversation Item types excluded):

| Fields over | Fields | Their bytes | Share of record bytes |
|---|---|---|---|
| 1 KiB | 2731 | 24.6 MB | 82.6% |
| 2 KiB | 1990 | 23.6 MB | 79.0% |
| 4 KiB | 1337 | 21.7 MB | 72.6% |
| **8 KiB** | **731** | **18.0 MB** | **60.5%** |
| 16 KiB | 229 | 12.2 MB | 41.0% |
| 32 KiB | 64 | 8.6 MB | 28.8% |

Over 8 KiB: `claudeToolUse.output` 126 fields (7.2 MB), `commandExecution.aggregatedOutput` 311 (5.1 MB), `mcpToolCall.result` 220 (4.9 MB), `fileChange.changes` 42 (0.5 MB), `claudeToolUse.input` 25 (0.3 MB). After the half rule, 722 payload rows hold 17.4 MiB.

## Writes by dirty set

`write(tx, id, &detail, &Dirty)` writes the metadata and what `Dirty` names (Turns, Items, every Turn row, or everything). Rows are upserted only if they differ, so unchanged rows cost no disk writes. Every write also compares the Turns with the Turn rows (IDs, order, Item counts), and the Items of each Turn it writes with their rows. Added, removed and moved Turns and Items are therefore found without being named; only changes made in place must be named.

How the dirty set is derived:

- `Dirty::of_event(kind, data)`, for streamed events (`record_stream`) and journal replay (`restore`), uses only the event.
  - Codex `item/*` (deltas included): that Item and its Turn row.
  - `turn/started` and `turn/completed`: the Turn and the Items they carry.
  - `turn/plan/updated`: the Turn. `thread/compacted`: its Turn, or every Turn row.
  - Kinds `apply_at` ignores or that only touch metadata: nothing more (hooks, rate limits, usage, diffs, automatic reviews, status, errors, request resolution).
  - Claude `stream_event`, `assistant`, `user` and `result`: their whole Turn. `project_event_at` finds Items through Turn scratch.
  - Claude `compact_boundary`: every Turn row. Other Claude events: metadata only.
  - Unknown kinds: their whole Turn if they name one.
- `Dirty::between(before, after)`, for `Store::update` closures (opaque code), compares the two records. Unchanged Turns and Items compare equal without being serialized.
- `Dirty::all()`: snapshots, reconciliation and imports, if preferred over comparing.

Checked against the real event mix: the newest 6000 events of every daily Agent (24,012 events of 46 kinds), replayed with `of_event_names_what_real_events_change`; what `of_event` named always covered what actually changed.

## Damaged records

Rows that do not fit together (missing, extra, out of order or unreadable) make that Agent's record `Damaged`; strict assembly never returns a record silently missing part of its history. Only that Agent is affected, and it is not left without a way out:

- Core starts and every other Agent works.
- Readers are shown a stand-in, read only: the whole row from before the conversion (`agent_originals`, while kept) with what the journal replays since, else the metadata without Turns, else an Agent with only its ID. Its `status` is `error` and its `error` says what happened, what is shown, and how to recover: `--revert-record-rows`, or the backup file.
- Changes to it (updates, streamed events) are refused with that message, and the Agent is listed as its stand-in.

## Converting existing records

`record_rows::convert(db, path)` converts every record still stored whole:

- **Backup first.** Before the first conversion it copies the database next to itself with `VACUUM INTO` (consistent with the WAL): `workspace.before-record-rows-<UTC>.sqlite`. Its path is recorded as pending before the copy starts and as done (`recordRowsBackup`) after, so a resumed conversion does not copy again. A copy that fails is removed at once; one a crash left pending may be incomplete and is removed before copying again; nothing is converted without a backup. Backup paths are never forgotten: after a revert the next conversion takes a new one and lists the earlier ones (`recordRowsEarlierBackups`).
- **One transaction per Agent, checked.** The rows must assemble to exactly the record the whole row gave, compared as serialized JSON. Only then is the whole row replaced by the metadata, in the same transaction. A record that fails is left whole and does not hold back the others. Whole records keep working: `load` and `write` handle both layouts.
- **Resumable and idempotent.** A crash before a commit leaves that Agent whole with no rows. Rerunning converts only what is left. With nothing left, a run writes nothing.

Measured on a copy of the daily database (5 Agents, 28.5 MiB of records in a 276 MiB file that is mostly journal), debug build:

| | |
|---|---|
| Backup (`VACUUM INTO`, 276 MiB) | 0.5–0.8 s (three runs) |
| Conversion, checked | 2.34 s (0.08–0.78 s per Agent; ~82 ms per MiB) |
| File after (incl. WAL checkpoint) | 289.9 MiB (+13.8 MiB; 1863 free pages from the old rows) |
| Compacted after | 282.5 MiB (+6.4 MiB, +2.3%) |
| Pages by table | `agents` 28.5 → 0.1 MiB; `agent_turns` 0.3, `agent_items` 15.5, `agent_payloads` 18.0, indexes 1.1 MiB |

Item rows hold 10.8 MiB of data in 15.5 MiB of 4 KiB pages: 880 rows over 4 KiB spill to overflow pages, which wastes part of a page each. The stored previews add 1.7 MiB (719 Items).

### Rolling back

An older Core cannot read converted records. There are two ways back:

1. **Restore the backup.** This loses everything recorded since the conversion, journal included.
   1. Stop Core and make sure it has exited.
   2. Move `workspace.sqlite`, `workspace.sqlite-wal` and `workspace.sqlite-shm` aside.
   3. Copy `workspace.before-record-rows-<UTC>.sqlite` to `workspace.sqlite`.
   4. Start the older Core.

   The backup already has the new, empty tables and the `layout` column, which older builds ignore.
2. **Revert in place.** This keeps everything. With Core stopped, run `yuzuno-workspace --revert-record-rows [--data-dir DIR]`: it takes the Workspace lock and stores every record whole again, one transaction per Agent. Then start the older Core; starting this Core again converts the records again, with a new backup.
   - A damaged record keeps every Turn and Item whose row can be read, with payloads where they can be read (else the preview), and marked placeholders (`_yuzunoSalvage`) for what is missing, in order. Its metadata comes from its original only if its own cannot be read. Every row it had (and its original) is copied to `agent_salvage` first. The command reports per Agent what was given back and what was lost.
   - A damaged record whose metadata cannot be read and that has no original is left as it is, and the command says an older Core cannot open the Workspace yet.

## Microbench: the largest daily record

Measured in Phase A, before the stored previews became `client_view`'s and before the DB-access layer; not re-run since.

Agent `472db31d`: 9.1 MiB, 38 Turns, 2676 Items. Its last Turn is 0.2 MiB with 22 Items; its largest Turn is 1.2 MiB with 310 Items. Debug build; median of 9 runs (fastest in brackets). Commits are synced, as on Core's main connection.

| Operation | ms |
|---|---|
| Whole: load (SELECT + parse) | 68.8 (67.5) |
| Whole: serialize only | 160.1 (157.9) |
| Whole: write (serialize + UPDATE + commit) | 209.6 (194.7) |
| Rows: dirty write, last Turn's row + one Item + metadata | **3.0** (2.9) |
| Rows: dirty write, whole last Turn + metadata | 6.4 (6.1) |
| Rows: dirty write, whole largest Turn + metadata | 31.4 (31.1) |
| Rows: write everything, nothing changed (`Dirty::all`) | 233.4 (229.9) |
| Rows: load with payloads (= the record) | 78.2 (77.1), of which SQL ~7.3 |
| Rows: load without payloads (client view, 5.1 of 9.1 MiB) | 54.3 (53.4), of which SQL 5.2 |
| Rows: metadata + last Turn with payloads | **2.1** (2.0) |
| Rows: payloads of one Item (largest, 0.1 MiB) | 0.40 (0.37) |
| Rows: payloads of one Item (median payload) | **0.07** (0.07) |
| Dirty set: clone the record | 7.5 (7.0) |
| Dirty set: `Dirty::between`, one Item changed | 5.1 (4.5) |
| Dirty set: `Dirty::of_event` | < 0.01 |

Notes on the numbers:

- A write is ~70× cheaper. Reading one Item's payloads takes 0.07–0.4 ms instead of a 69 ms parse. A Turn with the metadata is ~35× cheaper to load.
- A whole load stays about the cost of parsing it: rows are ~14% slower with payloads and ~21% faster without them. The client view keeps every field up to 8 KiB whole, plus 4 KiB previews.
- Larger gains on loads come from loading only the Turns needed: listed views and payload requests now do; committed records stay held.

## Tests

`core/tests/record_rows.rs` (20 tests, 1 ignored), `core/tests/record_rows_store.rs` (6) and `record_rows::tests` (2, 1 ignored):

- **Round trips:** exact round trips, including records with repeated, missing or `~` IDs, odd shapes and difficult floats.
- **Payloads and previews:** which fields become payloads and their previews; a load without payloads never reads payload rows (they are made unreadable, then the table is dropped); loading one Turn, one Item's payloads, or the metadata; writing the metadata alone.
- **Dirty writes:**
  - Only the named rows are written, as recorded by triggers.
  - Deleted Turns and Items are removed with their payloads.
  - Added, moved and recounted rows are found without being named.
  - Fields move between Item and payload rows.
  - 250 random edit steps written by compared dirty sets.
- **Dirty sets:** `between` and `of_event` on their own; `of_event` against what `apply_at` and `project_event_at` change, for Codex and Claude events.
- **Store on rows:** the detail API reads rows without payloads and equals the client view (Items a request is about whole; other payload rows made unreadable); payload requests read only their rows, or the record in memory when it is newer; listed views from the newest Turn equal `rail::project` of the whole record; committed records stay held (the metadata row made unreadable after the first update, four more updates succeed) and leave memory when idle; a damaged record (an Item row deleted) is listed and shown read only from its original, refuses changes, holds back no other Agent, and falls back to its metadata, then its ID; `revert_workspace` refuses while a Core holds the lock and stores a damaged record as shown; the `--revert-record-rows` command.
- **Conversion:** backup first; a second run is a no-op; it resumes after a crash before or after an Agent's commit, without a second backup; a record that cannot convert stays whole; revert; older builds cannot read a converted record; `Store::open` adds the tables.
- **Real data** (ignored by default, `YUZUNO_RECORD_ROWS_DB=<copy>`): every daily record round-trips and converts exactly. All 5 also come back byte for byte as stored. `of_event` covers what changes over the newest real events of every Agent.

## Isolated Core on a converted copy

`check_core.py` copies the daily database (backup API, read only), starts this Core on it (port 4470, its own HOME and CODEX_HOME with only the imported sessions' rollouts, no credentials), and checks every Agent through the API. Result (debug build):

- Core answered 3.3 s after start, conversion included. It logged the backup (`workspace.before-record-rows-<UTC>.sqlite`) and "stores 5 more Agent records as rows"; all 5 are layout 1, with 5 originals kept.
- For every Agent, the detail matches the record as stored before the conversion. Every untrimmed Item field is equal; each trimmed field's full value comes back equal through both the Turn payload and the Item payload routes: 742 trimmed fields, 7559 Items, 111 Turns.
- Detail responses take 0.03–0.19 s; one Item's payload about 2 ms. An unknown Agent's payload is 404 `agent_not_found`.
- History for the two imported sessions answers 200, newest page and the page before the record's window. In the isolated Codex home both pages are empty, exactly as from the base Core (`d09aa96`) in the same home; the user's own Codex home is deliberately not used.

## Reproduction

These commands are for the record rows of layout 1 and need a checkout of
`586fd06` or earlier. The session store (T-140) refuses a Workspace an earlier
Core wrote, and has no `record_rows_bench`.

```sh
# a consolidated copy of the daily database (Core stopped); never open the live file itself
for s in "" -wal -shm; do cp acceptance/live/core-data/workspace.sqlite$s acceptance/record-rows/data/raw.sqlite$s; done
sqlite3 acceptance/record-rows/data/raw.sqlite ".backup acceptance/record-rows/data/daily.sqlite"
python3 acceptance/record-rows/fields.py acceptance/record-rows/data/daily.sqlite
python3 acceptance/record-rows/check_core.py --core target/debug/yuzuno-workspace \
    --source acceptance/record-rows/data/daily.sqlite --work acceptance/record-rows/data/core-check
cargo run -p yuzuno-workspace --example record_rows_bench -- acceptance/record-rows/data/daily.sqlite acceptance/record-rows/data/work
YUZUNO_RECORD_ROWS_DB=$PWD/acceptance/record-rows/data/daily.sqlite cargo test -p yuzuno-workspace --test record_rows -- --ignored --test-threads=1
YUZUNO_RECORD_ROWS_DB=$PWD/acceptance/record-rows/data/daily.sqlite YUZUNO_RECORD_ROWS_EVENTS=6000 \
    cargo test -p yuzuno-workspace --lib of_event_names_what_real -- --ignored --nocapture
```

Run each through `/home/developer/yuzuno-next/target/heavy-slot.sh`.

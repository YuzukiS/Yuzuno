# Session store: a new data directory, and no conversion of earlier records

Status: accepted (T-140, the user's decision of 2026-10-26).

The session store keeps an Agent's history only in rows and holds bounded slices of it in memory (`core/src/record_rows.rs`, `core/src/store.rs`). Earlier Cores stored the same records in other layouts: whole JSON rows (layout 0) and an earlier set of record rows (layout 1).

## Decision

- **Its own directory only.** The session store opens a data directory it wrote, or one that has no Agents yet, which it then marks as its own (`workspace_meta`: `sessionStore=2`). Its records layout is 2.
- **No conversion.** It does not read, convert or migrate session data that an earlier Core wrote. There is no converter, no compatibility layer for earlier records layouts or versions, and no automatic migration of the task board.
- **Tasks are rebuilt by hand.** Tasks that must carry over are rebuilt manually in the switch window, with an old-ID to new-ID map checked item by item.
- **The old directory stays as it is.** The earlier directory is never converted or overwritten.
- **Incompatible updates are refused up front.** A managed update to a release that cannot read the current records layout is refused before it is applied (`updates::storage::Storage::readable_by`). Backups and restores refuse other layouts in the same way.

## Still required of the new format

This decision does not relax any of these:

- The store's own rows stay consistent: records, payloads, stream chunks, receipts and lookup keys. Damage is reported, never silently dropped.
- A failed write leaves memory and rows as they were. After a crash, the Workspace reopens at its last committed state.
- History is read on demand, within the store's byte bounds.
- Native identity and permissions are kept, and so are approvals. An input whose delivery is unknown is never sent again.
- A reconnect is correct: Turns another client added are merged into the record, or stay pageable when there are more than a reconnect reads, and are never silently dropped.

## Consequences

- Opening an earlier Workspace that has Agents fails, with a message that names the new data directory as the way on. The task board moves only through the manual rebuild.
- Switching a running Core to the session store is a separate, approved window with a backup, an import check and a way back. This decision authorizes no deletion of existing data.

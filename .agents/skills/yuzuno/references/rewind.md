# Conversation rewind and file checkpoints

Rewind is an explicit user action in a reply footer. Do not infer authorization
to rewind a daily Agent, restore its files or edit native transcript files from
a task to implement or test this feature. Use fresh isolated sessions and files
for validation.

Codex conversation rewind uses the native `thread/revert` before a specific
native turn, only for supported persistent paginated sessions. A fork creates
another session; it is not rewind. Claude file restore uses its native user
message UUID and the existing preview/confirmation flow. File restore alone
does not rewind a conversation. Current Claude resume-at options do not provide
an independently persisted rewind without another prompt, so that conversation
option is unavailable. Never send a hidden prompt to make a rewind appear done.

An uncertain result is checked against native history, never automatically
repeated. If checks cannot settle it, the user may explicitly keep the current
native history; Core stops the idle local runtime before accepting that history
and releases the input block without claiming the rewind succeeded. Removed conversation history does not undo tasks, Jobs, PRs, approvals
or command/file side effects. Continue to use their durable identifiers and
actual outcomes; do not recreate operations because their chat messages are no
longer visible. See the product's [Rewind guide](../../../../docs/rewind.md)
for the current local/SSH matrix and evidence boundaries.

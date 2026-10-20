# Conversation header redesign

Runtime status now sits beside the Agent name. Model settings, search, close/reopen
and more actions share one quiet tool group with consistent 32px controls, spacing,
hover states and keyboard focus. Close/reopen remains directly accessible and keeps
the existing confirmation behavior. Search shortcuts and Escape handling are unchanged.

Container queries respond to the actual conversation width, including when either
sidebar is resized. Below 640px the model label shortens to “Model”; below 440px
the group occupies a second horizontal row instead of stacking individual buttons.

Validation used `/tmp/yuzuno-conversation-header-dist`, independent headless browsers,
and fixture data. No daily Core/window was used and daily `web/dist` hashes were unchanged.

- TypeScript and isolated Vite build passed.
- Existing UI and conversation search tests passed.
- `panel-resize-check.mjs`: 20 checks passed; light/dark, 20px, 390–1600px,
  panel dragging/persistence and reading/draft preservation. See `report.json`.
- `agent-management-check.mjs`: 19 checks passed; close/reopen/delete confirmations,
  failure recovery, Claude model settings and narrow-screen dialogs. Its report is
  `../agent-management/browser/report.json`.

The screenshots in this directory contain fixture conversations. To review in an
independent build, open model settings, search, close confirmation and more actions,
then drag both sidebar borders and repeat at 20px in both themes. Pressing Escape
inside each dialog should dismiss it without interrupting the Agent.

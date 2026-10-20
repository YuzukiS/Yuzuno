# Resizable side panels

The left Agent sidebar and right context panel have independent resize handles.
Drag the border facing the conversation. Hover/focus highlights the border.
Widths persist locally across reloads, Agent switches and panel hide/show.
Double-click or press Enter on a focused border to restore its default width.
Arrow keys adjust by 8px (Shift: 32px); Home/End reach the available limits.
Escape cancels an active drag without interrupting the Agent.

The conversation retains a minimum width. Existing narrow-window layouts remain:
the context panel is hidden at 1100px and below, and the Agent sidebar becomes
icons at 520px and below. Expanding the window restores preferred widths.

## Isolated validation

From `web/`:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --outDir /tmp/yuzuno-panel-resize-dist
YUZUNO_UI_DIST=/tmp/yuzuno-panel-resize-dist node tools/panel-resize-check.mjs
YUZUNO_UI_DIST=/tmp/yuzuno-panel-resize-dist node --test tools/ui.test.mjs
```

`panel-resize-check.mjs` opens an independent headless Chromium with in-memory
API fixtures. It never contacts a Core. `report.json` records results, including
light/dark themes at 20px and viewports from 390px to 1600px, both pointer and
keyboard controls, persistence, draft/history preservation, resize limits,
Escape handling and a fixed resize border while the context content scrolls.
Screenshots use fixture conversations, not a real Agent session.

Manual check in a build containing these changes:

1. Drag the left sidebar's right edge and the context panel's left edge.
2. Reload, switch Agents, then hide/show both panels: widths should persist.
3. Read an older message and leave a composer draft before resizing.
   An incoming execution event should keep you reading history with the draft intact.
4. Double-click either edge to reset only that panel. Check both themes at 20px.

This change does not publish to `web/dist`, reload the daily window, or restart Core.

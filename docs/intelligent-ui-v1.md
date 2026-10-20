# Intelligent UI V1 — T-8

The conversation remains the reading surface. A reply can opt into a small interactive result immediately below its explanation. Selecting rows or chart data prepares a follow-up in the same Agent's existing draft; the user reviews and sends it.

## Layout and scenarios

1. **Compare options.** “Compare three ways to navigate a long conversation.” A short recommendation precedes a compact table with search, sortable headings, keyboard-accessible row selection and sources. The selected count and one “Continue with selection” action sit below it. On narrow screens the table scrolls within the result, never the conversation shell.
2. **Explore a report.** “Show where conversation update time goes.” Two or three inline metrics, a bar chart with values and units, and the equivalent data table. Selecting a data point prepares a request to investigate it. Values are reported evidence, never invented live telemetry.
3. **Choose follow-up work.** “Show review findings and let me pick what to address.” The same table, text, source and continuation components form a checklist. This is a composition of the first catalog, not a separate task system; selection neither approves work nor modifies task state.

Each result uses current palette variables, a small character accent, restrained borders and existing reading size. A source/JSON disclosure preserves the original result. Invalid, partial or unsupported specs remain readable Markdown with a short fallback explanation. All examples and acceptance fixtures explicitly identify sample data.

## Reuse and integration

- `components.tsx`: `Turn` renders native `agentMessage` through `Prose`; add a narrow reply wrapper here. Keep async questions, original message anchors, copy text and tool folding intact.
- `App.tsx`: existing per-Agent draft storage and explicit append callback can be reused. Capture source Agent identity; no calls to `submitMessage` from a result. Add a small composer entry opening the existing Radix dialog with a request template.
- Native item text is already part of Core snapshots and Harness recovery (`workspace.rs` reconcile / `store.rs`). A fenced spec in that text needs no Core database, API or extra result publication tool.
- Existing artifact previews retain their cwd bounds (`server.rs::artifact_path`). A mutable file alone is not a historical result snapshot. File sources are opened only on explicit click through the existing preview callback.
- Selection/filter preferences belong to the client and result identity. Losing browser storage must not lose the native result or break rendering.

## Libraries and boundary

The [json-render catalog/registry](https://json-render.dev/docs/registry) separates component definitions from their local implementations. V1 uses its React renderer with a much narrower, static schema: root and elements only; no watch, on, state, repeat, visibility expressions, dynamic props, remote components, HTML or supplied JavaScript. Zod validation and bounded acyclic tree checks happen before mounting a renderer. A catalog alone is not a sandbox.

[A2UI](https://github.com/a2ui-project/a2ui) similarly maps declarative data to a trusted client component catalog; this informs the host-owned visual design. [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) uses tool UI resources, sandboxed frames and a host bridge. Building that host and a second wire format is outside this slice.

The initial local components are Result, Section, Text, Metrics, Table, BarChart, Sources and Continue. Table sorting/filtering uses TanStack Table; charts use Recharts. Only explicit user clicks invoke host callbacks; renderer action handlers do not send messages, write files or grant permissions.

## Acceptance

Use a fresh worktree build, independent assets/data and port 4387. Unit checks cover strict schemas, cycles/limits, partial Markdown and dangerous inputs. Browser checks cover selection, filtering, sorting, draft preservation/Agent attribution, sources, Escape, refresh, invalid fallback and ordinary Markdown; include light/dark, 20px, narrow width and reduced motion. A new native Harness Agent must produce a real result, which is then exercised and recovered in the isolated GUI. Fixture checks alone do not satisfy the native result acceptance.

No daily Core restart, daily UI overwrite, existing-Agent prompts or main-worktree edits. No task completion is implied by this design document.

# Claude MCP service status (T-30)

A Claude Agent's inspector now shows a compact, independent MCP services section with native service names, connection/authentication states, a safe reason for failures, observation time, and manual refresh. It reads the existing live Claude Query; opening the panel does not create a runtime, send a prompt, reconnect a service, or authenticate.

Implementation tested at `f6efe853d8c82ae5fef50f59aaab1e9198772506`, based on `4ee12e2fe8b9790785648a005561ea4c7b577148`. This evidence-only follow-up does not change implementation or tests.

## Native contract

The actual host installation at `runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json` reports **0.3.296**. Its `sdk.d.ts` exposes `Query.mcpServerStatus(): Promise<McpServerStatus[]>`; the installed `sdk.mjs` sends a control request with `subtype: "mcp_status"` and returns `response.mcpServers`. Native states are `connected`, `failed`, `needs-auth`, `pending`, and `disabled`; unrecognized values display Unknown.

The SDK also returns configuration, errors, tool descriptions and other metadata. The new bridge helper emits only a closed name/status/reason schema. Raw errors and configuration are discarded before bridge response logging. Reasons are categorical, so an error containing a URL, credential, environment variable or native diagnostic cannot be rendered verbatim. Core applies another typed boundary.

Authentication help links to Claude Code's [official MCP authentication workflow](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers). The UI provides guidance only.

## Isolation and refresh

- Core entries belong to one Agent, working folder, native session, machine and connection generation. A late result is rechecked under the existing ownership lock before publication.
- Concurrent initial reads or explicit refreshes share one attempt. Ordinary GETs retain the cached observation, including failures; the UI does not query on every Agent delta. Its 15-second local timer only ages the label.
- An observation becomes stale after 60 seconds. Failed reads and disconnections retain any same-environment observation with explicit stale wording and neutral status styling; a replacement generation/environment inherits none.
- Initializing, not started/disconnected, closed, unsupported SDK and read failure have separate messages. Remote Claude status is explicitly unavailable in this first version.
- The UI remounts on Agent/session/environment/connection-state changes, aborts disposed HTTP reads and rejects late callbacks. A 45-second HTTP timeout bounds a stuck client read; the existing bridge request has a 35-second timeout.

## Validation

All local heavy validation ran through managed Jobs and the shared two-slot wrapper. No actual model, MCP endpoint, OAuth flow, daily Core or daily UI was used.

1. Job `df56569f-5ef1-4604-acf0-7e1003f50056`, implementation head `7a8d3c718aa75366bcf7e7a2c81c8495c0331223`: `node --test runtimes/claude/mcp-status.test.mjs` **4 passed**, `npm run typecheck` **passed**. The component harness exposed a test timing issue: it clicked again before React committed the first busy state. The follow-up test fix waits for that state; product code was unchanged.
2. Job `2252f2c0-a688-4888-8ae9-58dafbee2d42`, head `f6efe853d8c82ae5fef50f59aaab1e9198772506`, attempt `d7e556ca-4cb9-4deb-ab4e-f9b83b6d3f27`: **succeeded**, exit 0, finished 2026-10-17 01:30:19 UTC. Three component tests passed; isolated Vite build and Chromium flow passed; `cargo test --locked --lib claude_mcp::tests -- --test-threads=1` **2 passed**.

Coverage includes all native states and future/unknown states; config/error redaction; capability absence; synchronous and asynchronous SDK errors; duplicate refresh coalescing; failed-read stale retention and recovery; Agent/session/folder replacement and late callbacks; age expiry; real Core-to-bridge NDJSON queries over a scripted SDK; disconnection/reconnection; an old generation's successful late reply rejected after generation replacement; no model prompts and no runtime start from status reads.

The production browser ran at 1440×1000 with fully intercepted APIs. It verified keyboard refresh, duplicate-click suppression, failed refresh and recovery, readable states/help, and no section overflow. See the [browser report](browser-report.json). The screenshot is retained as the output `target/t30-validation/browser/mcp-status.png` of Job `2252f2c0-a688-4888-8ae9-58dafbee2d42`, and in the original evidence commit (`7ca1fb97`, private repository). Its SHA-256 is `fd6fb771a996da53bdc117f4b421d8acd8755326e21d5eb922fec4e699b2ca30`. It observed one initial GET and two explicit POST refreshes, zero unexpected requests and zero browser errors. No broad browser matrix was repeated.

Full exact-head CI and independent review are recorded on the task/PR, separately from this local evidence. Canonical Yuzuno skill changes are unnecessary: this adds a user inspector and private HTTP/bridge read path, without changing Agent-facing collaboration tool contracts.

## Review evidence packaging

Independent review `0cc70eed-9597-4982-abd2-00058526cd06` completed on the first PR candidate with zero findings after reading all 15 text diffs, but its conclusion remained unknown: the text-only source tool could not inspect the one PNG attachment (receipt 16; no call/byte limit was reached). The image remains available in the Job and original evidence commit, while the final source diff contains only the implementation, tests and text evidence. No product/test code changed for this adjustment; the incomplete first review is retained and consumes round 1 of the authorized two-round cap.

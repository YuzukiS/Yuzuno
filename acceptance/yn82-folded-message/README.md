# YN-82 check: a message sent while Claude Code works

`probe.mjs` runs the real Claude Code CLI with the pinned Agent SDK and this
checkout's bridge against a local API fixture. It uses a fresh profile and a
fixture key that only the fixture accepts. There is no model, no login and no
Core.

```
node acceptance/yn82-folded-message/probe.mjs <sdk.mjs of the pinned SDK> <claude executable> <report.json>
```

Each phase sends one prompt, and the fixture answers it with a `Read` call.
It holds that answer until a second message has been queued, so Claude Code
takes the second message in after the tool round. Phase `sdk` records the
SDK frames. Phase `bridge` drives `ClaudeBridge` (`send`, then `append`) and
records what the bridge emits.

`verdict.acceptedBeforeReply` says whether the bridge reported the follow-up
`accepted` before Claude's reply to it. That is the moment the user sees it
received, while the turn still runs.

Observed with CLI 2.1.296 (the SDK's own) and 2.1.318:

- Claude Code sends `command_lifecycle` `started` for the follow-up as it
  takes it in, then a `system`/`status` frame listing both prompts.
- The reply after that carries no uuid. The result lists both prompts.
- On the base (464c8c0f), the bridge reports `accepted` only as the turn
  ends (`acceptedBeforeReply: false`).

The fixture shows the protocol for one short turn. It does not show a real
model's timing, or turns that Claude Code starts on its own.

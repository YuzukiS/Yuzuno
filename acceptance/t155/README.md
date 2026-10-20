# T-155: what an Agent's client receives from Yuzuno's MCP server

Two measurements behind the tool-contract changes. Neither calls a model or uses real credentials.

## Where a client puts server instructions and tool descriptions

`client_layout_probe.py` runs one native client against a throwaway stdio MCP server whose instructions and tool descriptions carry markers.

- The client's model endpoint is a local recorder. It keeps request bodies only, never headers, and answers 400.
- The client gets a dummy key and a temporary home; the user's own configuration and credentials are not read.

```
python3 acceptance/t155/client_layout_probe.py --harness codex --tools 53 --out /tmp/t155/codex
python3 acceptance/t155/client_layout_probe.py --harness claude --tools 53 --words 300 --out /tmp/t155/claude
```

`report.json` counts how often the instructions and the first tool's description appear in the first request, and how the probe tools were sent.

Measured on 2026-10-20:

| Client | Tools offered | Instructions in the request | Tool entries |
| --- | --- | --- | --- |
| codex-cli 0.162.1 (`codex exec`) | 2, 53, 53 of about 1,500 characters | once, as the description of one `mcp__probe` namespace | 1 namespace holding every tool, none deferred |
| Claude Code 2.1.280 (`claude -p`) | 2, 53, 53 of about 1,500 characters | once, in a "MCP Server Instructions" block | one entry per tool, none deferred |

Neither client copies the instructions into each tool. This covers only these versions, invoked this way.

A Yuzuno Claude session that also had other MCP servers listed its Yuzuno tools by name and loaded them through ToolSearch. The bare probe above did not defer them, so deferral depends on the session, not on these tools alone.

## Size of Yuzuno's tool contract

The ignored test `contract_dump` writes the server instructions, the session notice, the Brief hard rules and every tool definition:

```
cd core && YUZUNO_CONTRACT_DUMP=/tmp/t155/after.json cargo test --lib contract_dump -- --ignored
python3 acceptance/t155/measure_contract.py /tmp/t155/before.json /tmp/t155/after.json
```

Characters are Unicode code points and bytes are UTF-8, of compact JSON; neither is a token count. A dump describes the commit it was built from. A running Core lists its own release's tools, which can differ from a later commit's.

#!/usr/bin/env node
// T-86: what Claude Code itself did with the Yuzuno MCP tools, with no model
// turn.
//
//   YUZUNO_LAB_MCP_TOKEN=<token> YUZUNO_LAB_DEBUG_FILE=<path> \
//     node cli_view.mjs <MCP URL> <claude executable>
//
// Connects the lab Core's MCP server the way the Claude bridge does
// (setMcpServers with an http server named "yuzuno") to a query that never
// sends a prompt, with Claude Code's own debug log on (--debug-file). It
// prints one JSON line: the result_* tools Claude Code listed for the server,
// and every "... truncated from X to Y chars" record Claude Code wrote while
// taking the server in (CLI 2.1.280 writes one for each tool description or
// server instructions it cuts). mcpServerStatus lists tool names only, so the
// debug log is what says what Claude Code kept. It never prints the token.
// Run only against a lab Core: live.py reads the token from its data folder.
import { readFileSync } from 'node:fs';
import { query } from '../../runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';

const [url, executable] = process.argv.slice(2);
const token = process.env.YUZUNO_LAB_MCP_TOKEN;
const debugFile = process.env.YUZUNO_LAB_DEBUG_FILE;
if (!url || !executable || !token || !debugFile) {
  console.error('usage: YUZUNO_LAB_MCP_TOKEN=... YUZUNO_LAB_DEBUG_FILE=... node cli_view.mjs <MCP URL> <claude executable>');
  process.exit(2);
}

// A prompt stream that stays open and empty until closed.
let finish;
const idle = { [Symbol.asyncIterator]() { return { next: () => new Promise(resolve => { finish = () => resolve({ done: true }); }) }; } };

const session = query({
  prompt: idle,
  options: {
    pathToClaudeCodeExecutable: executable,
    // Only the lab server: the user's other MCP servers are irrelevant here.
    settingSources: [],
    persistSession: false,
    permissionMode: 'default',
    extraArgs: { 'debug-file': debugFile },
  },
});
const timer = setTimeout(() => { console.error('timed out'); process.exit(3); }, 60_000);
try {
  await session.initializationResult();
  const added = await session.setMcpServers({ yuzuno: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } });
  if (!added.added?.includes('yuzuno')) throw new Error(`yuzuno was not added: ${JSON.stringify(added.errors ?? {})}`);
  let server;
  for (let attempt = 0; attempt < 40; attempt++) {
    server = (await session.mcpServerStatus()).find(entry => entry.name === 'yuzuno');
    if (server?.status === 'connected' && server.tools?.length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // Give the log a moment to be written after the tools were taken in.
  await new Promise(resolve => setTimeout(resolve, 1000));
  const log = readFileSync(debugFile, 'utf8');
  const truncations = log.split('\n').filter(line => /truncated from \d+ to \d+ chars/.test(line))
    .map(line => line.replace(/^.*?((?:Tool "[^"]+" description|Server instructions) truncated from \d+ to \d+ chars).*$/, '$1'));
  console.log(JSON.stringify({
    status: server?.status ?? null,
    toolCount: server?.tools?.length ?? 0,
    tools: (server?.tools ?? []).map(tool => tool.name).filter(name => name.startsWith('result_')),
    maxDescriptionLengthEnv: process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH ?? null,
    debugLogLines: log.split('\n').length,
    yuzunoInLog: log.includes('yuzuno'),
    truncations,
  }));
} finally {
  clearTimeout(timer);
  finish?.();
  session.close?.();
}
process.exit(0);

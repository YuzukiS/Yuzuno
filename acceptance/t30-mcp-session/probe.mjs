#!/usr/bin/env node
// T-30: the MCP servers Claude Code itself reports for a folder, straight from
// the SDK the bridge uses, with the bridge's settings sources, no prompt and
// no saved session:
//
//   node probe.mjs <sdk.mjs> <claude executable> <cwd>
//
// Waits up to 20s for servers still pending, then prints {"servers":[{name,status}]}.
const [sdkPath, executable, cwd] = process.argv.slice(2);
const { query } = await import(sdkPath);
let finish;
const idle = { [Symbol.asyncIterator]() { return { next: () => new Promise(resolve => { finish = () => resolve({ done: true }); }) }; } };
const session = query({
  prompt: idle,
  options: {
    cwd,
    pathToClaudeCodeExecutable: executable,
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    persistSession: false,
  },
});
const timer = setTimeout(() => { console.error('timed out'); process.exit(3); }, 90_000);
try {
  await session.initializationResult();
  let servers = [];
  for (let i = 0; i < 40; i++) {
    servers = await session.mcpServerStatus();
    if (!servers.some(s => s.status === 'pending')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log(JSON.stringify({ servers: servers.map(s => ({ name: s.name, status: s.status })) }));
} finally {
  clearTimeout(timer);
  finish?.();
  session.close?.();
}
process.exit(0);

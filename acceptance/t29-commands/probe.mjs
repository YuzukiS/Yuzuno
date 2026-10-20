#!/usr/bin/env node
// T-29: Claude Code's own command list for a folder, straight from the SDK
// the bridge uses, with the bridge's settings sources, no prompt and no saved
// session:
//
//   node probe.mjs <sdk.mjs> <claude executable> <cwd>
//
// Prints {"names":[...],"terminal":[]}. Terminal-only commands are known only
// from a turn's init, which a session with no prompt never has.
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
  const listed = await session.supportedCommands();
  console.log(JSON.stringify({ names: listed.map(c => c.name), terminal: [] }));
} finally {
  clearTimeout(timer);
  finish?.();
  session.close?.();
}
process.exit(0);

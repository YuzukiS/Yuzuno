// Real bridge, scripted read-only SDK. No CLI, model or MCP service is started.
// Like Claude Code, a session may name itself on a SessionStart hook before
// any turn (`earlyHook` in mcp-mode.json), and a held read sees the session
// change when the cwd has a file `switch-to` naming the new one.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function query({ options, prompt }) {
  const output = new PromptQueue();
  const path = name => join(options.cwd, name);
  const mode = () => JSON.parse(readFileSync(path('mcp-mode.json'), 'utf8'));
  appendFileSync(path('starts'), 'start\n');
  const named = id => output.push({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart', session_id: id });
  if (mode().earlyHook) named(mode().earlyHook);
  output.initializationResult = async () => ({});
  output.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  if (!mode().unsupported) output.mcpServerStatus = async () => {
    const config = mode();
    appendFileSync(path('reads'), 'read\n');
    if (config.hold) {
      writeFileSync(path('reading'), '1');
      while (!existsSync(path('release'))) {
        if (existsSync(path('switch-to'))) {
          named(readFileSync(path('switch-to'), 'utf8'));
          unlinkSync(path('switch-to'));
        }
        await wait(10);
      }
    }
    if (config.fail) throw new Error('native-secret: https://user:password@server/?token=secret');
    return config.servers ?? [{ name: 'fixture', status: 'connected' }];
  };
  (async () => { for await (const _ of prompt) appendFileSync(path('prompts'), 'unexpected\n'); })();
  return output;
}
const bridge = new ClaudeBridge({ query, emit: (_event, encoded) => process.stdout.write(`${encoded}\n`),
  resolveCli: () => '/fixture/claude', version: async () => '2.1.280' });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    void bridge.handle(command).then(() => { if (command?.op === 'close') process.exit(0); });
  }
});
process.stdin.on('end', () => { bridge.close(); process.exit(0); });

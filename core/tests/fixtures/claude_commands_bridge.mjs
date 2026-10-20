// Real bridge, scripted read-only SDK that lists commands (T-29). No CLI,
// model or prompt. Each start and command read is recorded in the cwd, with
// whether it was a session or a catalogue-only (folder) start. Like Claude
// Code, a session names itself on a hook event before any turn, which Core
// does not record as the Agent's session. A session's native stream ends
// once the cwd has a file named `end-session`.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';
function query({ options, prompt }) {
  const output = new PromptQueue();
  const path = name => join(options.cwd, name);
  const kind = options.persistSession === false ? 'folder' : 'session';
  appendFileSync(path('starts'), `${kind}\n`);
  output.initializationResult = async () => ({});
  output.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  output.supportedCommands = async () => {
    appendFileSync(path('reads'), `${kind}\n`);
    return JSON.parse(readFileSync(path('commands.json'), 'utf8'));
  };
  (async () => { for await (const _ of prompt) appendFileSync(path('prompts'), 'unexpected\n'); })();
  if (kind === 'session') output.push({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart', session_id: 'e0e0e0e0-0000-4000-8000-000000000029' });
  if (kind === 'session') (async () => {
    while (!existsSync(path('end-session'))) await new Promise(resolve => setTimeout(resolve, 20));
    output.close();
  })();
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

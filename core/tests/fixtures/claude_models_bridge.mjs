// Real bridge, scripted SDK that lists models (T-190). No CLI, model or
// prompt. The models are `models.json` in the cwd, read on each list; while
// a file named `hold` is there, a list waits and says so with `listing`.
// Each start is recorded in `starts` (a catalogue-only folder start or a
// session, and the model it was given). A session's native stream ends once
// the cwd has a file named `end-session`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';
function query({ options, prompt }) {
  const output = new PromptQueue();
  const path = name => join(options.cwd, name);
  const kind = options.persistSession === false ? 'folder' : 'session';
  appendFileSync(path('starts'), `${kind} ${options.model ?? '-'}\n`);
  output.initializationResult = async () => ({});
  output.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedCommands = async () => [];
  output.supportedModels = async () => {
    if (existsSync(path('hold'))) {
      writeFileSync(path('listing'), '');
      while (existsSync(path('hold'))) await new Promise(resolve => setTimeout(resolve, 20));
    }
    return JSON.parse(readFileSync(path('models.json'), 'utf8'));
  };
  (async () => { for await (const _ of prompt) appendFileSync(path('prompts'), 'unexpected\n'); })();
  if (kind === 'session') output.push({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart', session_id: 'e0e0e0e0-0000-4000-8000-000000000190' });
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

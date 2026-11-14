// Real bridge, scripted SDK (YN-138). Each start appends to starts.jsonl in its
// cwd the session it resumes and the claude-swap account its launcher was
// given (YUZUNO_CSWAP_ACCOUNT, null on the host's own login). Each prompt is
// answered at once, in the session it resumes. No CLI, model, claude-swap or
// MCP service is started. A test may load it from a runtime folder of its own
// (`import` of this file), beside a stand-in `cswap-claude` launcher.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

const fresh = 'e0e0e0e0-0000-4000-8000-000000000138';

function query({ options, prompt }) {
  const output = new PromptQueue();
  appendFileSync(join(options.cwd, 'starts.jsonl'), `${JSON.stringify({
    resume: options.resume ?? null, account: process.env.YUZUNO_CSWAP_ACCOUNT ?? null })}\n`);
  const session = options.resume ?? fresh;
  output.initializationResult = async () => ({});
  output.setMcpServers = async servers => ({ added: Object.keys(servers ?? {}), removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  output.mcpServerStatus = async () => [];
  output.setModel = async () => {};
  output.setPermissionMode = async () => {};
  output.applyFlagSettings = async () => {};
  const push = frame => output.push({ session_id: session, parent_tool_use_id: null, ...frame });
  (async () => {
    for await (const message of prompt) {
      const uuid = message.uuid;
      const stamp = { user_message_uuid: uuid, user_message_uuids: [uuid] };
      push({ type: 'system', subtype: 'init', uuid: `init-${uuid}`, model: 'fixture' });
      push({ type: 'assistant', uuid: `reply-${uuid}`, ...stamp, message: { id: `msg-${uuid}`, role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }] } });
      push({ type: 'result', subtype: 'success', uuid: `done-${uuid}`, is_error: false, duration_ms: 5, num_turns: 1, result: 'Done.', ...stamp });
    }
  })();
  return output;
}
const bridge = new ClaudeBridge({ query, emit: (_event, encoded) => process.stdout.write(`${encoded}\n`),
  resolveCli: () => '/fixture/claude', version: async () => '2.1.318' });
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

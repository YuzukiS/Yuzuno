// The real bridge (runtimes/claude/bridge.mjs) over a scripted Claude SDK
// that also saves its session as CLI 2.1.280 does (T-22 probes 5c16542a,
// 54b7e79a): one entry per prompt, per assistant content block and per tool
// result, plus system entries, as JSON lines in YUZUNO_TEST_CLAUDE_HISTORY.
// The bridge reads it back through its history API (getSessionMessages and
// the sub-agent readers), as the SDK reads ~/.claude/projects.
//
// Prompt "cut": a tool call is streamed; its result and the reply are saved
// but never streamed, and the process ends, as when Core stops mid-turn.
// Any other prompt: a plain reply. A file "<history>.exit" ends an idle
// process. No model or CLI is called.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

const session = '5e55a0ee-0000-4000-8000-000000000022';
const file = process.env.YUZUNO_TEST_CLAUDE_HISTORY;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = message => appendFileSync(file, `${JSON.stringify({ session_id: session, parent_tool_use_id: null, parent_agent_id: null,
  timestamp: new Date().toISOString(), ...message })}\n`);
const saved = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

function query({ prompt }) {
  const output = new PromptQueue();
  output.initializationResult = async () => ({});
  output.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  output.setModel = async () => {};
  output.setPermissionMode = async () => {};
  output.applyFlagSettings = async () => {};
  const push = frame => output.push({ session_id: session, parent_tool_use_id: null, ...frame });
  (async () => {
    for await (const message of prompt) {
      const uuid = message.uuid;
      const stamp = { user_message_uuid: uuid, user_message_uuids: [uuid] };
      const content = message.message.content;
      const text = typeof content === 'string' ? content : content.map(b => b.text ?? '').join('');
      save({ type: 'user', uuid, message: message.message });
      push({ type: 'system', subtype: 'init', uuid: `init-${uuid}`, model: 'fixture' });
      if (text === 'cut') {
        const call = { type: 'assistant', uuid: `call-${uuid}`, message: { id: `msg-call-${uuid}`, role: 'assistant', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: `tool-${uuid}`, name: 'Bash', input: { command: 'ls' } }] } };
        save(call);
        push({ ...call, ...stamp });
        await wait(150);
        save({ type: 'user', uuid: `result-${uuid}`, message: { role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `tool-${uuid}`, content: 'a.txt', is_error: false }] } });
        save({ type: 'assistant', uuid: `reply-${uuid}`, message: { id: `msg-reply-${uuid}`, role: 'assistant', stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'The file is a.txt.' }] } });
        save({ type: 'system', uuid: `stop-${uuid}` });
        process.exit(1);
      }
      const reply = { type: 'assistant', uuid: `reply-${uuid}`, message: { id: `msg-reply-${uuid}`, role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello.' }] } };
      save(reply);
      push({ ...reply, ...stamp });
      save({ type: 'system', uuid: `stop-${uuid}` });
      push({ type: 'result', subtype: 'success', uuid: `done-${uuid}`, is_error: false, duration_ms: 5, num_turns: 1, result: 'Hello.', ...stamp });
    }
  })();
  return output;
}

const bridge = new ClaudeBridge({
  query,
  history: {
    getSessionMessages: async (id, options) => (id === session ? saved().filter(m => options?.includeSystemMessages || m.type !== 'system') : []),
    listSubagents: async () => [],
    getSubagentMessages: async () => [],
  },
  emit: (_event, encoded) => process.stdout.write(`${encoded}\n`),
  resolveCli: () => '/fixture/claude',
  version: async () => '2.1.280',
  // The pinned SDK as an install's package.json and manifest.json say. Core's
  // CI installs no runtimes/claude, so it is stated like the CLI above; the
  // bridge's own check still decides how the two stand.
  sdk: { version: '0.3.296', builtInCli: '2.1.296' },
});
setInterval(() => {
  if (existsSync(`${file}.exit`)) {
    rmSync(`${file}.exit`);
    process.exit(0);
  }
}, 50);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    void bridge.handle(command).then(() => { if (command?.op === 'close') process.exit(0); });
  }
});
process.stdin.on('end', () => { bridge.close(); process.exit(0); });

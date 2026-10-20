// The real bridge (runtimes/claude/bridge.mjs) over a scripted Claude SDK
// whose saved sessions are files in YUZUNO_TEST_CLAUDE_SESSIONS:
// `sessions.json` (each session's metadata, newest first; `programmatic`
// marks one an SDK started) and `<id>.jsonl` (its saved messages). As the
// SDK does, a session is read only in the folder Claude saved it under.
//
// Every SDK call is appended to `calls.jsonl`, every query's options to
// `starts.jsonl` and every prompt a query receives to `prompts.jsonl`, so
// a test sees whether anything started, resumed or was sent. A query
// answers each prompt with a plain reply and saves both to its session.
// No model or CLI is called.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

const dir = process.env.YUZUNO_TEST_CLAUDE_SESSIONS;
const log = (name, value) => appendFileSync(join(dir, name), `${JSON.stringify(value)}\n`);
const sessions = () => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
const info = id => sessions().find(s => s.sessionId === id);
const messages = id => {
  const file = join(dir, `${id}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};
const save = (id, message) => appendFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ session_id: id, parent_tool_use_id: null,
  parent_agent_id: null, timestamp: new Date().toISOString(), ...message })}\n`);
// Only in the folder Claude saved it under, as the SDK finds a session's file.
const found = (id, options) => {
  const session = info(id);
  return session && (!options?.dir || options.dir === session.cwd) ? session : undefined;
};

const history = {
  listSessions: async options => {
    log('calls.jsonl', { fn: 'listSessions', options });
    const all = sessions().filter(s => (options.includeProgrammatic || !s.programmatic) && (!options.dir || s.cwd === options.dir));
    return all.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? all.length));
  },
  getSessionInfo: async (id, options) => {
    log('calls.jsonl', { fn: 'getSessionInfo', id, options });
    return found(id, options);
  },
  getSessionMessages: async (id, options) => {
    log('calls.jsonl', { fn: 'getSessionMessages', id, options });
    return found(id, options) ? messages(id).filter(m => options?.includeSystemMessages || m.type !== 'system') : [];
  },
  listSubagents: async () => [],
  getSubagentMessages: async () => [],
};

function query({ prompt, options }) {
  log('calls.jsonl', { fn: 'query' });
  log('starts.jsonl', { resume: options.resume ?? null, cwd: options.cwd });
  const session = options.resume ?? 'f1e5f1e5-0000-4000-8000-000000000000';
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
      log('prompts.jsonl', { session, text: typeof content === 'string' ? content : content.map(b => b.text ?? '').join('') });
      save(session, { type: 'user', uuid, message: message.message });
      push({ type: 'system', subtype: 'init', uuid: `init-${uuid}`, model: 'fixture' });
      const reply = { type: 'assistant', uuid: `reply-${uuid}`, message: { id: `msg-reply-${uuid}`, role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'You are welcome.' }] } };
      save(session, reply);
      push({ ...reply, ...stamp });
      push({ type: 'result', subtype: 'success', uuid: `done-${uuid}`, is_error: false, duration_ms: 5, num_turns: 1, result: 'You are welcome.', ...stamp });
    }
  })();
  return output;
}

const bridge = new ClaudeBridge({
  query,
  history,
  emit: (_event, encoded) => process.stdout.write(`${encoded}\n`),
  resolveCli: () => '/fixture/claude',
  version: async () => '2.1.280',
});
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) void bridge.handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => { bridge.close(); process.exit(0); });

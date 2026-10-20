// The real bridge (runtimes/claude/bridge.mjs) over a scripted Claude SDK
// that runs into the usage limit on request, as CLI 2.1.280 reported it on
// 2026-10-17 (T-94 evidence):
//
//   "limit <resetsAt>"  a rate_limit_event rejected (five_hour, that reset,
//                       no overage), then the failed result Claude sends
//   "limit"             the same, without a reset time
//   "hold <resetsAt>"   as "limit <resetsAt>", and Claude refuses every later
//                       prompt of this session the same way until that reset
//   "fail"              a failed result while the limit allows requests
//   anything else       a plain reply
//
// Every prompt a query receives is appended to YUZUNO_TEST_CLAUDE_PROMPTS
// (one JSON line each), so a test sees exactly what was sent. No model or CLI
// is called.
import { appendFileSync } from 'node:fs';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

const log = process.env.YUZUNO_TEST_CLAUDE_PROMPTS;
const session = `0a0a0a0a-0000-4000-8000-${String(process.pid).padStart(12, '0')}`;
const held = new Map();

function query({ prompt, options }) {
  const output = new PromptQueue();
  output.initializationResult = async () => ({ account: { email: process.env.YUZUNO_TEST_CLAUDE_ACCOUNT || 'me@example.com' } });
  // As the SDK answers: every server given is added (a lab Core passes Workspace MCP).
  output.setMcpServers = async servers => ({ added: Object.keys(servers ?? {}), removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  output.setModel = async () => {};
  output.setPermissionMode = async () => {};
  output.applyFlagSettings = async () => {};
  const id = options.resume ?? session;
  const push = frame => output.push({ session_id: id, parent_tool_use_id: null, ...frame });
  (async () => {
    for await (const message of prompt) {
      const uuid = message.uuid;
      const stamp = { user_message_uuid: uuid, user_message_uuids: [uuid] };
      const content = message.message.content;
      const text = typeof content === 'string' ? content : content.map(b => b.text ?? '').join('');
      appendFileSync(log, `${JSON.stringify({ session: id, text })}\n`);
      push({ type: 'system', subtype: 'init', uuid: `init-${uuid}`, model: 'fixture' });
      const hold = /^hold (\d+)$/.exec(text);
      if (hold) held.set(id, Number(hold[1]));
      const refused = held.get(id) > Date.now() / 1000 ? [text, String(held.get(id))] : null;
      const limit = /^limit(?: (\d+))?$/.exec(text) ?? refused;
      if (limit || text === 'fail') {
        const info = { status: limit ? 'rejected' : 'allowed', rateLimitType: 'five_hour', isUsingOverage: false,
          overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', ...(limit?.[1] ? { resetsAt: Number(limit[1]) } : {}) };
        push({ type: 'rate_limit_event', uuid: `limit-${uuid}`, rate_limit_info: info });
        const said = limit ? "You've hit your session limit · resets 4:40am (America/New_York)" : 'API Error: Connection error.';
        push({ type: 'assistant', uuid: `said-${uuid}`, error: limit ? 'rate_limit' : 'unknown', ...stamp,
          message: { id: `msg-${uuid}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: said }] } });
        push({ type: 'result', subtype: 'success', uuid: `done-${uuid}`, is_error: true, duration_ms: 5, num_turns: 1, result: said, ...stamp });
        continue;
      }
      const reply = { type: 'assistant', uuid: `reply-${uuid}`, message: { id: `msg-${uuid}`, role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }] } };
      push({ ...reply, ...stamp });
      push({ type: 'result', subtype: 'success', uuid: `done-${uuid}`, is_error: false, duration_ms: 5, num_turns: 1, result: 'Done.', ...stamp });
    }
  })();
  return output;
}

const bridge = new ClaudeBridge({
  query,
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

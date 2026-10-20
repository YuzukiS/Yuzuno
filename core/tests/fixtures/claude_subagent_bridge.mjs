// The real bridge (runtimes/claude/bridge.mjs) over a scripted Claude SDK,
// as the bridge process Core starts in its integration tests. Frames follow
// CLI 2.1.280 (T-26 probe); no model or CLI is called.
//
// Prompt "start-<decision>": a background sub-agent whose own tool call asks
// for permission after the prompt's turn ended. The test answers it ("allow"
// or "deny" through Core), or with "cancel" Claude withdraws it. The call's
// result and the sub-agent's end follow. Any other prompt: a plain reply.
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

const session = 'session-fixture';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function query({ prompt, options }) {
  const output = new PromptQueue();
  output.initializationResult = async () => ({});
  output.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  output.setModel = async () => {};
  output.setPermissionMode = async () => {};
  const push = frame => output.push({ session_id: session, ...frame });
  (async () => {
    let n = 0;
    for await (const message of prompt) {
      n += 1;
      const uuid = message.uuid;
      const stamp = { user_message_uuid: uuid, user_message_uuids: [uuid] };
      const text = JSON.stringify(message.message ?? message);
      const decision = /start-(allow|deny|cancel)/.exec(text)?.[1];
      push({ type: 'system', subtype: 'init', uuid: `init-${n}`, model: 'fixture' });
      if (!decision) {
        push({ type: 'assistant', uuid: `reply-${n}`, parent_tool_use_id: null,
          message: { id: `msg-reply-${n}`, role: 'assistant', content: [{ type: 'text', text: 'Second answer.' }] }, ...stamp });
        push({ type: 'result', subtype: 'success', uuid: `result-${n}`, is_error: false, duration_ms: 5, num_turns: 1,
          result: 'Second answer.', ...stamp });
        continue;
      }
      push({ type: 'assistant', uuid: `call-${n}`, parent_tool_use_id: null, message: { id: `msg-call-${n}`, role: 'assistant',
        content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent',
          input: { description: 'Run the build', prompt: 'Run make', subagent_type: 'general-purpose', run_in_background: true } }] }, ...stamp });
      push({ type: 'system', subtype: 'task_started', uuid: `started-${n}`, task_id: 'task-1', tool_use_id: 'agent-1',
        task_type: 'local_agent', subagent_type: 'general-purpose', is_backgrounded: true, description: 'Run the build', prompt: 'Run make' });
      push({ type: 'user', uuid: `launched-${n}`, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: [{ type: 'text', text: 'Async agent launched' }] }] },
        tool_use_result: { status: 'async_launched', isAsync: true, agentId: 'a1', description: 'Run the build', prompt: 'Run make', outputFile: '/o' } });
      push({ type: 'assistant', uuid: `text-${n}`, parent_tool_use_id: null,
        message: { id: `msg-text-${n}`, role: 'assistant', content: [{ type: 'text', text: 'Started in the background.' }] } });
      push({ type: 'result', subtype: 'success', uuid: `done-${n}`, is_error: false, duration_ms: 5, num_turns: 1,
        result: 'Started in the background.', ...stamp });
      // The prompt's turn has ended. The background sub-agent's own call asks.
      await wait(100);
      push({ type: 'assistant', uuid: `sub-call-${n}`, parent_tool_use_id: 'agent-1', subagent_type: 'general-purpose',
        message: { id: `msg-sub-${n}`, role: 'assistant', content: [{ type: 'tool_use', id: 'sub-make', name: 'Bash', input: { command: 'make' } }] } });
      await wait(100);
      const controller = new AbortController();
      const asked = options.canUseTool('Bash', { command: 'make' }, { signal: controller.signal, toolUseID: 'sub-make' });
      if (decision === 'cancel') setTimeout(() => controller.abort(), 300);
      const allowed = (await asked).behavior === 'allow';
      const status = allowed ? 'completed' : decision === 'cancel' ? 'stopped' : 'failed';
      push({ type: 'user', uuid: `sub-result-${n}`, parent_tool_use_id: 'agent-1', subagent_type: 'general-purpose',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sub-make', content: allowed ? 'built' : 'not run', is_error: !allowed }] } });
      push({ type: 'system', subtype: 'task_updated', uuid: `updated-${n}`, task_id: 'task-1', patch: { status, end_time: 1 } });
      push({ type: 'system', subtype: 'task_notification', uuid: `notified-${n}`, task_id: 'task-1', tool_use_id: 'agent-1', status,
        summary: allowed ? 'The build passed.' : 'The build was not run.', output_file: '/o' });
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
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    void bridge.handle(command).then(() => { if (command?.op === 'close') process.exit(0); });
  }
});
process.stdin.on('end', () => { bridge.close(); process.exit(0); });

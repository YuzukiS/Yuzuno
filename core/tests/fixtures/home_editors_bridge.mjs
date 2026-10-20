// Real ClaudeBridge with a scripted SDK. The fixture releases Stop only after
// the Rust test has changed the real Core's user-owned project policy.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

let cwd;
function query({ options, prompt }) {
  cwd = options.cwd;
  const output = new PromptQueue();
  const session = 'e0e0e0e0-0000-4000-8000-000000000117';
  output.initializationResult = async () => ({});
  output.setMcpServers = async () => ({ added: ['yuzuno'], removed: [], errors: {} });
  output.supportedModels = async () => [];
  output.interrupt = async () => {};
  (async () => {
    let n = 0;
    for await (const item of prompt) {
      n++;
      const stamp = { user_message_uuid: item.uuid, user_message_uuids: [item.uuid] };
      output.push({ type: 'system', subtype: 'init', uuid: `init-${n}`, session_id: session,
        capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] });
      output.push({ type: 'assistant', uuid: `reply-${n}`, session_id: session, parent_tool_use_id: null,
        message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text: 'Fixture is working.' }] }, ...stamp });
      await new Promise(resolve => setImmediate(resolve));
      writeFileSync(join(cwd, `ready-${n}`), 'ready');
      while (!existsSync(join(cwd, `release-${n}`))) await new Promise(resolve => setTimeout(resolve, 10));
      const stop = await options.hooks.Stop.at(-1).hooks[0]({ hook_event_name: 'Stop', session_id: session,
        stop_hook_active: false }, undefined, { signal: new AbortController().signal });
      writeFileSync(join(cwd, `stop-${n}.json`), JSON.stringify(stop));
      output.push({ type: 'result', subtype: 'success', uuid: `result-${n}`, session_id: session,
        is_error: false, duration_ms: 5, num_turns: 1, result: '', ...stamp });
    }
  })().catch(error => { console.error(error); process.exit(1); });
  return output;
}
const bridge = new ClaudeBridge({ query, resolveCli: () => '/fixture/claude', version: async () => '2.1.280',
  emit: (event, encoded) => {
    if (event.type === 'brief_policy') appendFileSync(join(cwd, 'policy-requests.jsonl'), JSON.stringify(event) + '\n');
    if (event.type === 'response' && typeof event.id === 'string' && event.id.startsWith('brief-policy-')) {
      appendFileSync(join(cwd, 'policy-accepted.jsonl'), JSON.stringify(event) + '\n');
    }
    process.stdout.write(encoded + '\n');
  } });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.op === 'brief_policy') appendFileSync(join(cwd, 'policy-replies.jsonl'), JSON.stringify(command) + '\n');
    void bridge.handle(command).then(() => { if (command.op === 'close') process.exit(0); });
  }
});
process.stdin.on('end', () => { bridge.close(); process.exit(0); });

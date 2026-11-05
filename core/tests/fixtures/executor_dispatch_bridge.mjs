// Real ClaudeBridge with a scripted SDK (T-34): each prompt the executor gets
// is written to prompts.jsonl in its folder, and its Turn ends at once. No
// model, account or daily Core is used. A number in `fail-starts` in the
// folder fails that many starts, one by one (T-35 S2), each counted in
// `starts`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

function query({ options, prompt }) {
  const output = new PromptQueue();
  const session = randomUUID();
  appendFileSync(join(options.cwd, 'starts'), 'start\n');
  const failing = join(options.cwd, 'fail-starts');
  const left = existsSync(failing) ? Number(readFileSync(failing, 'utf8')) : 0;
  if (left > 0) writeFileSync(failing, String(left - 1));
  output.initializationResult = async () => {
    if (left > 0) throw new Error('scripted start failure');
    return {};
  };
  output.setMcpServers = async () => ({ added: ['yuzuno'], removed: [], errors: {} });
  output.supportedModels = async () => [];
  output.interrupt = async () => {};
  (async () => {
    let n = 0;
    for await (const item of prompt) {
      n++;
      appendFileSync(join(options.cwd, 'prompts.jsonl'), JSON.stringify(item.message) + '\n');
      const stamp = { user_message_uuid: item.uuid, user_message_uuids: [item.uuid] };
      output.push({ type: 'system', subtype: 'init', uuid: `init-${n}`, session_id: session,
        capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] });
      output.push({ type: 'assistant', uuid: `reply-${n}`, session_id: session, parent_tool_use_id: null,
        message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text: 'Fixture read its mail.' }] }, ...stamp });
      output.push({ type: 'result', subtype: 'success', uuid: `result-${n}`, session_id: session,
        is_error: false, duration_ms: 5, num_turns: 1, result: '', ...stamp });
    }
  })().catch(error => { console.error(error); process.exit(1); });
  return output;
}
const bridge = new ClaudeBridge({ query, resolveCli: () => '/fixture/claude', version: async () => '2.1.280',
  emit: (_event, encoded) => process.stdout.write(encoded + '\n') });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    void bridge.handle(command).then(() => { if (command.op === 'close') process.exit(0); });
  }
});
process.stdin.on('end', () => { bridge.close(); process.exit(0); });

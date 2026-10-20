// A stand-in for @anthropic-ai/claude-agent-sdk, loaded into the real bridge
// by fake-node.sh for the T-20 controlled acceptance. It never runs a model.
// The file named by T20_FAKE_MODE_FILE says how each reply is reported:
//   "unattributed": like a producer reporting no prompt uuid and no origin
//   "stamped":      like CLI 2.1.280, the prompt's uuid on reply and result
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const mode = () => {
  try { return readFileSync(process.env.T20_FAKE_MODE_FILE, 'utf8').trim(); } catch { return 'stamped'; }
};

export function query({ prompt, options = {} }) {
  const session = options.resume || randomUUID();
  const out = [];
  let wake = null;
  let closed = false;
  const push = frame => { out.push({ session_id: session, uuid: randomUUID(), ...frame }); wake?.(); wake = null; };
  (async () => {
    for await (const message of prompt) {
      if (closed) break;
      const stamp = mode() === 'stamped' ? { user_message_uuid: message.uuid, user_message_uuids: [message.uuid] } : {};
      const text = `Fixture reply (${mode()}) to: ${String(message.message?.content).slice(0, 60)}`;
      push({ type: 'system', subtype: 'init', model: options.model || 'haiku', claude_code_version: 'fixture',
        capabilities: ['interrupt_receipt_v1'], permissionMode: options.permissionMode || 'default' });
      push({ type: 'assistant', parent_tool_use_id: null, ...stamp,
        message: { id: `msg-${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text }] } });
      push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: text, ...stamp });
    }
  })();
  return {
    async initializationResult() { return { account: { apiProvider: 'fixture' } }; },
    async setMcpServers(servers) { return { added: Object.keys(servers), removed: [], errors: {} }; },
    async supportedModels() { return [{ value: 'haiku', displayName: 'Fixture Haiku', description: 'T-20 fixture' }]; },
    async setModel() {},
    async setPermissionMode() {},
    // Acknowledges, and stops nothing: there is no running turn to stop.
    async interrupt() { return { still_queued: [] }; },
    close() { closed = true; wake?.(); wake = null; },
    [Symbol.asyncIterator]() { return this; },
    async next() {
      while (!out.length && !closed) await new Promise(resolve => { wake = resolve; });
      return out.length ? { value: out.shift(), done: false } : { done: true };
    },
  };
}

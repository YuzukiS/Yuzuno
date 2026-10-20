import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue, briefReceiptKind, compatibility, locateExecutable, runtimeProvenance, sdkFacts, sessionPermissions, supportsThinkingDisplay } from './bridge.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(extra = {}, start = {}) {
  const output = new PromptQueue();
  const events = [];
  const state = { interrupts: 0, closed: false, models: [] };
  output.initializationResult = async () => ({});
  output.setMcpServers = async servers => { output.servers = servers; return {added: ['yuzuno'], removed: [], errors: {}}; };
  output.interrupt = async () => { state.interrupts++; };
  output.supportedModels = async () => state.models;
  output.setModel = async model => { state.selectedModel = model; };
  output.setPermissionMode = async mode => { state.permissionMode = mode; };
  output.applyFlagSettings = async settings => { (state.flags ??= []).push(settings); };
  output.close = () => { state.closed = true; PromptQueue.prototype.close.call(output); };
  const bridge = new ClaudeBridge({
    query: ({ prompt, options }) => { Object.assign(state, { prompt, options }); return output; },
    emit: event => events.push(event), resolveCli: () => '/native/claude', ...extra,
  });
  await bridge.handle({ id: 'start', op: 'start', cwd: process.cwd(), ...start });
  return { bridge, state, events, output, response: id => events.find(e => e.type === 'response' && e.id === id) };
}

const mailboxFixture = extra => fixture(extra, {
  collaborationMcp: { url: 'http://127.0.0.1:4379/mcp/test-agent', headers: { Authorization: 'Bearer fixture-only' } },
});
const notice = (id, extra = {}) => ({ id, op: 'notify_mailbox', expectedTurnId: 'turn1', clientMessageId: id,
  text: 'Yuzuno mailbox: use peer_read with priority=urgent. This is a notification, not a user answer.', ...extra });
const hook = (f, name, input = {}, context = {}) => f.state.options.hooks[name].at(-1).hooks[0](
  { hook_event_name: name, session_id: 'session1', ...input }, 'tool1', context);

// Frames as CLI 2.1.280 sends them: a prompt's uuid on its turn's first reply
// and result, a non-human origin on a turn Claude runs on its own.
const SESSION = 'session1';
const init = uuid => ({ type: 'system', subtype: 'init', uuid, session_id: SESSION,
  capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] });
const lifecycle = (prompt, state) => ({ type: 'command_lifecycle', uuid: `${state}-${prompt}`, command_uuid: prompt, state, session_id: SESSION });
const stamp = prompt => (prompt ? { user_message_uuid: prompt, user_message_uuids: [prompt] } : {});
const reply = (uuid, content, prompt) => ({ type: 'assistant', uuid, session_id: SESSION, parent_tool_use_id: null,
  message: { id: `msg-${uuid}`, role: 'assistant', content }, ...stamp(prompt) });
const text = (uuid, value, prompt) => reply(uuid, [{ type: 'text', text: value }], prompt);
const toolCall = (uuid, tool, prompt) => reply(uuid, [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'ls' } }], prompt);
const result = (uuid, extra = {}) => ({ type: 'result', subtype: 'success', uuid, session_id: SESSION, is_error: false,
  duration_ms: 5, num_turns: 1, result: '', ...extra });
const notified = { origin: { kind: 'task-notification' } };
const feed = async (f, ...frames) => { for (const frame of frames) f.output.push(frame); await tick(); };
const routed = f => f.events.filter(e => e.type === 'event').map(e => [e.event.uuid, e.turnId]);
const sendPrompt = async (f, turnId) => {
  await f.bridge.handle({ id: turnId, op: 'send', turnId, text: `prompt of ${turnId}` });
  return (await f.state.prompt.next()).value.uuid;
};
// The prompt in flight's first reply (with this tool call) and its result.
const answering = (f, tool) => (tool ? toolCall(`call-${tool}`, tool, f.bridge.promptUuid)
  : text(`reply-${f.bridge.promptUuid}`, 'Working on it.', f.bridge.promptUuid));
const answered = (f, extra = {}) => result(`result-${f.bridge.promptUuid}`, { ...stamp(f.bridge.promptUuid), ...extra });

test('mailbox registers official hooks only for collaboration and preserves existing hooks', async () => {
  const existing = { hooks: [() => ({})] };
  const f = await mailboxFixture({ options: { hooks: { PostToolUse: [existing], Stop: [existing] } } });
  assert.equal(f.state.options.hooks.PostToolUse[0], existing);
  // Stop keeps its existing hooks first; only the effort observer follows.
  assert.equal(f.state.options.hooks.Stop.length, 2);
  assert.equal(f.state.options.hooks.Stop[0], existing);
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch']) {
    assert.equal(typeof f.state.options.hooks[event].at(-1).hooks[0], 'function');
  }
  assert.equal(f.state.options.hooks.PermissionRequest, undefined);
  f.bridge.close(); await f.bridge.reader;
  const disabled = await fixture();
  await disabled.bridge.handle(notice('unavailable'));
  assert.match(disabled.response('unavailable').error, /not available/);
  disabled.bridge.close(); await disabled.bridge.reader;
});

test('Core\'s capability notice joins the collaboration append once and only with collaboration', async () => {
  const collaborationMcp = { url: 'http://127.0.0.1:4379/mcp/test-agent', headers: { Authorization: 'Bearer fixture-only' } };
  const plain = await fixture({}, { collaborationMcp });
  const base = plain.state.options.systemPrompt.append;
  assert.equal(plain.state.options.systemPrompt.preset, 'claude_code');
  plain.bridge.close(); await plain.bridge.reader;
  const noticed = await fixture({}, { collaborationMcp, capabilityNotice: 'Yuzuno can show tables.' });
  assert.deepEqual(noticed.state.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: `${base} Yuzuno can show tables.` });
  noticed.bridge.close(); await noticed.bridge.reader;
  for (const start of [{ capabilityNotice: 'No collaboration' }, { collaborationMcp, capabilityNotice: 'x'.repeat(2001) },
    { collaborationMcp, capabilityNotice: 7 }]) {
    const rejected = await fixture({}, start);
    assert.match(rejected.response('start').error, /capability notice/);
    rejected.bridge.close(); await rejected.bridge.reader;
  }
});

test('urgent mailbox context reaches one native tool boundary without another prompt or turn', async () => {
  const f = await mailboxFixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'continue work' });
  await f.state.prompt.next();
  let nextInput = false;
  const waiting = f.state.prompt.next().then(result => { nextInput = !result.done; });
  await f.bridge.handle(notice('mail1'));
  assert.deepEqual(f.response('mail1').result, { queued: true, turnId: 'turn1', mode: 'hook' });
  assert.equal(f.events.some(event => event.type === 'mailbox_delivery'), false);
  // Only a boundary in the prompt's own turn, once its uuid named it.
  assert.deepEqual(hook(f, 'PostToolUse'), {});
  await feed(f, answering(f, 'tool1'));
  const result = hook(f, 'PostToolUse', { tool_use_id: 'tool1' });
  assert.equal(result.hookSpecificOutput.additionalContext, notice('mail1').text);
  assert.deepEqual(hook(f, 'PostToolUseFailure'), {});
  assert.deepEqual(hook(f, 'PostToolBatch'), {});
  await tick();
  assert.equal(nextInput, false);
  assert.equal(f.bridge.turnId, 'turn1');
  assert.equal(f.state.interrupts, 0);
  assert.deepEqual(f.events.filter(event => event.type === 'mailbox_delivery'), [{
    type: 'mailbox_delivery', turnId: 'turn1', clientMessageId: 'mail1', status: 'injected', hookEvent: 'PostToolUse',
  }]);
  f.bridge.close(); await waiting; await f.bridge.reader;
});

test('mailbox waits through approval and ignores subagents, stale sessions and cancelled hooks', async () => {
  const f = await mailboxFixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'work' });
  await feed(f, init('init'), answering(f));
  await f.bridge.handle(notice('mail1'));
  assert.deepEqual(hook(f, 'PostToolUse', { agent_id: 'subagent' }), {});
  assert.deepEqual(hook(f, 'PostToolUse', { session_id: 'old-session' }), {});
  assert.deepEqual(hook(f, 'PostToolUseFailure', { is_interrupt: true }), {});
  assert.deepEqual(hook(f, 'PostToolBatch', {}, { signal: AbortSignal.abort() }), {});
  const original = { command: 'run requested work' };
  let answered = false;
  const decision = f.state.options.canUseTool('Bash', original, { signal: new AbortController().signal })
    .then(value => { answered = true; return value; });
  const permission = f.events.find(event => event.type === 'permission');
  assert.deepEqual(hook(f, 'PostToolUse'), {});
  await tick();
  assert.equal(answered, false);
  assert.equal(f.bridge.pending.size, 1);
  assert.equal(f.events.some(event => event.type === 'mailbox_delivery'), false);
  await f.bridge.handle({ id: 'user', op: 'respond', requestId: permission.requestId, decision: 'allow' });
  assert.deepEqual(await decision, { behavior: 'allow', updatedInput: original });
  assert.equal(hook(f, 'PostToolUseFailure').hookSpecificOutput.additionalContext, notice('mail1').text);
  f.bridge.close(); await f.bridge.reader;
});

test('mailbox coalesces only the same request and never replaces a pending batch', async () => {
  const f = await mailboxFixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'work' });
  await feed(f, answering(f));
  await f.bridge.handle(notice('mail1'));
  await f.bridge.handle(notice('same', { clientMessageId: 'mail1' }));
  assert.equal(f.response('same').result.queued, true);
  await f.bridge.handle(notice('different', { clientMessageId: 'mail1', text: 'changed content' }));
  assert.match(f.response('different').error, /different content/);
  await f.bridge.handle(notice('mail2', { text: 'second distinct batch' }));
  assert.deepEqual(f.response('mail2').result, { queued: false, turnId: 'turn1', mode: 'hook', reason: 'busy' });
  assert.equal(hook(f, 'PostToolBatch').hookSpecificOutput.additionalContext, notice('mail1').text);
  await f.bridge.handle(notice('retry2', { clientMessageId: 'mail2', text: 'second distinct batch' }));
  assert.equal(hook(f, 'PostToolBatch').hookSpecificOutput.additionalContext, 'second distinct batch');
  assert.equal(f.events.filter(event => event.type === 'mailbox_delivery').length, 2);
  f.bridge.close(); await f.bridge.reader;
});

test('turn completion defers an unconsumed mailbox notice and late notifications cannot start a turn', async () => {
  const f = await mailboxFixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'work without tools' });
  await f.bridge.handle(notice('mail1'));
  await feed(f, answered(f));
  const receipt = f.events.findIndex(event => event.type === 'mailbox_delivery');
  const result = f.events.findIndex(event => event.type === 'event' && event.event.type === 'result');
  assert.equal(f.events[receipt].status, 'deferred');
  assert.ok(receipt < result);
  assert.equal(f.bridge.turnId, null);
  await f.bridge.handle(notice('late'));
  assert.match(f.response('late').error, /stale turn/);
  await f.bridge.handle({ id: 'next', op: 'send', turnId: 'turn2', text: 'actual user followup' });
  assert.deepEqual(hook(f, 'PostToolUse'), {});
  assert.equal(f.bridge.turnId, 'turn2');
  assert.equal(f.events.filter(event => event.type === 'mailbox_delivery').length, 1);
  f.bridge.close(); await f.bridge.reader;
});

test('closing or interrupting preserves native control and never injects a pending notice afterward', async () => {
  const f = await mailboxFixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'work' });
  await f.bridge.handle(notice('mail1'));
  let finishInterrupt;
  f.output.interrupt = () => new Promise(resolve => { finishInterrupt = resolve; });
  const stopping = f.bridge.handle({ id: 'interrupt', op: 'interrupt' });
  assert.deepEqual(hook(f, 'PostToolUse'), {});
  await f.bridge.handle(notice('while-stopping'));
  assert.match(f.response('while-stopping').error, /still being acknowledged/);
  f.bridge.close();
  assert.deepEqual(hook(f, 'PostToolBatch'), {});
  finishInterrupt(); await stopping; await f.bridge.reader;
  assert.deepEqual(f.events.filter(event => event.type === 'mailbox_delivery'), [{
    type: 'mailbox_delivery', turnId: 'turn1', clientMessageId: 'mail1', status: 'deferred',
  }]);
  await f.bridge.handle(notice('closed'));
  assert.match(f.response('closed').error, /closed/);
});

test('starts the official persistent query with native manual permissions and explicit settings', async () => {
  const f = await fixture();
  assert.equal(f.response('start').result.started, true);
  assert.equal(f.state.options.pathToClaudeCodeExecutable, '/native/claude');
  assert.equal(f.state.options.permissionMode, 'default');
  assert.deepEqual(f.state.options.settingSources, ['user', 'project', 'local']);
  assert.equal(f.state.options.persistSession, true);
  assert.equal(f.state.options.includePartialMessages, true);
  assert.equal(f.state.options.env, undefined);
  f.bridge.close();
  await f.bridge.reader;
  assert.equal(f.state.closed, true);
});

test('send acknowledges enqueue, rejects overlap, and preserves turn identity through result', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'send1', op: 'send', turnId: 'turn1', text: 'hello' });
  const input = await f.state.prompt.next();
  assert.equal(input.value.message.content, 'hello');
  assert.equal(f.response('send1').result.queued, true);
  // Claude saves the prompt under the uuid it was sent with (T-22).
  assert.equal(f.response('send1').result.uuid, input.value.uuid);
  await f.bridge.handle({ id: 'send2', op: 'send', turnId: 'turn2', text: 'must not queue' });
  assert.match(f.response('send2').error, /already running/);
  assert.equal(input.value.uuid, f.bridge.promptUuid);
  await feed(f, answered(f, { session_id: 'native-session' }));
  assert.equal(f.events.find(e => e.type === 'event').turnId, 'turn1');
  await f.bridge.handle({ id: 'send3', op: 'send', turnId: 'turn3', text: 'follow-up' });
  assert.equal((await f.state.prompt.next()).value.session_id, 'native-session');
  f.bridge.close();
  await f.bridge.reader;
});

test('native cancellation revokes pending approval and rejects a delayed UI response', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'do work' });
  await feed(f, answering(f, 'tool1'));
  const controller = new AbortController();
  const decision = f.state.options.canUseTool('Bash', { command: 'echo hi' }, { signal: controller.signal, toolUseID: 'tool1' });
  const permission = f.events.find(e => e.type === 'permission');
  assert.equal(permission.toolUseId, 'tool1');
  controller.abort();
  assert.equal((await decision).behavior, 'deny');
  assert.equal(f.events.filter(e => e.type === 'permission_cancelled').length, 1);
  await f.bridge.handle({ id: 'late', op: 'respond', requestId: permission.requestId, decision: 'allow' });
  assert.match(f.response('late').error, /stale/);
  f.bridge.close();
  await f.bridge.reader;
});

test('question answers preserve original input and approval cannot mutate a command', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'do work' });
  await feed(f, answering(f));
  const controller = new AbortController();
  const input = { questions: [{ question: 'Choose?', options: [{ label: 'A' }], multiSelect: false }] };
  const result = f.state.options.canUseTool('AskUserQuestion', input, { signal: controller.signal });
  const { requestId } = f.events.find(e => e.type === 'permission');
  await f.bridge.handle({ id: 'wrong', op: 'respond', requestId, decision: 'allow', updatedInput: { questions: [], answers: { 'Choose?': 'A' } } });
  assert.match(f.response('wrong').error, /only add answers/);
  await f.bridge.handle({ id: 'right', op: 'respond', requestId, decision: 'allow', updatedInput: { ...input, answers: { 'Choose?': 'A' } } });
  assert.deepEqual((await result).updatedInput.answers, { 'Choose?': 'A' });
  const commandDecision = f.state.options.canUseTool('Bash', { command: 'echo hi' }, { signal: controller.signal });
  const commandRequest = f.events.filter(e => e.type === 'permission').at(-1);
  await f.bridge.handle({ id: 'changed', op: 'respond', requestId: commandRequest.requestId, decision: 'allow', updatedInput: { command: 'rm -rf /' } });
  assert.match(f.response('changed').error, /cannot be changed/);
  await f.bridge.handle({ id: 'deny', op: 'respond', requestId: commandRequest.requestId, decision: 'deny' });
  assert.equal((await commandDecision).behavior, 'deny');
  f.bridge.close();
  await f.bridge.reader;
});

test('interrupt cancels approvals but stays busy until native result and keeps query open', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'do work' });
  await feed(f, answering(f));
  const decision = f.state.options.canUseTool('Write', { file_path: 'x', content: 'x' }, { signal: new AbortController().signal });
  await f.bridge.handle({ id: 'stop', op: 'interrupt' });
  assert.equal((await decision).interrupt, true);
  assert.equal(f.state.interrupts, 1);
  assert.equal(f.state.closed, false);
  assert.equal(f.bridge.turnId, 'turn1');
  // As recorded: the interrupted turn's result carries the prompt's uuid.
  await feed(f, answered(f, { subtype: 'error_during_execution', is_error: true }));
  assert.equal(f.bridge.turnId, null);
  f.bridge.close();
  await f.bridge.reader;
});

test('stop_task stops only the named task, leaving the turn, and says nothing about whether it stopped', async () => {
  const f = await fixture();
  const stopped = [];
  f.output.stopTask = async taskId => { stopped.push(taskId); };
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'do work' });
  await feed(f, answering(f));
  await f.bridge.handle({ id: 'stop1', op: 'stop_task', taskId: 'bownir676' });
  assert.deepEqual(f.response('stop1').result, { requested: true });
  assert.deepEqual(stopped, ['bownir676']);
  assert.equal(f.state.interrupts, 0, 'never an interrupt');
  assert.equal(f.bridge.turnId, 'turn1', 'the turn goes on');
  for (const [id, taskId] of [['bad1', '../x'], ['bad2', ''], ['bad3', 7], ['bad4', 'x'.repeat(129)]]) {
    await f.bridge.handle({ id, op: 'stop_task', taskId });
    assert.equal(f.response(id).error, 'Invalid task id');
  }
  f.output.stopTask = async () => { throw new Error('stop refused'); };
  await f.bridge.handle({ id: 'stop2', op: 'stop_task', taskId: 'b4b36jo7p' });
  assert.match(f.response('stop2').error, /stop refused/);
  delete f.output.stopTask;
  await f.bridge.handle({ id: 'stop3', op: 'stop_task', taskId: 'b4b36jo7p' });
  assert.equal(f.response('stop3').error, 'This Claude Agent SDK cannot stop a single task');
  assert.deepEqual(stopped, ['bownir676']);
  f.bridge.close();
  await f.bridge.reader;
});

test('initialization failure closes the owned query and does not report ready', async () => {
  const output = new PromptQueue();
  let closed = false;
  output.initializationResult = async () => { throw new Error('CLI incompatible'); };
  output.close = () => { closed = true; PromptQueue.prototype.close.call(output); };
  const events = [];
  const bridge = new ClaudeBridge({ query: () => output, resolveCli: () => '/native/claude', emit: event => events.push(event) });
  await bridge.handle({ id: 'start', op: 'start', cwd: process.cwd() });
  await bridge.reader;
  assert.equal(closed, true);
  assert.match(events.find(e => e.type === 'response').error, /incompatible/);
  assert.equal(events.filter(e => e.type === 'exit').length, 1);
});

test('a delayed interrupt acknowledgement cannot interrupt a newly submitted turn', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'do work' });
  let acknowledge;
  f.output.interrupt = () => new Promise(resolve => { acknowledge = resolve; });
  const interrupt = f.bridge.handle({ id: 'interrupt', op: 'interrupt' });
  await feed(f, answered(f));
  await f.bridge.handle({ id: 'early', op: 'send', turnId: 'turn2', text: 'follow-up' });
  assert.match(f.response('early').error, /still being acknowledged/);
  acknowledge();
  await interrupt;
  await f.bridge.handle({ id: 'later', op: 'send', turnId: 'turn2', text: 'follow-up' });
  assert.equal(f.response('later').result.queued, true);
  f.bridge.close();
  await f.bridge.reader;
});

test('malformed command objects report errors and leave the runtime usable', async () => {
  const f = await fixture();
  await f.bridge.handle(null);
  assert.match(f.events.at(-1).error, /id is required/);
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'hello' });
  assert.equal(f.response('send').result.queued, true);
  f.bridge.close();
  await f.bridge.reader;
});

test('model catalog comes from native SDK metadata without sending a prompt', async () => {
  const f = await fixture();
  f.state.models = [{ value: 'native-alias', displayName: 'Native model', description: 'From this CLI', resolvedModel: 'native-version', supportsEffort: true }];
  await f.bridge.handle({ id: 'models', op: 'models' });
  assert.deepEqual(f.response('models').result, { source: 'claude-agent-sdk', models: [{ id: 'native-alias', model: 'native-alias', displayName: 'Native model', description: 'From this CLI', resolvedModel: 'native-version', supportsEffort: true, supportedEffortLevels: [] }] });
  assert.equal(f.bridge.turnId, null);
  assert.equal(f.events.some(e => e.type === 'event'), false);
  f.bridge.close();
  await f.bridge.reader;
});

test('catalog-only query disables persistence and rejects accidental prompts', async () => {
  const output = new PromptQueue();
  output.initializationResult = async () => ({});
  output.setMcpServers = async servers => { output.servers = servers; return {added: ['yuzuno'], removed: [], errors: {}}; };
  output.close = () => PromptQueue.prototype.close.call(output);
  let nativeOptions;
  const events = [];
  const bridge = new ClaudeBridge({ query: ({ options }) => { nativeOptions = options; return output; }, resolveCli: () => '/native/claude', emit: event => events.push(event) });
  await bridge.handle({ id: 'catalog', op: 'start', cwd: process.cwd(), catalogOnly: true });
  assert.equal(nativeOptions.persistSession, false);
  assert.equal(nativeOptions.resume, undefined);
  await bridge.handle({ id: 'accidental', op: 'send', turnId: 'turn', text: 'do not send' });
  assert.match(events.find(e => e.id === 'accidental').error, /cannot accept prompts/);
  bridge.close();
  await bridge.reader;
});

test('model changes wait between turns, preserve query and session, and reset native default', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'first', op: 'send', turnId: 'one', text: 'first' });
  await f.bridge.handle({ id: 'too-early', op: 'set_model', model: 'native-second' });
  assert.match(f.response('too-early').error, /current turn finishes/);
  assert.equal(f.state.selectedModel, undefined);
  await feed(f, answered(f, { session_id: 'same-native-session' }));
  await f.bridge.handle({ id: 'change', op: 'set_model', model: 'native-second' });
  assert.equal(f.state.selectedModel, 'native-second');
  assert.equal(f.bridge.sessionId, 'same-native-session');
  assert.equal(f.state.closed, false);
  await f.bridge.handle({ id: 'default', op: 'set_model', model: '' });
  assert.equal(f.state.selectedModel, undefined);
  assert.equal(f.bridge.model, '');
  f.bridge.close();
  await f.bridge.reader;
});

test('permission mode starts or resumes as requested and changes live, even mid-turn', async () => {
  const output = new PromptQueue();
  output.initializationResult = async () => ({});
  output.setMcpServers = async servers => { output.servers = servers; return {added: ['yuzuno'], removed: [], errors: {}}; };
  output.close = () => PromptQueue.prototype.close.call(output);
  let nativeOptions;
  const events = [];
  const bridge = new ClaudeBridge({ query: ({ options }) => { nativeOptions = options; return output; }, resolveCli: () => '/native/claude', emit: event => events.push(event) });
  await bridge.handle({ id: 'bypass', op: 'start', cwd: process.cwd(), permissionMode: 'bypassPermissions' });
  assert.match(events.find(e => e.id === 'bypass').error, /Invalid permission mode/);
  assert.equal(nativeOptions, undefined);
  await bridge.handle({ id: 'auto', op: 'start', cwd: process.cwd(), permissionMode: 'auto' });
  assert.equal(nativeOptions.permissionMode, 'auto');
  bridge.close();
  await bridge.reader;

  const f = await fixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'do work' });
  await f.bridge.handle({ id: 'auto', op: 'set_permission_mode', permissionMode: 'auto' });
  assert.deepEqual(f.response('auto').result, { configured: true, permissionMode: 'auto' });
  assert.equal(f.state.permissionMode, 'auto');
  await f.bridge.handle({ id: 'dont', op: 'set_permission_mode', permissionMode: 'dontAsk' });
  assert.match(f.response('dont').error, /Invalid permission mode/);
  assert.equal(f.state.permissionMode, 'auto');
  f.output.setPermissionMode = async () => { throw new Error('Auto mode unavailable'); };
  await f.bridge.handle({ id: 'rejected', op: 'set_permission_mode', permissionMode: 'default' });
  assert.match(f.response('rejected').error, /unavailable/);
  assert.equal(f.bridge.turnId, 'turn1');
  f.bridge.close();
  await f.bridge.reader;
});

test('start requests summarized thinking and reports display-only account facts', async () => {
  const output = new PromptQueue();
  output.initializationResult = async () => ({
    claude_code_version: '2.1.280',
    account: { email: 'person@example.com', subscriptionType: 'max', tokenSource: 'claude.ai', apiKeySource: 'none', organization: '' },
  });
  output.close = () => PromptQueue.prototype.close.call(output);
  let nativeOptions;
  const events = [];
  const bridge = new ClaudeBridge({
    query: ({ options }) => { nativeOptions = options; return output; }, resolveCli: () => '/native/claude',
    version: async () => [2, 1, 280],
    emit: event => events.push(event), options: { settings: { permissions: { ask: ['Bash'] } } },
  });
  await bridge.handle({ id: 'start', op: 'start', cwd: process.cwd() });
  // Display only: the user's own configuration still decides whether to think.
  assert.equal(nativeOptions.thinking, undefined);
  assert.deepEqual(nativeOptions.extraArgs, { 'thinking-display': 'summarized' });
  assert.deepEqual(nativeOptions.settings, { permissions: { ask: ['Bash'] } });
  // A CLI older than the verified one, or of unknown version, never gets an
  // option it might reject at startup.
  assert.equal(supportsThinkingDisplay([2, 1, 279]), false);
  assert.equal(supportsThinkingDisplay([2, 2, 0]), true);
  assert.equal(supportsThinkingDisplay(null), false);
  const started = events.find(e => e.id === 'start').result;
  assert.deepEqual(started.account, { email: 'person@example.com', subscriptionType: 'max' });
  assert.equal(started.version, '2.1.280');
  // The version Claude Code reported wins over the probe; the SDK's facts
  // come from the pinned package, whose built-in CLI never runs here.
  assert.deepEqual(started.provenance, { cli: { path: '/native/claude', version: '2.1.280', versionSource: 'init' },
    sdk: { version: '0.3.296', builtInCli: '2.1.296' }, compatibility: 'verified' });
  bridge.close();
  await bridge.reader;
});

test('the executable is found on PATH or named, with the file that matched and its real path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuzuno-cli-'));
  const saved = process.env.PATH;
  try {
    const install = join(dir, 'install');
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    for (const d of [install, first, second]) mkdirSync(d);
    writeFileSync(join(install, 'claude.exe'), '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync(join(install, 'claude.exe'), join(first, 'claude'));
    writeFileSync(join(second, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(dir, 'not-executable'), '', { mode: 0o644 });
    process.env.PATH = [join(dir, 'missing'), first, second].join(':');
    assert.deepEqual(locateExecutable(), { path: join(install, 'claude.exe'), found: join(first, 'claude'), source: 'path' });
    // PATH changed: another install is found, and says so.
    process.env.PATH = [second, first].join(':');
    assert.deepEqual(locateExecutable(), { path: join(second, 'claude'), found: join(second, 'claude'), source: 'path' });
    assert.deepEqual(locateExecutable(join(first, 'claude')), { path: join(install, 'claude.exe'), found: join(first, 'claude'), source: 'explicit' });
    process.env.PATH = dir;
    assert.throws(() => locateExecutable(), /Claude executable not found/);
    assert.throws(() => locateExecutable(join(dir, 'not-executable')), /Claude executable not found/);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a host that scripts its SDK states its facts, and the bridge checks the CLI against them, not the install', async () => {
  const f = await fixture({ sdk: { version: '9.9.9' }, version: async () => '2.1.280' });
  assert.deepEqual(f.response('start').result.provenance, { cli: { path: '/native/claude', version: '2.1.280', versionSource: '--version' },
    sdk: { version: '9.9.9' }, compatibility: 'unverified' });
  f.bridge.close();
  await f.bridge.reader;
});

test('SDK facts come from its package and manifest; a missing file is unknown, not guessed', () => {
  assert.deepEqual(sdkFacts(), { version: '0.3.296', builtInCli: '2.1.296' });
  const dir = mkdtempSync(join(tmpdir(), 'yuzuno-sdk-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    assert.deepEqual(sdkFacts(() => join(dir, 'sdk.mjs')), { version: '9.9.9' });
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    assert.deepEqual(sdkFacts(() => join(dir, 'sdk.mjs')), { version: '9.9.9' });
    assert.deepEqual(sdkFacts(() => { throw new Error('not installed'); }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CLI version is built-in, verified, older, unverified or unknown, and nothing else decides it', () => {
  const sdk = { version: '0.3.296', builtInCli: '2.1.296' };
  assert.equal(compatibility(sdk, '2.1.296'), 'built-in');
  assert.equal(compatibility(sdk, '2.1.280'), 'verified');
  assert.equal(compatibility(sdk, '2.1.279'), 'older');
  assert.equal(compatibility(sdk, '1.9.999'), 'older');
  // Between or past the known versions: not older, but not checked either.
  assert.equal(compatibility(sdk, '2.1.290'), 'unverified');
  assert.equal(compatibility(sdk, '2.10.0'), 'unverified');
  assert.equal(compatibility(sdk, undefined), 'unknown');
  // Another SDK has no checked list here; only its own built-in version counts.
  assert.equal(compatibility({ version: '0.4.0', builtInCli: '2.2.0' }, '2.1.280'), 'older');
  assert.equal(compatibility({}, '2.1.280'), 'unverified');

  const cli = { path: '/opt/claude/claude.exe', found: '/usr/local/bin/claude', source: 'path' };
  assert.deepEqual(runtimeProvenance(cli, undefined, [2, 1, 279], sdk), { cli: { ...cli, version: '2.1.279', versionSource: '--version' }, sdk, compatibility: 'older' });
  assert.deepEqual(runtimeProvenance(cli, '2.1.296', [2, 1, 280], sdk).cli, { ...cli, version: '2.1.296', versionSource: 'init' });
  assert.deepEqual(runtimeProvenance({ path: '/x' }, 'nightly', null, sdk), { cli: { path: '/x' }, sdk, compatibility: 'unknown' });
});

test('a startup failure names the Claude Code it ran and the SDK', async () => {
  const output = new PromptQueue();
  output.initializationResult = async () => { throw new Error('Claude Code process exited with code 1'); };
  output.close = () => PromptQueue.prototype.close.call(output);
  const events = [];
  const bridge = new ClaudeBridge({
    query: () => output, emit: event => events.push(event), version: async () => [2, 0, 5],
    resolveCli: () => ({ path: '/opt/old/claude', found: '/home/u/bin/claude', source: 'path' }),
  });
  await bridge.handle({ id: 'start', op: 'start', cwd: process.cwd() });
  assert.equal(events.find(e => e.id === 'start').error, 'Claude Code process exited with code 1 (Claude Code 2.0.5 at /opt/old/claude (found on PATH as /home/u/bin/claude); Agent SDK 0.3.296, built with Claude Code 2.1.296)');
});

test('session approval echoes only Claude suggestions, narrowed to the session', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'do work' });
  await feed(f, answering(f));
  const signal = new AbortController().signal;
  // As observed from the real CLI for `touch a.txt`: a command rule, a
  // directory and an accept-edits mode. Approving the command must not also
  // switch the whole session to accept edits.
  const suggestions = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    { type: 'addDirectories', directories: ['/tmp/x'], destination: 'projectSettings' },
  ];
  assert.deepEqual(sessionPermissions([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
    [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  // An edit outside the folder: directory plus accept edits, as Claude Code's
  // own "allow all edits in this folder for the session" applies.
  assert.deepEqual(sessionPermissions([
    { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]).map(update => update.type), ['addDirectories', 'setMode']);
  const decision = f.state.options.canUseTool('Bash', { command: 'npm test' }, { signal, suggestions });
  const { requestId, sessionPermissions: offered } = f.events.find(e => e.type === 'permission');
  // The permission event carries the one list Core validates and the GUI shows.
  assert.deepEqual(offered.map(update => update.type), ['addRules', 'addDirectories']);
  await f.bridge.handle({ id: 'deny-session', op: 'respond', requestId, decision: 'deny', scope: 'session' });
  assert.match(f.response('deny-session').error, /Only an approval/);
  await f.bridge.handle({ id: 'session', op: 'respond', requestId, decision: 'allow', scope: 'session' });
  const result = await decision;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' },
    { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' },
  ]);

  const bare = f.state.options.canUseTool('Bash', { command: 'ls' }, { signal });
  const bareRequest = f.events.filter(e => e.type === 'permission').at(-1);
  await f.bridge.handle({ id: 'none', op: 'respond', requestId: bareRequest.requestId, decision: 'allow', scope: 'session' });
  assert.match(f.response('none').error, /no session permission/);
  await f.bridge.handle({ id: 'long', op: 'respond', requestId: bareRequest.requestId, decision: 'deny', message: 'x'.repeat(2001) });
  assert.match(f.response('long').error, /at most 2000 bytes/);
  await f.bridge.handle({ id: 'reason', op: 'respond', requestId: bareRequest.requestId, decision: 'deny', message: '  Use git status instead  ' });
  assert.deepEqual(await bare, { behavior: 'deny', message: 'The user declined this action: Use git status instead' });
  f.bridge.close();
  await f.bridge.reader;
});

test('failed or pending model controls cannot enqueue the next prompt', async () => {
  const f = await fixture();
  let reject;
  f.output.setModel = () => new Promise((_, rejectModel) => { reject = rejectModel; });
  const changing = f.bridge.handle({ id: 'change', op: 'set_model', model: 'unavailable' });
  await f.bridge.handle({ id: 'during', op: 'send', turnId: 'turn', text: 'do not enqueue' });
  assert.match(f.response('during').error, /still being acknowledged/);
  assert.equal(f.bridge.turnId, null);
  reject(new Error('Native model rejected'));
  await changing;
  assert.match(f.response('change').error, /Native model rejected/);
  assert.equal(f.bridge.model, '');
  assert.equal(f.bridge.configuring, false);
  f.bridge.close();
  await f.bridge.reader;
});

test('Workspace MCP is scoped to this query and does not relax other tool permissions', async () => {
  const output = new PromptQueue();
  output.initializationResult = async () => ({});
  output.setMcpServers = async servers => { output.servers = servers; return {added: ['yuzuno'], removed: [], errors: {}}; };
  output.close = () => PromptQueue.prototype.close.call(output);
  let options;
  const bridge = new ClaudeBridge({
    query: value => { options = value.options; return output; },
    emit: () => {}, resolveCli: () => '/native/claude',
  });
  await bridge.handle({id:'start',op:'start',cwd:process.cwd(),collaborationMcp:{url:'http://127.0.0.1:4999/mcp/a',headers:{Authorization:'Bearer test-only'}}});
  assert.equal(options.mcpServers?.yuzuno, undefined);
  assert.equal(output.servers.yuzuno.type,'http');
  assert.equal(output.servers.yuzuno.url,'http://127.0.0.1:4999/mcp/a');
  assert.deepEqual(options.allowedTools,['mcp__yuzuno__*']);
  assert.equal(options.permissionMode,'default');
  assert.equal(typeof options.canUseTool,'function');
  bridge.close();
  await bridge.reader;
});

test('update status is read-only and distinguishes idle, working, approval and native control', async () => {
  const f = await fixture();
  const status = async (id) => {
    await f.bridge.handle({ id, op: 'status' });
    return f.response(id).result;
  };
  try {
    const idle = await status('idle');
    assert.equal(idle.ready, true);
    assert.equal(idle.turnId, null);
    assert.equal(idle.pendingCount, 0);
    assert.equal(idle.configuring, false);
    assert.equal(idle.interrupting, false);
    await f.bridge.handle({ id: 'send', op: 'send', turnId: 'one', text: 'explicit test prompt' });
    await f.state.prompt.next();
    assert.equal((await status('working')).turnId, 'one');
    await feed(f, answering(f));
    const approval = f.state.options.canUseTool('Bash', { command: 'fixture' }, { signal: new AbortController().signal });
    assert.equal((await status('approval')).pendingCount, 1);
    assert.equal(f.state.interrupts, 0);
    const request = f.events.find(e => e.type === 'permission');
    await f.bridge.handle({ id: 'answer', op: 'respond', requestId: request.requestId, decision: 'deny' });
    await approval;
    await feed(f, answered(f, { session_id: 'same-session' }));
    const completed = await status('completed');
    assert.equal(completed.turnId, null);
    assert.equal(completed.sessionId, 'same-session');
    assert.equal(completed.pendingCount, 0);
    // Claude continuing on its own after a background task is work too.
    await feed(f, init('own'), text('continuing', 'The task finished.'));
    assert.deepEqual([(await status('own')).turnId, (await status('own2')).nativeTurnId], ['native-own', 'native-own']);
    await feed(f, result('own-result', { ...notified, session_id: 'same-session' }));
    assert.equal((await status('idle again')).turnId, null);
    let confirm;
    f.output.setModel = () => new Promise(resolve => { confirm = resolve; });
    const configuring = f.bridge.handle({ id: 'model', op: 'set_model', model: 'fixture' });
    await tick();
    assert.equal((await status('configuring')).configuring, true);
    confirm(); await configuring;
    assert.equal((await status('configured')).configuring, false);
    assert.equal(f.state.interrupts, 0);
    assert.equal(f.state.closed, false);
  } finally { f.bridge.close(); await f.bridge.reader; }
});

test('a notice turn ahead of the prompt neither ends nor takes the prompt turn, and a later continuation is its own', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  // Recorded order (T-14 lab, resumed session): the stopped shell's notice
  // ran first as an empty turn, then the prompt, then a completed shell's
  // notice made Claude continue with no prompt in flight.
  await feed(f, lifecycle(prompt, 'queued'), init('init-a'));
  assert.deepEqual(routed(f), [[`queued-${prompt}`, null]], 'nothing names the open turn yet');
  await feed(f, result('result-a', { ...notified, num_turns: 0 }),
    lifecycle(prompt, 'started'), init('init-b'),
    { type: 'system', subtype: 'status', status: 'requesting', uuid: 'status-b', session_id: SESSION },
    text('reply-b', 'Started in the background.', prompt),
    result('result-b', { ...stamp(prompt), result: 'Started in the background.' }),
    lifecycle(prompt, 'completed'),
    { type: 'system', subtype: 'task_notification', status: 'completed', uuid: 'notice-c', session_id: SESSION },
    init('init-c'), text('reply-c', 'It finished.'), result('result-c', { ...notified, result: 'It finished.' }));
  // A session frame (status) never waits for the open turn's owner.
  assert.deepEqual(routed(f), [
    [`queued-${prompt}`, null], ['init-a', 'native-init-a'], ['result-a', 'native-init-a'],
    [`started-${prompt}`, null], ['status-b', null], ['init-b', 'turn1'], ['reply-b', 'turn1'], ['result-b', 'turn1'],
    [`completed-${prompt}`, null], ['notice-c', null],
    ['init-c', 'native-init-c'], ['reply-c', 'native-init-c'], ['result-c', 'native-init-c'],
  ]);
  assert.equal(f.events.find(e => e.event?.uuid === 'reply-c').nativeTurnId, 'native-init-c');
  assert.equal(f.bridge.turnId, null);
  // The next prompt is a turn of its own; the old prompt's uuid ends nothing.
  const next = await sendPrompt(f, 'turn2');
  await feed(f, init('init-d'), text('late-d', 'An old answer.', prompt), result('result-d', stamp(prompt)));
  assert.equal(f.bridge.turnId, 'turn2');
  await feed(f, init('init-e'), text('reply-e', 'Second.', next), result('result-e', stamp(next)));
  assert.deepEqual(routed(f).slice(-6), [['init-d', 'native-init-d'], ['late-d', 'native-init-d'], ['result-d', 'native-init-d'],
    ['init-e', 'turn2'], ['reply-e', 'turn2'], ['result-e', 'turn2']]);
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

test('a local command replies without the uuid; its result names the prompt (recorded /cost)', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, lifecycle(prompt, 'queued'), lifecycle(prompt, 'started'), init('init'),
    text('cost', 'You are currently using your subscription to power your Claude Code usage'));
  assert.equal(routed(f).length, 2, 'held: no frame names the turn yet');
  await feed(f, result('result', { ...stamp(prompt), num_turns: 0 }));
  assert.deepEqual(routed(f).slice(2), [['init', 'turn1'], ['cost', 'turn1'], ['result', 'turn1']]);
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

test('a session frame naming a prompt neither opens nor names a turn', async () => {
  const f = await fixture();
  // A /clear's conversation_reset between turns may carry the uuid; it is
  // the session's, so nothing runs: models can change and idle stays idle.
  await feed(f, { type: 'system', subtype: 'conversation_reset', uuid: 'reset', session_id: SESSION, ...stamp('cleared-prompt') });
  assert.deepEqual(routed(f), [['reset', null]]);
  await f.bridge.handle({ id: 'status', op: 'status' });
  assert.deepEqual([f.response('status').result.turnId, f.response('status').result.nativeTurnId], [null, null]);
  await f.bridge.handle({ id: 'model', op: 'set_model', model: 'claude-opus' });
  assert.equal(f.response('model').result.configured, true);
  // During a turn nothing yet names, it does not name it either.
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('turn'), { type: 'system', subtype: 'conversation_reset', uuid: 'reset-2', session_id: SESSION, ...stamp('other') },
    text('reply', 'Hi', prompt), result('result', stamp(prompt)));
  assert.deepEqual(routed(f).slice(1), [['reset-2', null], ['turn', 'turn1'], ['reply', 'turn1'], ['result', 'turn1']]);
  f.bridge.close(); await f.bridge.reader;
});

test('frames ahead of init and a repeated init stay in one turn', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f,
    { type: 'stream_event', uuid: 'start', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'msg-1' } }, ...stamp(prompt) },
    init('init-1'), init('init-again'),
    { type: 'stream_event', uuid: 'delta', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
    text('reply', 'Hi', prompt), result('result', stamp(prompt)));
  assert.deepEqual(routed(f), [['start', 'turn1'], ['init-1', 'turn1'], ['init-again', 'turn1'], ['delta', 'turn1'],
    ['reply', 'turn1'], ['result', 'turn1']]);
  assert.ok(f.events.filter(e => e.type === 'event').every(e => e.nativeTurnId === 'native-start'));
  f.bridge.close(); await f.bridge.reader;
});

test('a sub-agent opens no turn: one outliving its turn is the session\'s, still asks permission and splits no prompt', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  // Frames as recorded from CLI 2.1.280 (T-26 probe): a background sub-agent
  // names its Agent call as parent_tool_use_id, and its task events name it.
  const sub = (uuid, content) => ({ type: 'assistant', uuid, session_id: SESSION, parent_tool_use_id: 'agent-1',
    message: { id: `msg-${uuid}`, role: 'assistant', content } });
  const task = (uuid, subtype, extra) => ({ type: 'system', subtype, uuid, session_id: SESSION, task_id: 'task-1',
    tool_use_id: 'agent-1', ...extra });
  await feed(f, init('init'),
    reply('call', [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'Read c.txt', run_in_background: true } }], prompt),
    task('started', 'task_started', { task_type: 'local_agent', is_backgrounded: true }),
    sub('sub-1', [{ type: 'thinking', thinking: '' }]),
    result('result', stamp(prompt)));
  await feed(f, sub('sub-2', [{ type: 'tool_use', id: 'sub-tool', name: 'Bash', input: { command: 'ls' } }]));
  assert.equal(f.bridge.native, null, 'no turn of Claude\'s own opened for it');
  const approval = f.state.options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'sub-tool' });
  await tick();
  const request = f.events.find(e => e.type === 'permission');
  assert.equal(request.toolUseId, 'sub-tool');
  // No turn is its own and none is opened for it: Core shows it with the
  // sub-agent's call, and nothing is left running once it is answered.
  assert.deepEqual([request.turnId, request.nativeTurnId], [null, undefined]);
  await f.bridge.handle({ id: 'answer', op: 'respond', requestId: request.requestId, decision: 'allow' });
  assert.equal((await approval).behavior, 'allow');
  await feed(f, task('done', 'task_notification', { status: 'completed', summary: 'charlie' }));
  // Its frames wait in a turn nothing names yet, but are not that turn's output.
  const next = await sendPrompt(f, 'turn2');
  await feed(f, init('init-2'), sub('sub-3', [{ type: 'text', text: 'charlie' }]), text('reply-2', 'Hi', next), result('result-2', stamp(next)));
  assert.deepEqual(routed(f), [['init', 'turn1'], ['call', 'turn1'], ['started', 'turn1'], ['sub-1', 'turn1'], ['result', 'turn1'],
    ['sub-2', null], ['done', null], ['init-2', 'turn2'], ['sub-3', 'turn2'], ['reply-2', 'turn2'], ['result-2', 'turn2']]);
  f.bridge.close(); await f.bridge.reader;
});

test('a turn no uuid or origin names stays unmatched and never ends the prompt turn', async () => {
  const f = await fixture();
  await sendPrompt(f, 'turn1');
  await feed(f, init('a'), text('unnamed', 'Something.'), result('result-a'));
  assert.deepEqual(routed(f), [['a', 'native-a'], ['unnamed', 'native-a'], ['result-a', 'native-a']]);
  assert.equal(f.bridge.turnId, 'turn1');
  // Claude says a human started the next turn, and nothing else names it.
  await feed(f, init('b'), text('typed', 'Answer.'), result('result-b', { origin: { kind: 'human' } }));
  assert.deepEqual(routed(f).slice(3), [['b', 'turn1'], ['typed', 'turn1'], ['result-b', 'turn1']]);
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

test('a prompt folded into a notice turn takes the rest of it, and its uuid outranks the origin', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('notice'), text('before-fold', 'Checking the finished task.'),
    text('after-fold', 'And answering you.', prompt), text('more', 'Done.'),
    result('result', { ...notified, user_message_uuid: prompt, user_message_uuids: ['notice-prompt', prompt] }));
  assert.deepEqual(routed(f), [['notice', 'native-notice'], ['before-fold', 'native-notice'],
    ['after-fold', 'turn1'], ['more', 'turn1'], ['result', 'turn1']]);
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

test('a request read before its tool call waits for it and goes with that call\'s turn', async () => {
  const f = await mailboxFixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('init-1'));
  const signal = new AbortController().signal;
  // canUseTool runs as its control request is read; the frames before it
  // may still be queued for the event loop. Its context names the call.
  const early = f.state.options.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 'tool-1' });
  await tick();
  assert.equal(f.events.some(e => e.type === 'permission'), false, 'not sent before its call is read');
  await feed(f,
    { type: 'stream_event', uuid: 'start-1', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'msg-1' } }, ...stamp(prompt) },
    { type: 'stream_event', uuid: 'block-1', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } } });
  const asked = f.events.find(e => e.type === 'permission');
  assert.deepEqual([asked.turnId, asked.nativeTurnId, asked.toolUseId], ['turn1', 'native-init-1', 'tool-1']);
  assert.ok(f.events.indexOf(asked) > f.events.findIndex(e => e.event?.uuid === 'block-1'), 'after its call');
  await f.bridge.handle({ id: 'allow', op: 'respond', requestId: asked.requestId, decision: 'allow' });
  assert.equal((await early).behavior, 'allow');
  // A subagent's call (agentID in the context) goes with the turn it runs in.
  await feed(f, { ...toolCall('sub-call', 'sub-tool'), parent_tool_use_id: 'task-1' });
  const sub = f.state.options.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 'sub-tool', agentID: 'agent-1' });
  assert.equal(f.events.filter(e => e.type === 'permission').at(-1).turnId, 'turn1');
  await f.bridge.handle({ id: 'deny', op: 'respond', requestId: f.events.filter(e => e.type === 'permission').at(-1).requestId, decision: 'deny' });
  assert.equal((await sub).behavior, 'deny');
  await f.bridge.handle(notice('mail1'));
  await feed(f, result('result-1', stamp(prompt)));
  assert.equal(f.events.filter(e => e.type === 'mailbox_delivery').at(-1).status, 'deferred');
  // A turn nothing names yet that asks is shown now, not matched to the
  // prompt in flight, rather than leaving Claude waiting.
  await sendPrompt(f, 'turn2');
  await feed(f, init('init-2'), toolCall('call-2', 'tool-2'));
  assert.equal(routed(f).some(([uuid]) => uuid === 'call-2'), false);
  const own = f.state.options.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 'tool-2' });
  const request = f.events.filter(e => e.type === 'permission').at(-1);
  assert.deepEqual(routed(f).slice(-2), [['init-2', 'native-init-2'], ['call-2', 'native-init-2']]);
  assert.equal(request.turnId, 'native-init-2');
  await f.bridge.handle(notice('mail2', { expectedTurnId: 'turn2' }));
  assert.deepEqual(hook(f, 'PostToolUse', { tool_use_id: 'tool-2' }), {}, 'never injected outside the prompt\'s turn');
  // Its end cancels only its own request and keeps the prompt's notice.
  await feed(f, result('result-2', notified));
  assert.equal((await own).interrupt, true);
  assert.deepEqual(f.events.filter(e => e.type === 'permission_cancelled').map(e => e.requestId), [request.requestId]);
  assert.equal(f.events.filter(e => e.type === 'mailbox_delivery').length, 1);
  assert.equal(f.bridge.turnId, 'turn2');
  f.bridge.close(); await f.bridge.reader;
});

test('a running turn of Claude\'s own can be interrupted and holds model changes', async () => {
  const f = await fixture();
  // No prompt of ours in flight: Claude's own from its first frame.
  await feed(f, init('own'), text('working', 'Following up on the task.'));
  assert.deepEqual(routed(f), [['own', 'native-own'], ['working', 'native-own']]);
  await f.bridge.handle({ id: 'model', op: 'set_model', model: 'claude-opus' });
  assert.match(f.response('model').error, /must wait/);
  await f.bridge.handle({ id: 'stop', op: 'interrupt' });
  assert.deepEqual(f.response('stop').result, { interrupted: true });
  assert.equal(f.state.interrupts, 1);
  await feed(f, result('stopped', { ...notified, subtype: 'error_during_execution', is_error: true }));
  await f.bridge.handle({ id: 'idle', op: 'interrupt' });
  assert.deepEqual(f.response('idle').result, { interrupted: false });
  f.bridge.close(); await f.bridge.reader;
});

test('output waiting for an owner is bounded and kept when the runtime exits', async () => {
  const delta = n => ({ type: 'stream_event', uuid: `d${n}`, session_id: SESSION, parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } });
  const f = await fixture();
  await sendPrompt(f, 'turn1');
  await feed(f, init('long'), ...Array.from({ length: 999 }, (_, n) => delta(n)));
  assert.equal(routed(f).length, 0);
  await feed(f, delta(999));
  assert.equal(routed(f).length, 1001);
  assert.ok(routed(f).every(([, turn]) => turn === 'native-long'));
  f.bridge.close(); await f.bridge.reader;

  // One large tool result is enough: the bound is in bytes as well.
  const big = await fixture();
  await sendPrompt(big, 'turn1');
  await feed(big, init('big'), toolCall('read', 'read-1'));
  assert.equal(routed(big).length, 0);
  await feed(big, { type: 'user', uuid: 'file', session_id: SESSION, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'x'.repeat(5 * 1024 * 1024) }] } });
  assert.deepEqual(routed(big), [['big', 'native-big'], ['read', 'native-big'], ['file', 'native-big']]);
  big.bridge.close(); await big.bridge.reader;

  const g = await fixture();
  await sendPrompt(g, 'turn1');
  await feed(g, init('cut'), text('partial', 'Half an answer'));
  assert.equal(routed(g).length, 0);
  g.output.close();
  await g.bridge.reader;
  assert.deepEqual(routed(g), [['cut', 'native-cut'], ['partial', 'native-cut']]);
  assert.equal(g.events.at(-1).type, 'exit');
});

// Follow-ups while Claude works (T-21).
const append = (id, extra = {}) => ({ id, op: 'append', expectedTurnId: 'turn1', clientMessageId: `client-${id}`,
  followUpTurnId: `follow-${id}`, text: `follow-up ${id}`, ...extra });
const deliveries = f => f.events.filter(e => e.type === 'message_delivery')
  .map(({ clientMessageId, status, turnId, previousTurnId }) => [clientMessageId, status, turnId, previousTurnId]);

test('a follow-up folded into the running turn is confirmed only when Claude names it', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Working.', prompt));
  await f.bridge.handle(append('a'));
  // Local enqueue only: queued with the default priority, never 'now'.
  const queued = (await f.state.prompt.next()).value;
  assert.deepEqual(f.response('a').result, { queued: true, uuid: queued.uuid, turnId: 'turn1' });
  assert.equal(queued.message.content, 'follow-up a');
  assert.equal(queued.priority, undefined);
  assert.deepEqual(deliveries(f), []);
  // Folded between tool rounds: the next reply names both, the fold's uuid first.
  await feed(f, { ...text('after', 'Noted your follow-up.'), user_message_uuid: queued.uuid, user_message_uuids: [prompt, queued.uuid] });
  assert.deepEqual(deliveries(f), [['client-a', 'accepted', 'turn1', undefined]]);
  const order = f.events.filter(e => e.type === 'message_delivery' || e.event?.uuid === 'after').map(e => e.type);
  assert.deepEqual(order, ['message_delivery', 'event'], 'the follow-up shows before the reply to it');
  // An older producer names only the fold's uuid: still the same turn.
  await feed(f, result('done', { user_message_uuid: queued.uuid }));
  assert.deepEqual(routed(f).slice(-2), [['after', 'turn1'], ['done', 'turn1']]);
  assert.equal(f.bridge.turnId, null);
  assert.equal(deliveries(f).length, 1, 'nothing is promoted');
  f.bridge.close(); await f.bridge.reader;
});

test('a follow-up still queued when its turn ends runs as the next turn, confirmed by its own uuid', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Done soon.', prompt));
  await f.bridge.handle(append('b'));
  const queued = (await f.state.prompt.next()).value;
  await feed(f, result('first-result', stamp(prompt)));
  assert.deepEqual(deliveries(f), [['client-b', 'next', 'follow-b', 'turn1']]);
  await f.bridge.handle({ id: 'status', op: 'status' });
  assert.equal(f.response('status').result.turnId, 'follow-b', 'Claude is still busy with it');
  await f.bridge.handle({ id: 'other', op: 'send', turnId: 'turn2', text: 'not now' });
  assert.match(f.response('other').error, /already running/);
  await feed(f, init('j'), text('second', 'About your follow-up.', queued.uuid), result('second-result', stamp(queued.uuid)));
  assert.deepEqual(deliveries(f).at(-1), ['client-b', 'accepted', 'follow-b', undefined]);
  assert.deepEqual(routed(f).slice(-3), [['j', 'follow-b'], ['second', 'follow-b'], ['second-result', 'follow-b']]);
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

test('an interrupt keeps a queued follow-up, which then runs next', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Long work.', prompt));
  await f.bridge.handle(append('c'));
  await f.state.prompt.next();
  await f.bridge.handle({ id: 'stop', op: 'interrupt' });
  assert.equal(f.response('stop').result.interrupted, true);
  await feed(f, result('stopped', { ...stamp(prompt), subtype: 'error_during_execution', is_error: true }));
  assert.deepEqual(deliveries(f), [['client-c', 'next', 'follow-c', 'turn1']]);
  f.bridge.close(); await f.bridge.reader;
});

test('a follow-up is refused once its turn has ended, or with changed content', async () => {
  const f = await fixture();
  await f.bridge.handle(append('idle'));
  assert.match(f.response('idle').error, /already ended/);
  const prompt = await sendPrompt(f, 'turn1');
  await f.bridge.handle(append('stale', { expectedTurnId: 'turn0' }));
  assert.match(f.response('stale').error, /already ended/);
  await f.bridge.handle(append('d'));
  const queued = (await f.state.prompt.next()).value;
  // A repeated click is the same message, not a second one.
  await f.bridge.handle({ ...append('d'), id: 'again' });
  assert.equal(f.response('again').result.uuid, queued.uuid);
  await f.bridge.handle({ ...append('d'), id: 'changed', text: 'something else' });
  assert.match(f.response('changed').error, /different content/);
  await feed(f, init('i'), text('r', 'Hi', prompt), result('end', stamp(prompt)));
  await f.bridge.handle({ ...append('late'), expectedTurnId: 'turn1' });
  assert.match(f.response('late').error, /already ended/, 'the turn is now the promoted follow-up');
  f.bridge.close(); await f.bridge.reader;
});

// Several follow-ups at once (T-65): each waits in order and is confirmed only
// by its own uuid; a waiting one never holds up the next.
test('several follow-ups wait in order; those left run next together, each confirmed by its own uuid', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Working.', prompt));
  const queued = [];
  for (const id of ['f1', 'f2', 'f3', 'f4']) {
    await f.bridge.handle(append(id));
    queued.push((await f.state.prompt.next()).value);
    assert.equal(f.response(id).result.uuid, queued.at(-1).uuid);
  }
  assert.deepEqual(queued.map(q => q.message.content), ['f1', 'f2', 'f3', 'f4'].map(id => `follow-up ${id}`));
  // The result names the prompt and the one folded in; the rest run next,
  // as the turn the first of them starts.
  await feed(f, result('first-result', { user_message_uuid: prompt, user_message_uuids: [prompt, queued[0].uuid] }));
  assert.deepEqual(deliveries(f), [
    ['client-f1', 'accepted', 'turn1', undefined],
    ['client-f2', 'next', 'follow-f2', 'turn1'],
    ['client-f3', 'next', 'follow-f2', 'turn1'],
    ['client-f4', 'next', 'follow-f2', 'turn1'],
  ]);
  // A batch names its last member and lists the rest; one it leaves out moves on.
  const batch = { user_message_uuid: queued[2].uuid, user_message_uuids: [queued[1].uuid, queued[2].uuid] };
  await feed(f, init('j'), { ...text('second', 'On two of them.'), ...batch }, result('second-result', batch));
  assert.deepEqual(deliveries(f).slice(4), [
    ['client-f2', 'accepted', 'follow-f2', undefined],
    ['client-f3', 'accepted', 'follow-f2', undefined],
    ['client-f4', 'next', 'follow-f4', 'follow-f2'],
  ]);
  assert.deepEqual(routed(f).slice(-3), [['j', 'follow-f2'], ['second', 'follow-f2'], ['second-result', 'follow-f2']]);
  await feed(f, init('k'), text('third', 'And the last.', queued[3].uuid), result('third-result', stamp(queued[3].uuid)));
  assert.deepEqual(deliveries(f).at(-1), ['client-f4', 'accepted', 'follow-f4', undefined]);
  assert.deepEqual(routed(f).slice(-2), [['third', 'follow-f4'], ['third-result', 'follow-f4']]);
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

// T-65: a result that does not list what its turn consumed is no evidence that
// a follow-up is still queued. It waits, claiming no turn, until a frame names it.
test('without a full list of what its turn consumed, a follow-up claims no turn until a frame names it', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Working.', prompt));
  await f.bridge.handle(append('w1'));
  await f.bridge.handle(append('w2'));
  const [w1, w2] = [(await f.state.prompt.next()).value, (await f.state.prompt.next()).value];
  // An older producer: the result names its last prompt but lists nothing.
  await feed(f, result('end', { user_message_uuid: prompt }));
  assert.deepEqual(deliveries(f), [], 'neither is pushed onto a turn');
  assert.equal(f.bridge.turnId, null);
  await f.bridge.handle({ id: 'status', op: 'status' });
  assert.equal(f.response('status').result.turnId, null, 'nothing is claimed to be running');
  // Claude answers them, the first naming frame naming both (a batch).
  const batch = { user_message_uuid: w2.uuid, user_message_uuids: [w1.uuid, w2.uuid] };
  await feed(f, init('j'), { ...text('later', 'On both.'), ...batch }, result('later-result', batch));
  assert.deepEqual(deliveries(f), [
    ['client-w1', 'next', 'follow-w1', 'turn1'],
    ['client-w1', 'accepted', 'follow-w1', undefined],
    ['client-w2', 'accepted', 'follow-w1', undefined],
  ]);
  assert.deepEqual(routed(f).slice(-3), [['j', 'follow-w1'], ['later', 'follow-w1'], ['later-result', 'follow-w1']]);
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

// T-65 R1: every follow-up confirmed in a turn belongs to it, so a result
// naming any of them, even by the single older field, ends that turn.
test('a turn ends on a result naming any follow-up it confirmed, not only the one that started it', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Working.', prompt));
  await f.bridge.handle(append('w1'));
  await f.bridge.handle(append('w2'));
  const [w1, w2] = [(await f.state.prompt.next()).value, (await f.state.prompt.next()).value];
  await feed(f, result('end', { user_message_uuid: prompt }));
  // An older producer: frames carry one uuid each and no list.
  await feed(f, init('j'), { ...text('on-first', 'On the first.'), user_message_uuid: w1.uuid },
    { ...text('on-second', 'And the second.'), user_message_uuid: w2.uuid },
    result('later-result', { user_message_uuid: w2.uuid }));
  assert.deepEqual(deliveries(f), [
    ['client-w1', 'next', 'follow-w1', 'turn1'],
    ['client-w1', 'accepted', 'follow-w1', undefined],
    ['client-w2', 'accepted', 'follow-w1', undefined],
  ]);
  assert.deepEqual(routed(f).slice(-2), [['on-second', 'follow-w1'], ['later-result', 'follow-w1']]);
  assert.equal(f.bridge.turnId, null, 'the turn ended; nothing stays running');
  f.bridge.close(); await f.bridge.reader;
});

test('a list at the 64-entry cap confirms what it names and moves nothing else on', async () => {
  const f = await fixture();
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Working.', prompt));
  await f.bridge.handle(append('named'));
  await f.bridge.handle(append('left'));
  const named = (await f.state.prompt.next()).value;
  await f.state.prompt.next();
  const listed = [prompt, named.uuid, ...Array.from({ length: 62 }, (_, i) => `earlier-${i}`)];
  assert.equal(listed.length, 64);
  await feed(f, result('end', { user_message_uuid: prompt, user_message_uuids: listed }));
  assert.deepEqual(deliveries(f), [['client-named', 'accepted', 'turn1', undefined]], 'the other may simply be cut off');
  assert.equal(f.bridge.turnId, null);
  f.bridge.close(); await f.bridge.reader;
});

test('an interrupt receipt naming follow-ups still queued runs them next, whether it comes before or after the result', async () => {
  for (const order of ['receipt first', 'result first']) {
    const f = await fixture();
    let answer;
    f.output.interrupt = () => new Promise(resolve => { answer = resolve; });
    const prompt = await sendPrompt(f, 'turn1');
    await feed(f, init('i'), text('first', 'Long work.', prompt));
    await f.bridge.handle(append('q'));
    const queued = (await f.state.prompt.next()).value;
    const stopping = f.bridge.handle({ id: 'stop', op: 'interrupt' });
    await tick();
    const stopped = result('stopped', { subtype: 'error_during_execution', is_error: true, user_message_uuid: prompt });
    if (order === 'receipt first') {
      answer({ still_queued: [queued.uuid] });
      await stopping;
      await feed(f, stopped);
    } else {
      await feed(f, stopped);
      assert.deepEqual(deliveries(f), [], order);
      answer({ still_queued: [queued.uuid] });
      await stopping;
    }
    assert.deepEqual(deliveries(f), [['client-q', 'next', 'follow-q', 'turn1']], order);
    assert.equal(f.bridge.turnId, 'follow-q', order);
    f.bridge.close(); await f.bridge.reader;
  }
});

// Images with a message (T-31): Core sends files it checked and fitted, never
// their data; they are read, checked again and encoded only here.
test('images reach the SDK as native image blocks read from the exact files Core checked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-images-'));
  const saved = (name, bytes, mediaType) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return { path, mediaType, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const png = saved('a.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('red')]), 'image/png');
  const jpeg = saved('b.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg');
  const block = image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType,
    data: readFileSync(image.path).toString('base64') } });
  try {
    const f = await fixture();
    // Each refusal leaves nothing queued and no turn running.
    symlinkSync(png.path, join(dir, 'link.png'));
    const refused = [
      [{ ...png, sha256: jpeg.sha256 }, /changed/],
      [{ ...png, mediaType: 'image/jpeg' }, /changed/],
      [{ ...png, path: 'a.png' }, /Invalid image reference/],
      [{ ...png, bytes: 512_001 }, /Invalid image reference/],
      [{ ...png, path: join(dir, 'missing.png') }, /ENOENT/],
      [{ ...png, path: join(dir, 'link.png') }, /ELOOP|symbolic/],
      [Array(9).fill(png), /at most 8/],
    ];
    for (const [image, error] of refused) {
      await f.bridge.handle({ id: 'bad', op: 'send', turnId: 'turn1', text: 'look', images: [image].flat() });
      assert.match(f.events.filter(e => e.id === 'bad').at(-1).error, error);
      assert.equal(f.bridge.turnId, null);
    }
    await f.bridge.handle({ id: 'empty', op: 'send', turnId: 'turn1', text: ' ', images: [] });
    assert.match(f.response('empty').error, /nonempty/);

    await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'What is in these?', images: [png, jpeg] });
    const prompt = (await f.state.prompt.next()).value;
    assert.deepEqual(prompt.message.content, [block(png), block(jpeg), { type: 'text', text: 'What is in these?' }]);
    // A follow-up of images alone has no text block, and a repeat must match.
    await f.bridge.handle(append('img', { text: '', images: [jpeg] }));
    const queued = (await f.state.prompt.next()).value;
    assert.deepEqual(queued.message.content, [block(jpeg)]);
    await f.bridge.handle({ ...append('img', { text: '', images: [jpeg] }), id: 'again' });
    assert.equal(f.response('again').result.uuid, queued.uuid);
    await f.bridge.handle({ ...append('img', { text: '', images: [png] }), id: 'other' });
    assert.match(f.response('other').error, /different content/);
    f.bridge.close(); await f.bridge.reader;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effort: the catalog says which levels each model takes; a session starts with the chosen one', async () => {
  const f = await fixture({}, { effort: 'high' });
  assert.equal(f.state.options.effort, 'high');
  assert.equal(f.bridge.effort, 'high');
  // As CLI 2.1.280 lists them: Haiku has no effort fields at all.
  f.state.models = [
    { value: 'sonnet', displayName: 'Sonnet', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'unknown'] },
    { value: 'haiku', displayName: 'Haiku', description: '' },
  ];
  await f.bridge.handle({ id: 'models', op: 'models' });
  const [sonnet, haiku] = f.response('models').result.models;
  assert.equal(sonnet.supportsEffort, true);
  assert.deepEqual(sonnet.supportedEffortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(haiku.supportsEffort, false);
  assert.deepEqual(haiku.supportedEffortLevels, []);
  f.bridge.close(); await f.bridge.reader;
  const plain = await fixture();
  assert.equal(plain.state.options.effort, undefined, 'no choice leaves Claude Code its own');
  plain.bridge.close(); await plain.bridge.reader;
  const invalid = await fixture({}, { effort: 'extreme' });
  assert.match(invalid.response('start').error, /Invalid effort/);
});

test('effort changes wait between turns and go to the next request; null drops Yuzuno\'s choice', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'first', op: 'send', turnId: 'one', text: 'first' });
  await f.bridge.handle({ id: 'too-early', op: 'set_effort', effort: 'low' });
  assert.match(f.response('too-early').error, /current turn finishes/);
  assert.equal(f.state.flags, undefined, 'a running turn is never switched');
  await feed(f, answered(f));
  await f.bridge.handle({ id: 'low', op: 'set_effort', effort: 'low' });
  assert.deepEqual(f.response('low').result, { configured: true, effort: 'low' });
  await f.bridge.handle({ id: 'same', op: 'set_effort', effort: 'low' });
  await f.bridge.handle({ id: 'clear', op: 'set_effort', effort: null });
  assert.deepEqual(f.state.flags, [{ effortLevel: 'low' }, { effortLevel: null }], 'an unchanged choice is not sent again');
  await f.bridge.handle({ id: 'bad', op: 'set_effort', effort: 'turbo' });
  assert.match(f.response('bad').error, /Invalid effort/);
  f.bridge.close(); await f.bridge.reader;
});

test('the effort a turn actually ran at is reported from the main thread\'s Stop hook, with the turn that stopped', async () => {
  const f = await fixture();
  const stop = input => f.state.options.hooks.Stop.at(-1).hooks[0]({ hook_event_name: 'Stop', session_id: SESSION, ...input });
  const efforts = () => f.events.filter(e => e.type === 'effort');
  const prompt = await sendPrompt(f, 'turn1');
  // Recorded order (T-14 lab): a notice turn of Claude's own runs while the
  // prompt is queued. Its stop is its own, not the queued prompt's.
  await feed(f, lifecycle(prompt, 'queued'), init('init-a'));
  assert.deepEqual(await stop({ effort: { level: 'high' } }), {});
  assert.deepEqual(efforts(), [], 'reported with the result, once the turn is known');
  await feed(f, result('result-a', { ...notified, num_turns: 0 }), lifecycle(prompt, 'started'), init('init-b'),
    text('reply-b', 'Hi', prompt));
  assert.deepEqual(await stop({ effort: { level: 'max' }, agent_id: 'sub-agent' }), {}, 'a sub-agent\'s stop is not the turn\'s');
  assert.deepEqual(await stop({ effort: { level: 'unheard-of' } }), {});
  assert.deepEqual(await stop({ effort: { level: 'low' } }), {});
  await feed(f, result('result-b', stamp(prompt)));
  assert.deepEqual(efforts(), [{ type: 'effort', turnId: 'native-init-a', level: 'high' }, { type: 'effort', turnId: 'turn1', level: 'low' }]);
  // Each before its turn's result, so the turn ends with its effort known.
  const order = f.events.filter(e => e.type === 'effort' || e.event?.type === 'result').map(e => e.type === 'effort' ? e.level : e.event.uuid);
  assert.deepEqual(order, ['high', 'result-a', 'low', 'result-b']);
  // A model without effort reports none, and nothing stops outside a turn.
  const next = await sendPrompt(f, 'turn2');
  await feed(f, init('init-c'), text('reply-c', 'Hi', next));
  assert.deepEqual(await stop({}), {});
  await feed(f, result('result-c', stamp(next)));
  assert.deepEqual(await stop({ effort: { level: 'high' } }), {});
  assert.equal(efforts().length, 2);
  f.bridge.close(); await f.bridge.reader;
});

// T-22: saved history as SDK 0.3.296's readers return it (probes 5c16542a and
// 54b7e79a): the main chain with system messages, then each sub-agent's.
const RESUMED = '7f7263b1-4654-49fe-97d9-2da71f7cda47';
const savedChain = [
  { type: 'user', uuid: 'p1', session_id: RESUMED, parent_tool_use_id: null, timestamp: '2026-10-17T00:28:12.0Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] } },
  { type: 'assistant', uuid: 'a1', session_id: RESUMED, parent_tool_use_id: null, timestamp: '2026-10-17T00:28:13.0Z',
    message: { id: 'msg_1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.txt' } }] } },
  { type: 'user', uuid: 'r1', session_id: RESUMED, parent_tool_use_id: null, timestamp: '2026-10-17T00:28:14.0Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'denied', is_error: true }] } },
  { type: 'system', uuid: 's1', session_id: RESUMED, parent_tool_use_id: null, timestamp: '2026-10-17T00:28:15.0Z' },
  { type: 'user', uuid: 'c1', session_id: RESUMED, parent_tool_use_id: null, isCompactSummary: true, is_meta: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation.' } },
  { type: 'user', uuid: 'l1', session_id: RESUMED, parent_tool_use_id: null, isCompletedLocalCommand: true,
    message: { role: 'user', content: '<command-name>/compact</command-name>' } },
  // Claude Code's own placeholder for a turn cut off before resuming (probe 1cf443a8).
  { type: 'assistant', uuid: 'syn', session_id: RESUMED, parent_tool_use_id: null,
    message: { id: '9bbfe5b5-2820-4dba-9d36-13f247ec6db7', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } },
];
const subagentChain = [
  { type: 'assistant', uuid: 'sa1', session_id: RESUMED, parent_tool_use_id: 'toolu_agent',
    message: { id: 'msg_sub', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Read', input: {} }] } },
];
const historyApi = calls => ({
  getSessionMessages: async (sessionId, options) => { calls.push(['main', sessionId, options]); return savedChain; },
  listSubagents: async (sessionId, options) => { calls.push(['agents', sessionId, options]); return ['agent-a']; },
  getSubagentMessages: async (sessionId, agentId, options) => { calls.push(['agent', sessionId, agentId, options]); return subagentChain; },
});

test('a prompt and a follow-up carry the uuid Core recorded for them before sending', async () => {
  const f = await fixture();
  await f.bridge.handle({ id: 'bad', op: 'send', turnId: 'turn1', text: 'x', uuid: 'not-a-uuid' });
  assert.match(f.response('bad').error, /Invalid prompt uuid/);
  assert.equal(f.bridge.turnId, null, 'nothing was queued');
  const prompt = '11111111-1111-4111-8111-111111111111', followUp = '22222222-2222-4222-8222-222222222222';
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 'turn1', text: 'hello', uuid: prompt });
  assert.equal((await f.state.prompt.next()).value.uuid, prompt);
  assert.equal(f.response('send').result.uuid, prompt);
  await f.bridge.handle({ id: 'again', op: 'append', expectedTurnId: 'turn1', clientMessageId: 'c0', followUpTurnId: 'turn0', text: 'x', uuid: prompt.slice(1) });
  assert.match(f.response('again').error, /Invalid prompt uuid/);
  await f.bridge.handle({ id: 'append', op: 'append', expectedTurnId: 'turn1', clientMessageId: 'c1', followUpTurnId: 'turn2', text: 'and', uuid: followUp });
  assert.equal((await f.state.prompt.next()).value.uuid, followUp);
  assert.equal(f.response('append').result.uuid, followUp);
  f.bridge.close(); await f.bridge.reader;
});

test('saved history is read only for the resumed session, in its directory, through the SDK readers, as identities then messages', async () => {
  const calls = [];
  const f = await fixture({ history: historyApi(calls) }, { sessionId: RESUMED });
  await f.bridge.handle({ id: 'read', op: 'history_read', sessionId: RESUMED });
  const read = f.response('read').result;
  assert.deepEqual([read.total, read.main, read.subagents], [8, 7, [{ agentId: 'agent-a', count: 1 }]]);
  assert.deepEqual(calls, [['main', RESUMED, { dir: process.cwd(), includeSystemMessages: true }], ['agents', RESUMED, { dir: process.cwd() }],
    ['agent', RESUMED, 'agent-a', { dir: process.cwd() }]]);
  await f.bridge.handle({ id: 'index', op: 'history_index', readId: read.readId, from: 0, limit: 4 });
  const index = f.response('index').result;
  assert.deepEqual([index.next, index.total], [4, 8]);
  assert.deepEqual(index.entries[0], { offset: 0, uuid: 'p1', type: 'user', parentToolUseId: null, timestamp: '2026-10-17T00:28:12.0Z',
    id: null, stopReason: null, blocks: [{ type: 'text' }], text: 'Read a.txt', flags: {} });
  assert.deepEqual([index.entries[1].id, index.entries[1].stopReason, index.entries[1].blocks], ['msg_1', 'tool_use', [{ type: 'tool_use', id: 'toolu_read' }]]);
  assert.deepEqual(index.entries[2].blocks, [{ type: 'tool_result', toolUseId: 'toolu_read', error: true }], 'a tool result is never a prompt');
  assert.equal(index.entries[2].text, undefined);
  await f.bridge.handle({ id: 'rest', op: 'history_index', readId: read.readId, from: 4 });
  const rest = f.response('rest').result;
  assert.equal(rest.next, null);
  assert.deepEqual(rest.entries.map(e => [e.uuid, e.flags, e.agentId ?? null, e.parentToolUseId]), [
    ['c1', { meta: true, compactSummary: true }, null, null], ['l1', { localCommand: true }, null, null], ['syn', { synthetic: true }, null, null],
    ['sa1', {}, 'agent-a', 'toolu_agent']]);
  await f.bridge.handle({ id: 'messages', op: 'history_messages', readId: read.readId, offsets: [7, 1] });
  assert.deepEqual(f.response('messages').result, { delivered: 2,
    messages: [{ offset: 7, agentId: 'agent-a', message: subagentChain[0] }, { offset: 1, agentId: null, message: savedChain[1] }] });
  await f.bridge.handle({ id: 'bad', op: 'history_messages', readId: read.readId, offsets: [8] });
  assert.match(f.response('bad').error, /held saved messages/);
  await f.bridge.handle({ id: 'close-read', op: 'history_close', readId: read.readId });
  await f.bridge.handle({ id: 'after', op: 'history_index', readId: read.readId });
  assert.match(f.response('after').error, /no longer held/);
  f.bridge.close(); await f.bridge.reader;
});

test('saved history refuses another session, a new session and a catalog query, and a large page stops at its size', async () => {
  const calls = [];
  const fresh = await fixture({ history: historyApi(calls) });
  await fresh.bridge.handle({ id: 'new', op: 'history_read', sessionId: RESUMED });
  assert.match(fresh.response('new').error, /session this runtime resumed/);
  fresh.bridge.close(); await fresh.bridge.reader;
  const other = await fixture({ history: historyApi(calls) }, { sessionId: RESUMED });
  await other.bridge.handle({ id: 'other', op: 'history_read', sessionId: '00000000-0000-4000-8000-000000000000' });
  assert.match(other.response('other').error, /session this runtime resumed/);
  other.bridge.close(); await other.bridge.reader;
  const catalog = await fixture({ history: historyApi(calls) }, { catalogOnly: true });
  await catalog.bridge.handle({ id: 'catalog', op: 'history_read', sessionId: RESUMED });
  assert.match(catalog.response('catalog').error, /started session/);
  catalog.bridge.close(); await catalog.bridge.reader;
  assert.deepEqual(calls, [], 'no session was read');
  // Three saved messages of 2 MiB each: one response carries what fits, at least one.
  const big = n => ({ type: 'assistant', uuid: `big${n}`, message: { id: `m${n}`, content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] } });
  const large = await fixture({ history: { getSessionMessages: async () => [big(0), big(1), big(2)], listSubagents: async () => [], getSubagentMessages: async () => [] } },
    { sessionId: RESUMED });
  await large.bridge.handle({ id: 'read', op: 'history_read', sessionId: RESUMED });
  await large.bridge.handle({ id: 'page', op: 'history_messages', readId: large.response('read').result.readId, offsets: [0, 1, 2] });
  assert.deepEqual(large.response('page').result.messages.map(m => m.offset), [0]);
  large.bridge.close(); await large.bridge.reader;
});

// Project Brief turn-end check (T-85): only Core's accepted receipt for the
// running turn counts, and a turn without one has its stop held at most once.
const BRIEF_RULES = 'Yuzuno Project Brief: end every turn with an accepted brief_update.';
const REQUIRED = { required: true, hardRules: BRIEF_RULES };
const briefFixture = (brief, start = {}) => fixture({}, {
  collaborationMcp: { url: 'http://127.0.0.1:4379/mcp/test-agent', headers: { Authorization: 'Bearer fixture-only' } }, brief, ...start });
// The main thread's Stop as CLI 2.1.280 sends it.
const stopping = (f, input = {}) => f.state.options.hooks.Stop.at(-1).hooks[0](
  { hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: false, ...input }, undefined, { signal: new AbortController().signal });
const briefs = f => f.events.filter(e => e.type === 'brief').map(({ turnId, outcome }) => [turnId, outcome]);
const accepted = (turnId, kind = 'updated') => ({ accepted: true,
  receipt: { id: `receipt-${turnId}`, agentId: 'test-agent', projectId: 'project-1', turnId, kind },
  version: 4, sections: [{ key: 'status', version: 4 }] });
// brief_update's PostToolUse: CLI 2.1.280 hands Core's structuredContent over as its JSON text.
const briefUpdated = (f, response, extra = {}) => hook(f, 'PostToolUse', { tool_name: 'mcp__yuzuno__brief_update',
  tool_input: {}, tool_use_id: 'brief-call', tool_response: response, mcp_server: { name: 'yuzuno', source: 'dynamic' }, ...extra });

test('a running bridge rechecks Core policy at Stop after revocation or a new grant', async () => {
  for (const initial of [true, false]) {
    const f = await briefFixture({ ...REQUIRED, required: initial, recheck: true });
    const prompt = await sendPrompt(f, 'turn1');
    await feed(f, init('init'), text('reply', 'Done.', prompt));
    const stop = stopping(f);
    await new Promise(resolve => setImmediate(resolve));
    const request = f.events.find(e => e.type === 'brief_policy');
    assert.ok(request, 'check even when the bridge started Ask-only');
    await f.bridge.handle({ id: 'stale-policy', op: 'brief_policy', requestId: request.requestId,
      turnId: 'wrong-turn', required: true });
    assert.equal(f.response('stale-policy').result.accepted, false);
    await f.bridge.handle({ id: 'current-policy', op: 'brief_policy', requestId: request.requestId,
      turnId: request.turnId, required: !initial });
    const result = await stop;
    assert.equal(result.decision, initial ? undefined : 'block');
    assert.deepEqual(briefs(f), initial ? [] : [['turn1', 'blocked']]);
    f.bridge.close(); await f.bridge.reader;
  }
});

test('closing while a Brief policy check waits cannot hold a stale Stop', async () => {
  const f = await briefFixture({ ...REQUIRED, recheck: true });
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('init'), text('reply', 'Done.', prompt));
  const stop = stopping(f);
  await new Promise(resolve => setImmediate(resolve));
  f.bridge.close();
  assert.deepEqual(await stop, {});
  assert.deepEqual(briefs(f), []);
  assert.equal(f.bridge.briefPolicyPending.size, 0);
  await f.bridge.reader;
});

test('a delayed policy reply cannot hold Stop after a receipt arrived', async () => {
  const f = await briefFixture({ ...REQUIRED, recheck: true });
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('init'), text('reply', 'Done.', prompt));
  const stop = stopping(f);
  await tick();
  const request = f.events.find(e => e.type === 'brief_policy');
  briefUpdated(f, accepted('turn1', 'noChange'));
  await f.bridge.handle({ id: 'late', op: 'brief_policy', requestId: request.requestId,
    turnId: request.turnId, required: true });
  assert.deepEqual(await stop, {});
  assert.deepEqual(briefs(f), []);
  assert.equal(f.bridge.briefPolicyPending.size, 0);
  f.bridge.close(); await f.bridge.reader;
});

test('Brief policy timeout releases Stop and ignores a later permission reply', async () => {
  const f = await briefFixture({ ...REQUIRED, recheck: true });
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('init'), text('reply', 'Done.', prompt));
  const stop = stopping(f);
  await tick();
  const request = f.events.find(e => e.type === 'brief_policy');
  assert.ok(request);
  assert.deepEqual(await stop, {});
  assert.deepEqual(briefs(f), []);
  assert.equal(f.bridge.briefPolicyPending.size, 0);
  await f.bridge.handle({ id: 'late', op: 'brief_policy', requestId: request.requestId,
    turnId: request.turnId, required: true });
  assert.equal(f.response('late').result.accepted, false);
  f.bridge.close(); await f.bridge.reader;
});

test('native exit releases a pending Brief policy check immediately', async () => {
  const f = await briefFixture({ ...REQUIRED, recheck: true });
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('init'), text('reply', 'Done.', prompt));
  const stop = stopping(f);
  await tick();
  assert.equal(f.bridge.briefPolicyPending.size, 1);
  f.output.close();
  await f.bridge.reader;
  assert.equal(f.bridge.briefPolicyPending.size, 0);
  assert.deepEqual(await stop, {});
  assert.deepEqual(briefs(f), []);
});

test('Core\'s Brief hard rules join the append only when it requires the check', async () => {
  const plain = await mailboxFixture();
  const base = plain.state.options.systemPrompt.append;
  plain.bridge.close(); await plain.bridge.reader;
  const required = await briefFixture(REQUIRED, { capabilityNotice: 'Yuzuno can show tables.' });
  assert.equal(required.state.options.systemPrompt.append, `${base} Yuzuno can show tables.\n\n${BRIEF_RULES}`);
  assert.equal(required.state.options.hooks.Stop.length, 1);
  required.bridge.close(); await required.bridge.reader;
  // Not required, or an older Core that sends nothing: the append of today.
  for (const brief of [{ required: false, hardRules: BRIEF_RULES }, { required: false }, undefined]) {
    const f = await briefFixture(brief);
    assert.equal(f.state.options.systemPrompt.append, base);
    f.bridge.close(); await f.bridge.reader;
  }
  // brief_update is a yuzuno tool, so a required check needs the Workspace MCP.
  const starts = [{ brief: REQUIRED }, ...[{ required: true, hardRules: ' ' }, { required: true },
    { required: true, hardRules: 'x'.repeat(2049) }, { required: 'yes', hardRules: BRIEF_RULES }, true, null,
    { required: false, hardRules: 7 }].map(brief => ({ brief, collaborationMcp: { url: 'http://127.0.0.1:4379/mcp/a', headers: { Authorization: 'Bearer fixture-only' } } }))];
  for (const start of starts) {
    const rejected = await fixture({}, start);
    assert.match(rejected.response('start').error, /Brief configuration/, JSON.stringify(start.brief));
    rejected.bridge.close(); await rejected.bridge.reader;
  }
});

test('without a required check a turn ends as today: nothing is held or reported', async () => {
  for (const brief of [undefined, { required: false, hardRules: BRIEF_RULES }]) {
    const f = await briefFixture(brief);
    const prompt = await sendPrompt(f, 'turn1');
    await feed(f, init('init'), text('reply', 'Done.', prompt));
    assert.deepEqual(briefUpdated(f, JSON.stringify(accepted('turn1'))), {});
    assert.deepEqual(await stopping(f), {});
    await feed(f, answered(f));
    assert.equal(f.bridge.turnId, null);
    assert.deepEqual(briefs(f), [], JSON.stringify(brief));
    f.bridge.close(); await f.bridge.reader;
  }
});

test('a turn Core accepted no update for is held once, continues as the same turn, and ends missing', async () => {
  const f = await briefFixture(REQUIRED);
  const prompt = await sendPrompt(f, 'turn1');
  // The frames before the stop may still wait in the SDK's queue when it arrives.
  f.output.push(init('init'));
  f.output.push(text('reply', 'Done.', prompt));
  const held = await stopping(f);
  assert.equal(held.decision, 'block');
  assert.ok(held.reason.length <= 400 && !held.reason.includes('\n'), 'one short paragraph');
  for (const name of ['brief_get', 'brief_update', 'noChange:true', 'brief_guide']) assert.ok(held.reason.includes(name), name);
  assert.deepEqual(briefs(f), [['turn1', 'blocked']]);
  assert.equal(f.bridge.turnId, 'turn1', 'the turn goes on');
  // Claude continues in the same native turn; no later stop is held again.
  await feed(f, text('more', 'Continuing.'));
  assert.deepEqual(await stopping(f, { stop_hook_active: true }), {});
  assert.deepEqual(await stopping(f), {}, 'at most once a turn, even once stop_hook_active resets');
  await feed(f, answered(f));
  assert.deepEqual(briefs(f), [['turn1', 'blocked'], ['turn1', 'missing']]);
  // Reported as its turn ends, ahead of the result, and all one Yuzuno turn.
  const order = f.events.filter(e => e.type === 'brief' || e.event?.type === 'result').map(e => e.type === 'brief' ? e.outcome : e.event.uuid);
  assert.deepEqual(order, ['blocked', 'missing', `result-${prompt}`]);
  assert.deepEqual(routed(f), [['init', 'turn1'], ['reply', 'turn1'], ['more', 'turn1'], [`result-${prompt}`, 'turn1']]);
  // The next turn has a check of its own.
  const next = await sendPrompt(f, 'turn2');
  await feed(f, init('init-2'), text('reply-2', 'Hi', next));
  assert.equal((await stopping(f)).decision, 'block');
  await feed(f, answered(f));
  assert.deepEqual(briefs(f).slice(2), [['turn2', 'blocked'], ['turn2', 'missing']]);
  f.bridge.close(); await f.bridge.reader;
});

test('Core\'s accepted receipt for this turn means no hold; noChange counts and one update outlasts it', async () => {
  const f = await briefFixture(REQUIRED);
  const first = await sendPrompt(f, 'turn1');
  await feed(f, init('init-1'), text('reply-1', 'Updated the Brief.', first));
  assert.deepEqual(briefUpdated(f, JSON.stringify(accepted('turn1'))), {});
  assert.deepEqual(await stopping(f), {});
  await feed(f, answered(f));
  // PostToolBatch carries the tool_result's content blocks.
  const second = await sendPrompt(f, 'turn2');
  await feed(f, init('init-2'), text('reply-2', 'Nothing new.', second));
  hook(f, 'PostToolBatch', { tool_calls: [{ tool_name: 'Bash', tool_input: {}, tool_use_id: 'bash', tool_response: 'ok' },
    { tool_name: 'mcp__yuzuno__brief_update', tool_input: { noChange: true }, tool_use_id: 'brief-2',
      tool_response: [{ type: 'text', text: JSON.stringify(accepted('turn2', 'noChange')) }] }] });
  assert.deepEqual(await stopping(f), {});
  await feed(f, answered(f));
  const third = await sendPrompt(f, 'turn3');
  await feed(f, init('init-3'), text('reply-3', 'Changed, then checked.', third));
  briefUpdated(f, { content: [{ type: 'text', text: 'see structured content' }], structuredContent: accepted('turn3'), isError: false });
  briefUpdated(f, JSON.stringify(accepted('turn3', 'noChange')));
  await feed(f, answered(f));
  assert.deepEqual(briefs(f), [['turn1', 'updated'], ['turn2', 'noChange'], ['turn3', 'updated']]);
  f.bridge.close(); await f.bridge.reader;
});

test('an old or other turn\'s receipt, a rejection, a failure or the call alone never counts; a later acceptance does', async () => {
  const f = await briefFixture(REQUIRED);
  const first = await sendPrompt(f, 'turn1');
  await feed(f, init('init-1'), text('reply-1', 'Done.', first));
  briefUpdated(f, JSON.stringify(accepted('turn1')));
  await feed(f, answered(f));
  const prompt = await sendPrompt(f, 'turn2');
  await feed(f, init('init-2'), reply('call', [{ type: 'tool_use', id: 'brief-call', name: 'mcp__yuzuno__brief_update', input: { noChange: true } }], prompt));
  briefUpdated(f, JSON.stringify(accepted('turn1')));
  briefUpdated(f, JSON.stringify(accepted('turn-other')));
  briefUpdated(f, JSON.stringify({ accepted: false, error: 'brief_rejected: version_conflict', problems: [{ code: 'version_conflict' }],
    latest: { version: 5, sections: [] } }));
  briefUpdated(f, { isError: true, structuredContent: accepted('turn2') });
  briefUpdated(f, JSON.stringify({ ...accepted('turn2'), receipt: { ...accepted('turn2').receipt, kind: 'pending' } }));
  briefUpdated(f, 'Error: result exceeds maximum allowed tokens. Output has been saved to a file.');
  hook(f, 'PostToolUseFailure', { tool_name: 'mcp__yuzuno__brief_update', tool_use_id: 'brief-call', error: JSON.stringify(accepted('turn2')) });
  briefUpdated(f, JSON.stringify(accepted('turn2')), { tool_name: 'mcp__other__brief_update', mcp_server: { name: 'other', source: 'user' } });
  briefUpdated(f, JSON.stringify(accepted('turn2')), { mcp_server: { name: 'other', source: 'user' } });
  assert.equal((await stopping(f)).decision, 'block');
  // Corrected after the hold: Core's acceptance for this turn completes it.
  briefUpdated(f, JSON.stringify(accepted('turn2')));
  assert.deepEqual(await stopping(f, { stop_hook_active: true }), {});
  await feed(f, answered(f));
  assert.deepEqual(briefs(f), [['turn1', 'updated'], ['turn2', 'blocked'], ['turn2', 'updated']]);
  f.bridge.close(); await f.bridge.reader;
});

test('a stop another hook continued, a sub-agent\'s or one of a turn not the prompt\'s is not held', async () => {
  const f = await briefFixture(REQUIRED);
  const prompt = await sendPrompt(f, 'turn1');
  // A notice turn of Claude's own runs while the prompt is queued (T-14 lab).
  await feed(f, lifecycle(prompt, 'queued'), init('init-a'));
  assert.deepEqual(await stopping(f), {});
  await feed(f, result('result-a', { ...notified, num_turns: 0 }), init('init-b'), text('reply-b', 'Hi', prompt));
  assert.deepEqual(briefs(f), [], 'the notice turn reports nothing');
  assert.deepEqual(await stopping(f, { stop_hook_active: true }), {});
  assert.deepEqual(await stopping(f, { agent_id: 'sub-agent' }), {});
  assert.deepEqual(await stopping(f, { hook_event_name: 'SubagentStop', agent_id: 'sub-agent' }), {});
  await feed(f, result('result-b', stamp(prompt)));
  assert.deepEqual(briefs(f), [['turn1', 'missing']]);
  // Nothing is held once no prompt of ours runs.
  await feed(f, init('init-c'), text('reply-c', 'It finished.'));
  assert.deepEqual(await stopping(f), {});
  await feed(f, result('result-c', notified));
  assert.deepEqual(briefs(f), [['turn1', 'missing']]);
  f.bridge.close(); await f.bridge.reader;
});

test('an interrupted or failed turn is skipped, not missing, unless Core accepted its update', async () => {
  const f = await briefFixture(REQUIRED);
  const first = await sendPrompt(f, 'turn1');
  await feed(f, init('init-1'), text('reply-1', 'Long work.', first));
  await f.bridge.handle({ id: 'stop1', op: 'interrupt' });
  assert.deepEqual(await stopping(f), {}, 'a stopped turn is not held');
  await feed(f, answered(f, { subtype: 'error_during_execution', is_error: true }));
  const second = await sendPrompt(f, 'turn2');
  await feed(f, init('init-2'), text('reply-2', 'Hi', second));
  await feed(f, answered(f, { subtype: 'error_max_turns', is_error: true }));
  const third = await sendPrompt(f, 'turn3');
  await feed(f, init('init-3'), text('reply-3', 'Hi', third));
  await feed(f, answered(f, { is_error: true, result: 'API Error: overloaded' }));
  const fourth = await sendPrompt(f, 'turn4');
  await feed(f, init('init-4'), text('reply-4', 'Hi', fourth));
  briefUpdated(f, JSON.stringify(accepted('turn4', 'noChange')));
  await f.bridge.handle({ id: 'stop4', op: 'interrupt' });
  await feed(f, answered(f, { subtype: 'error_during_execution', is_error: true }));
  // Interrupted as it finished: the result alone does not say so.
  const fifth = await sendPrompt(f, 'turn5');
  await feed(f, init('init-5'), text('reply-5', 'Hi', fifth));
  await f.bridge.handle({ id: 'stop5', op: 'interrupt' });
  await feed(f, answered(f));
  // A local command (recorded /cost) never runs the model, so never could update.
  const sixth = await sendPrompt(f, 'turn6');
  await feed(f, init('init-6'), text('cost', 'You are currently using your subscription'), result('result-6', { ...stamp(sixth), num_turns: 0 }));
  assert.deepEqual(briefs(f), [['turn1', 'skipped'], ['turn2', 'skipped'], ['turn3', 'skipped'], ['turn4', 'noChange'], ['turn5', 'skipped'],
    ['turn6', 'skipped']]);
  f.bridge.close(); await f.bridge.reader;
});

test('only Core\'s accepted receipt for this turn counts, in each shape the CLI hands to hooks', () => {
  const ok = accepted('turn1');
  for (const response of [JSON.stringify(ok), ok, [{ type: 'text', text: JSON.stringify(ok) }],
    [{ type: 'image', source: {} }, { type: 'text', text: JSON.stringify(ok) }],
    { content: [{ type: 'text', text: JSON.stringify(ok) }] }, { content: [], structuredContent: ok }]) {
    assert.equal(briefReceiptKind(response, 'turn1'), 'updated', JSON.stringify(response));
  }
  for (const response of [undefined, null, '', 'not json', 7, JSON.stringify(accepted('turn0')), { ...ok, accepted: 'true' },
    { accepted: true }, { ...ok, receipt: { ...ok.receipt, kind: 'other' } }, { isError: true, structuredContent: ok },
    [{ type: 'text', text: JSON.stringify({ accepted: false, error: 'brief_rejected: no_active_turn', problems: [] }) }]]) {
    assert.equal(briefReceiptKind(response, 'turn1'), null, JSON.stringify(response));
  }
  assert.equal(briefReceiptKind(ok, null), null);
});

test('a follow-up that runs as the next turn has a Brief check of its own', async () => {
  const f = await briefFixture(REQUIRED);
  const prompt = await sendPrompt(f, 'turn1');
  await feed(f, init('i'), text('first', 'Done soon.', prompt));
  await f.bridge.handle(append('b'));
  const queued = (await f.state.prompt.next()).value;
  briefUpdated(f, JSON.stringify(accepted('turn1')));
  await feed(f, result('first-result', stamp(prompt)));
  assert.equal(f.bridge.turnId, 'follow-b');
  await feed(f, init('j'), text('second', 'About your follow-up.', queued.uuid));
  assert.equal((await stopping(f)).decision, 'block', 'turn1\'s receipt does not count for it');
  briefUpdated(f, JSON.stringify(accepted('follow-b', 'noChange')));
  await feed(f, result('second-result', stamp(queued.uuid)));
  assert.deepEqual(briefs(f), [['turn1', 'updated'], ['follow-b', 'blocked'], ['follow-b', 'noChange']]);
  f.bridge.close(); await f.bridge.reader;
});

test('file checkpoints: the start option only when Core asks; rewind_files names a native prompt uuid and runs only between turns', async () => {
  const plain = await fixture();
  assert.equal(plain.state.options.enableFileCheckpointing, undefined);
  const f = await fixture({}, { fileCheckpointing: true });
  assert.equal(f.state.options.enableFileCheckpointing, true);
  const calls = [];
  // As CLI 2.1.280 answers (acceptance/t32/probe): a preview lists absolute paths and line counts.
  f.output.rewindFiles = async (id, options) => {
    calls.push([id, options]);
    return options?.dryRun ? { canRewind: true, filesChanged: ['/lab/a.txt', '/lab/b.txt'], insertions: 1, deletions: 2 } : { canRewind: true, skippedLinks: 0 };
  };
  const uuid = '11111111-2222-4333-8444-555555555555';
  await f.bridge.handle({ id: 'preview', op: 'rewind_files', userMessageId: uuid, dryRun: true });
  assert.deepEqual(f.response('preview').result, { canRewind: true, filesChanged: ['/lab/a.txt', '/lab/b.txt'], insertions: 1, deletions: 2 });
  await f.bridge.handle({ id: 'rewind', op: 'rewind_files', userMessageId: uuid });
  assert.deepEqual(f.response('rewind').result, { canRewind: true, skippedLinks: 0 });
  assert.deepEqual(calls, [[uuid, { dryRun: true }], [uuid, undefined]]);
  await f.bridge.handle({ id: 'turn-id', op: 'rewind_files', userMessageId: 'turn-1', dryRun: true });
  assert.match(f.response('turn-id').error, /native uuid/);
  await f.bridge.handle({ id: 'dry', op: 'rewind_files', userMessageId: uuid, dryRun: 'yes' });
  assert.match(f.response('dry').error, /dryRun/);
  await sendPrompt(f, 'turn1');
  await f.bridge.handle({ id: 'busy', op: 'rewind_files', userMessageId: uuid, dryRun: true });
  assert.match(f.response('busy').error, /between turns/);
  assert.equal(calls.length, 2, 'nothing is rewound while a turn runs');
});

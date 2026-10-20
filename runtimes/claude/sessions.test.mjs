import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBridge, PromptQueue } from './bridge.mjs';
import { listSessionsPage, sessionInfo, sessionPreview } from './sessions.mjs';

const ID = '7f7263b1-4654-49fe-97d9-2da71f7cda47';
const OTHER = '00000000-0000-4000-8000-000000000000';
const info = (sessionId, extra = {}) => ({ sessionId, summary: `Session ${sessionId.slice(0, 4)}`, lastModified: 1760000000000,
  cwd: '/work/app', gitBranch: 'main', firstPrompt: 'Fix the build', createdAt: 1759990000000, fileSize: 2048, ...extra });
const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, session_id: ID, parent_tool_use_id: null, timestamp: '2026-10-17T01:00:00Z',
  message: { role: 'user', content }, ...extra });
const assistant = (uuid, content, extra = {}) => ({ type: 'assistant', uuid, session_id: ID, parent_tool_use_id: null, timestamp: '2026-10-17T01:00:01Z',
  message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-opus-5-5', content }, ...extra });

test('a page of sessions says whether another follows, with person-started sessions by default', async () => {
  const calls = [];
  const all = Array.from({ length: 5 }, (_, i) => info(`${i}0000000-0000-4000-8000-000000000000`));
  const api = { listSessions: async options => { calls.push(options); return all.slice(options.offset, options.offset + options.limit); } };
  const first = await listSessionsPage(api, { limit: 2 });
  assert.deepEqual(calls[0], { limit: 3, offset: 0, includeProgrammatic: false });
  assert.deepEqual(first.sessions.map(s => s.sessionId), [all[0].sessionId, all[1].sessionId]);
  assert.equal(first.next, 2);
  const last = await listSessionsPage(api, { limit: 2, offset: 4, programmatic: true });
  assert.deepEqual(calls[1], { limit: 3, offset: 4, includeProgrammatic: true });
  assert.deepEqual([last.sessions.length, last.next], [1, null]);
  // Bounded: a page never asks for more than the cap.
  await listSessionsPage(api, { limit: 10_000 });
  assert.equal(calls[2].limit, 51);
  assert.deepEqual(first.sessions[0], { sessionId: all[0].sessionId, title: 'Session 0000', firstPrompt: 'Fix the build', cwd: '/work/app',
    gitBranch: 'main', tag: null, lastModified: 1760000000000, createdAt: 1759990000000, fileSize: 2048 });
  await listSessionsPage(api, { dir: '/work/app' });
  assert.deepEqual(calls[3], { limit: 21, offset: 0, includeProgrammatic: false, dir: '/work/app' });
  await assert.rejects(listSessionsPage(api, { dir: 'work/app' }), /absolute/);
  await assert.rejects(listSessionsPage(api, { programmatic: 'yes' }), /Invalid programmatic filter/);
  await assert.rejects(listSessionsPage({}, {}), /no listSessions/);
});

test('a session is found by its id only, and a renamed one shows its own title', async () => {
  const api = { getSessionInfo: async id => (id === ID ? info(ID, { customTitle: 'Release prep' }) : undefined) };
  assert.equal((await sessionInfo(api, { sessionId: ID })).session.title, 'Release prep');
  assert.deepEqual(await sessionInfo(api, { sessionId: OTHER }), { session: null });
  await assert.rejects(sessionInfo(api, { sessionId: '../x' }), /Invalid native session UUID/);
  // A reader that answers for another session is not this one.
  assert.deepEqual(await sessionInfo({ getSessionInfo: async () => info(OTHER) }, { sessionId: ID }), { session: null });
});

test('a preview shows the newest conversation, never tool results, meta or local commands', async () => {
  const reads = [];
  const saved = [
    user('c', 'This session is being continued from a previous conversation.', { isCompactSummary: true, is_meta: true }),
    user('p1', [{ type: 'text', text: 'Look at this' }, { type: 'image', source: {} }]),
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    user('r1', [{ type: 'tool_result', tool_use_id: 't1', content: 'secret output' }]),
    assistant('a2', [{ type: 'text', text: 'x'.repeat(500) }]),
    user('l', '<command-name>/context</command-name>', { isCompletedLocalCommand: true }),
    assistant('syn', [{ type: 'text', text: 'No response requested.' }], { message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
    { type: 'system', uuid: 's', session_id: ID },
  ];
  const api = {
    getSessionInfo: async () => info(ID),
    getSessionMessages: async (id, options) => { reads.push([id, options]); return saved; },
    listSubagents: async () => ['agent-1'],
  };
  const preview = await sessionPreview(api, { sessionId: ID });
  assert.deepEqual(reads, [[ID, { dir: '/work/app', includeSystemMessages: true }]], 'read in the folder Claude saved it under');
  assert.deepEqual({ ...preview, recent: undefined }, { session: preview.session, saved: 8, prompts: 1, images: 1, compacted: true,
    subagents: 1, model: 'claude-opus-5-5', recent: undefined });
  assert.deepEqual(preview.recent.map(m => [m.role, m.text.length, m.images ?? 0]), [['user', 12, 1], ['assistant', 401, 0]]);
  assert.ok(!JSON.stringify(preview).includes('secret output'));
  assert.deepEqual(await sessionPreview({ getSessionInfo: async () => undefined }, { sessionId: ID }), { session: null });
});

test('a reader bridge starts no query, and a started one reads no other saved session', async () => {
  const events = [];
  const calls = [];
  const history = {
    listSessions: async options => { calls.push(['list', options]); return [info(ID)]; },
    getSessionInfo: async id => { calls.push(['info', id]); return info(ID); },
    getSessionMessages: async (id, options) => { calls.push(['messages', id, options]); return [user('p1', 'Hi'), assistant('a1', [{ type: 'text', text: 'Hello' }])]; },
    listSubagents: async () => [],
    getSubagentMessages: async () => [],
  };
  const bridge = new ClaudeBridge({ query: () => { throw new Error('no query may start'); }, history, emit: event => events.push(event) });
  const response = id => events.find(e => e.type === 'response' && e.id === id);
  await bridge.handle({ id: 'list', op: 'sessions_list', limit: 5 });
  assert.equal(response('list').result.sessions[0].sessionId, ID);
  await bridge.handle({ id: 'info', op: 'session_info', sessionId: ID });
  assert.equal(response('info').result.session.cwd, '/work/app');
  await bridge.handle({ id: 'preview', op: 'session_preview', sessionId: ID });
  assert.equal(response('preview').result.prompts, 1);
  await bridge.handle({ id: 'relative', op: 'session_history_read', sessionId: ID, dir: 'work/app' });
  assert.match(response('relative').error, /absolute/);
  await bridge.handle({ id: 'read', op: 'session_history_read', sessionId: ID, dir: '/work/app' });
  const read = response('read').result;
  assert.deepEqual([read.total, read.main], [2, 2]);
  await bridge.handle({ id: 'index', op: 'history_index', readId: read.readId });
  assert.deepEqual(response('index').result.entries.map(e => [e.uuid, e.type]), [['p1', 'user'], ['a1', 'assistant']]);
  await bridge.handle({ id: 'close', op: 'history_close', readId: read.readId });
  assert.deepEqual(calls.at(-1), ['messages', ID, { dir: '/work/app', includeSystemMessages: true }]);
  assert.equal(bridge.started, false);

  // A bridge that started a query reads only the session it resumed.
  const output = new PromptQueue();
  output.initializationResult = async () => ({});
  const started = new ClaudeBridge({ query: () => output, history, emit: event => events.push(event), resolveCli: () => '/native/claude' });
  await started.handle({ id: 'start', op: 'start', cwd: process.cwd() });
  assert.equal(response('start').result?.started, true, response('start').error);
  for (const op of ['sessions_list', 'session_info', 'session_preview', 'session_history_read']) {
    await started.handle({ id: `started-${op}`, op, sessionId: ID, dir: '/work/app' });
    assert.match(response(`started-${op}`).error, /reads only the session it resumed/);
  }
  started.close();
});

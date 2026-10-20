import test from 'node:test';
import assert from 'node:assert/strict';
import { commandsReader, initFacts, safeCommands } from './commands.mjs';
import { ClaudeBridge, PromptQueue } from './bridge.mjs';

// T-29: the composer's slash list is the session's own (supportedCommands),
// held to a small shape; the session's init says which are Skills and which
// only work in a terminal.
const listed = [
  { name: 'compact', description: 'Clear history\nbut keep a summary', argumentHint: '<instructions>', builtin: true, aliases: ['c', 'bad alias'] },
  { name: 'yuzuno', description: 'Work in a Yuzuno Workspace', argumentHint: '' },
  { name: 'herdr', description: 'Control Herdr', argumentHint: '' },
  { name: 'exit', description: 'Exit the REPL', argumentHint: '', builtin: true },
  { name: 'two words', description: 'not a command name', argumentHint: '' },
  { name: '/slashed', description: 'leading slash', argumentHint: '' },
  { name: 'https://evil.test', description: 'a URL', argumentHint: '' },
  { name: 42 },
];

test('only names Claude Code listed, one token each, with bounded single-line text', () => {
  const out = safeCommands(listed, null);
  assert.deepEqual(out.commands.map(c => c.name), ['compact', 'yuzuno', 'herdr', 'exit']);
  assert.equal(out.commands[0].description, 'Clear history but keep a summary');
  assert.deepEqual(out.commands[0].aliases, ['c']);
  assert.equal(out.commands[0].source, 'builtin');
  // Before any init, a Skill cannot be told from another custom command.
  assert.equal(out.skillsKnown, false);
  assert.deepEqual(out.commands.slice(1).map(c => c.source), ['custom', 'custom', 'builtin']);
  assert.equal(safeCommands('not a list', null), null);
  const many = safeCommands(Array.from({ length: 600 }, (_, i) => ({ name: `c${i}`, description: 'x'.repeat(1000) })), null);
  assert.equal(many.commands.length, 512);
  assert.equal(many.truncated, true);
  assert.equal(many.commands[0].description.length, 300);
});

test("a session's init names its Skills and hides terminal-only commands", () => {
  const facts = initFacts({ type: 'system', subtype: 'init', skills: ['yuzuno'], terminal_slash_commands: ['exit'], session_id: 's' });
  const out = safeCommands(listed, facts);
  assert.deepEqual(out.commands.map(c => [c.name, c.source]), [['compact', 'builtin'], ['yuzuno', 'skill'], ['herdr', 'custom']]);
  assert.equal(out.hidden, 1);
  assert.equal(out.skillsKnown, true);
  assert.equal(initFacts({ type: 'system', subtype: 'status' }), null);
});

test('the reader reads the live query only, shares a read in flight and never starts one', async () => {
  const runtime = { ready: false, closed: false, query: null, sessionId: null };
  const reader = commandsReader(runtime);
  assert.deepEqual(await reader.read(), { state: 'unavailable' });
  let calls = 0;
  let release;
  runtime.query = { supportedCommands: () => { calls++; return new Promise(resolve => { release = () => resolve(listed); }); } };
  runtime.ready = true;
  runtime.sessionId = 's1';
  reader.observe({ type: 'system', subtype: 'init', skills: ['herdr'], session_id: 's1' });
  const [a, b] = [reader.read(), reader.read()];
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(calls, 1, 'one read for both callers');
  assert.equal(first, second);
  assert.equal(first.state, 'ready');
  assert.equal(first.sessionId, 's1');
  assert.equal(first.commands.find(c => c.name === 'herdr').source, 'skill');
  // The session changed while reading: that list is not this session's.
  runtime.query = { supportedCommands: async () => { runtime.sessionId = 's2'; return listed; } };
  assert.deepEqual(await reader.read(), { state: 'changed' });
  runtime.query = { supportedCommands: async () => { throw new Error('secret token in a native error'); } };
  assert.deepEqual(await reader.read(), { state: 'failed' });
  runtime.query = { supportedCommands: async () => { throw new Error('Unknown request: supported_commands'); } };
  assert.deepEqual(await reader.read(), { state: 'unsupported' });
  runtime.query = {};
  assert.deepEqual(await reader.read(), { state: 'unsupported' });
});

test("the bridge's commands op answers from its live query and keeps the latest init", async () => {
  const output = new PromptQueue();
  const events = [];
  let prompts = 0;
  const bridge = new ClaudeBridge({
    query: ({ prompt }) => {
      output.initializationResult = async () => ({});
      output.supportedCommands = async () => listed;
      (async () => { for await (const _ of prompt) prompts++; })();
      return output;
    },
    emit: event => events.push(event),
    resolveCli: () => '/fixture/claude',
    version: async () => '2.1.280',
  });
  await bridge.handle({ id: '1', op: 'commands' });
  assert.equal(events.at(-1).result.state, 'unavailable', 'nothing is started to answer');
  await bridge.handle({ id: '2', op: 'start', cwd: process.cwd() });
  output.push({ type: 'system', subtype: 'init', skills: ['yuzuno'], terminal_slash_commands: ['exit'], session_id: 'abc' });
  for (let i = 0; i < 50 && bridge.sessionId !== 'abc'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await bridge.handle({ id: '3', op: 'commands' });
  const result = events.find(e => e.type === 'response' && e.id === '3').result;
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.commands.map(c => [c.name, c.source]), [['compact', 'builtin'], ['yuzuno', 'skill'], ['herdr', 'custom']]);
  assert.equal(prompts, 0, 'reading sends no prompt');
  bridge.close();
});

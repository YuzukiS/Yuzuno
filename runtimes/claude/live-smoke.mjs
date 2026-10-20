// Opt-in: uses the user's existing native WSL Claude login. No credentials are read.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeBridge } from './bridge.mjs';

const cwd = resolve('../../acceptance/claude/runtime-task');
await mkdir(cwd, { recursive: true });
const marker = `CLAUDE-SLICE-${randomUUID()}`;
const events = [];
const runs = [];
let bridge;
let activeQuestion;
let onPermission;
let onEvent;
let counter = 0;

const waitUntil = async (test, label, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

const command = async value => {
  const id = `command-${++counter}`;
  await bridge.handle({ id, ...value });
  const response = events.find(event => event.type === 'response' && event.id === id);
  assert.ok(response, `Missing response ${id}`);
  if (response.error) throw new Error(response.error);
  return response.result;
};

const start = async sessionId => {
  bridge = new ClaudeBridge({
    query,
    options: {
      settingSources: [],
      settings: { permissions: { ask: ['Bash', 'Write'] } },
      tools: ['Read', 'Write', 'Bash', 'AskUserQuestion'],
      maxBudgetUsd: 1,
      effort: 'low',
    },
    emit: event => {
      events.push(event);
      if (event.type === 'permission') void onPermission?.(event);
      if (event.type === 'event') onEvent?.(event);
    },
  });
  await command({ op: 'start', cwd, model: 'haiku', ...(sessionId ? { sessionId } : {}) });
};

const turn = async (turnId, text) => {
  await command({ op: 'send', turnId, text });
  await waitUntil(() => events.some(event => event.type === 'event' && event.turnId === turnId && event.event.type === 'result') || bridge.closed, turnId);
  const result = events.find(event => event.type === 'event' && event.turnId === turnId && event.event.type === 'result');
  assert.ok(result, `Runtime exited without result: ${JSON.stringify(events.at(-1))}`);
  runs.push({ turnId, subtype: result.event.subtype, sessionId: result.event.session_id });
  return result.event;
};

try {
  await start();
  onPermission = async event => {
    await command({ op: 'respond', requestId: event.requestId, decision: 'allow' });
  };
  const first = await turn('write', `Remember the exact private test marker ${marker}. Use Write to create marker.txt in the current directory containing exactly that marker, then say READY. Do not run Bash or read other files.`);
  assert.equal(first.subtype, 'success');
  assert.equal((await readFile(resolve(cwd, 'marker.txt'), 'utf8')).trim(), marker);
  assert.ok(events.some(event => event.type === 'permission' && event.toolName === 'Write'), 'Native Write approval did not occur');

  onPermission = async event => {
    if (event.toolName === 'AskUserQuestion') {
      activeQuestion = event.requestId;
      const answers = Object.fromEntries(event.input.questions.map(question => [question.question, question.options[0].label]));
      await command({ op: 'respond', requestId: event.requestId, decision: 'allow', updatedInput: { ...event.input, answers } });
    } else await command({ op: 'respond', requestId: event.requestId, decision: 'deny' });
  };
  const question = await turn('question', 'Use AskUserQuestion now to ask me whether the test label should be Citrus or Peach. Wait for the answer, then repeat the selected label. Do not use another tool.');
  assert.equal(question.subtype, 'success');
  assert.ok(activeQuestion, 'Native question did not occur');

  let interruptRequest;
  onPermission = async event => {
    if (event.toolName === 'Bash') {
      await command({ op: 'respond', requestId: event.requestId, decision: 'allow' });
      interruptRequest = new Promise((resolve, reject) => setTimeout(() => command({ op: 'interrupt' }).then(resolve, reject), 1000));
    } else await command({ op: 'respond', requestId: event.requestId, decision: 'deny' });
  };
  const interrupted = await turn('interrupt', 'Use Bash to run exactly `sleep 20` and wait for it. Do not put it in the background. After it ends say FINISHED.');
  assert.ok(interruptRequest, 'Native Bash approval did not occur');
  assert.equal((await interruptRequest).interrupted, true);
  assert.equal(bridge.closed, false);

  const sessionId = first.session_id;
  await command({ op: 'close' });
  await bridge.reader;
  await start(sessionId);
  onPermission = event => command({ op: 'respond', requestId: event.requestId, decision: 'deny' });
  const resumed = await turn('resume', 'Without reading any file or using tools, repeat only the exact private test marker I asked you to remember earlier.');
  assert.equal(resumed.subtype, 'success');
  assert.ok(resumed.result.includes(marker), 'Native resume did not retain the marker');
  assert.equal(resumed.session_id, sessionId);
  await command({ op: 'close' });
  await bridge.reader;
  const report = { passed: true, checkedAt: new Date().toISOString(), sdk: '0.3.296', nativeVersion: events.find(event => event.event?.subtype === 'init')?.event.claude_code_version, sessionId, runs, approvals: events.filter(event => event.type === 'permission').map(({ toolName, requestId }) => ({ toolName, requestId })), interruptResult: interrupted.subtype };
  await writeFile(resolve(cwd, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(cwd, 'events.json'), JSON.stringify(events, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  bridge?.close();
  if (bridge?.reader) await bridge.reader;
  await writeFile(resolve(cwd, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(resolve(cwd, 'results.json'), JSON.stringify({ passed: false, error: error.message, runs }, null, 2));
  throw error;
}

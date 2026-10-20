// T-25 capability probe: what the installed Claude Code (via the Agent SDK
// Yuzuno ships) reports for background tasks, and what stopTask does. No
// Yuzuno Core: the SDK alone, in its own folder, with the user's own Claude
// login and Haiku. Only the probe's own `sleep`/`echo` Bash commands are
// allowed; every other tool is denied.
//
// 1. One turn starts two background shells (25 s and 50 s) and ends.
// 2. After the turn: stopTask(the 50 s one); the 25 s one goes on.
// 3. stopTask again on the stopped task, and on an id that never existed.
// 4. Wait for the 25 s one to finish by itself; record what follows.
//
// Usage: probe.mjs <runtime dir with node_modules> <out dir>.
// Writes frames.jsonl (task/background frames, results, tool calls, bounded)
// and report.json.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtime, out] = process.argv.slice(2).map(p => resolve(p));
assert.ok(runtime && out);
const { query } = await import(pathToFileURL(resolve(runtime, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')));
const sdkVersion = (await import(pathToFileURL(resolve(runtime, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json')), { with: { type: 'json' } })).default.version;
const cwd = resolve(out, 'project');
mkdirSync(cwd, { recursive: true });
const t0 = Date.now();
const at = () => Date.now() - t0;
const report = { sdkVersion, startedAt: new Date().toISOString(), steps: [], tasks: {}, results: 0, errors: [] };
const step = (name, data = {}) => { report.steps.push({ at: at(), name, ...data }); console.log(at(), name, JSON.stringify(data).slice(0, 300)); };
const frame = (kind, data) => appendFileSync(resolve(out, 'frames.jsonl'), JSON.stringify({ at: at(), kind, ...data }) + '\n');

let push;
const queue = [];
async function* inputs() {
  while (true) {
    const next = queue.shift() ?? await new Promise(done => { push = done; });
    if (next === null) return;
    yield next;
  }
}
const send = message => { if (push) { const p = push; push = null; p(message); } else queue.push(message); };
const allowed = /^(sleep \d+; echo (alpha|beta)-done)$/;
const q = query({
  prompt: inputs(),
  options: {
    cwd, model: 'haiku', permissionMode: 'default', settingSources: ['user', 'project', 'local'],
    // The installed CLI, as the bridge resolves it from PATH.
    pathToClaudeCodeExecutable: process.env.T25_CLI,
    systemPrompt: { type: 'preset', preset: 'claude_code' }, persistSession: false,
    canUseTool: async (tool, input) => tool === 'Bash' && allowed.test(String(input.command ?? '').trim())
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'This probe allows only its own two sleep/echo commands.' },
  },
});

const ended = new Map(); // task id -> notification
let firstResult, liveSet = [];
const reader = (async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') frame('init', { cli: m.claude_code_version, model: m.model, session: m.session_id });
    if (m.type === 'system' && /^task_/.test(m.subtype ?? '')) {
      const { type, uuid, session_id, ...rest } = m;
      frame(m.subtype, rest);
      const t = report.tasks[m.task_id] ??= { events: [] };
      t.events.push(m.subtype);
      if (m.subtype === 'task_started') Object.assign(t, { type: m.task_type, toolUseId: m.tool_use_id, background: m.is_backgrounded, description: m.description, runId: m.run_id });
      if (m.subtype === 'task_notification') { t.status = m.status; t.summary = m.summary; t.outputFile = m.output_file; t.reason = m.reason; ended.set(m.task_id, m); }
    }
    if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      liveSet = m.tasks;
      frame('background_tasks_changed', { tasks: m.tasks.map(({ task_id, task_type, description, run_id, ambient }) => ({ task_id, task_type, description, run_id, ambient })) });
    }
    if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') frame('tool_use', { id: b.id, name: b.name, input: b.input });
    if (m.type === 'user') for (const b of m.message?.content ?? []) if (b.type === 'tool_result') frame('tool_result', { id: b.tool_use_id, text: JSON.stringify(b.content).slice(0, 300) });
    if (m.type === 'result') {
      report.results += 1;
      frame('result', { subtype: m.subtype, n: report.results, text: String(m.result ?? '').slice(0, 200) });
      firstResult ??= at();
    }
  }
})().catch(error => report.errors.push(`reader: ${error.message}`));

const until = async (fn, ms, label) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
  throw Error(`Timed out: ${label}`);
};
async function stop(id, label) {
  const started = at();
  try { await q.stopTask(id); step(`stopTask ${label}: resolved`, { id, ms: at() - started }); return 'resolved'; }
  catch (error) { step(`stopTask ${label}: rejected`, { id, ms: at() - started, error: String(error?.message ?? error).slice(0, 300) }); return 'rejected'; }
}

try {
  send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content:
    'Start these two shell commands in the background with the Bash tool, each with run_in_background set to true, ' +
    'then reply with the single word started without waiting for them: `sleep 25; echo alpha-done` and `sleep 50; echo beta-done`.' } });
  await until(() => firstResult, 120000, 'the first turn');
  step('first turn ended', { results: report.results, live: liveSet.map(t => [t.task_id, t.task_type, t.description]) });
  const shells = () => Object.entries(report.tasks).filter(([, t]) => t.type === 'local_bash');
  await until(() => shells().length >= 2, 20000, 'two shell tasks');
  const alpha = shells().find(([, t]) => /alpha/.test(t.description ?? ''))?.[0];
  const beta = shells().find(([, t]) => /beta/.test(t.description ?? ''))?.[0];
  step('shell tasks', { alpha, beta, tasks: report.tasks });
  report.stop = { beta: await stop(beta, 'running beta (after the turn)') };
  await until(() => ended.has(beta), 20000, 'beta stopped notification');
  step('beta ended', { notification: report.tasks[beta], alphaEnded: ended.has(alpha) });
  report.stop.again = await stop(beta, 'beta again (already stopped)');
  report.stop.unknown = await stop('t88nonexistent', 'an id that never existed');
  await until(() => ended.has(alpha), 60000, 'alpha completes by itself');
  step('alpha ended', { notification: report.tasks[alpha] });
  report.stop.finished = await stop(alpha, 'alpha after it completed');
  // Whatever Claude does with the notifications (a turn of its own, or none).
  await new Promise(r => setTimeout(r, 20000));
  step('settled', { results: report.results, live: liveSet.map(t => t.task_id) });
  report.passed = true;
} catch (error) {
  report.errors.push(String(error?.stack ?? error).slice(0, 1000));
} finally {
  send(null);
  q.close?.();
  await Promise.race([reader, new Promise(r => setTimeout(r, 5000))]);
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
process.exit(report.passed ? 0 : 1);

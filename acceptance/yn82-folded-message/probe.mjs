// YN-82 offline probe: what Claude Code sends when it folds a message queued
// while it works into the running turn, and what the bridge reports for it.
// Real Claude Code CLI + pinned SDK + this checkout's bridge, a fresh profile
// and a local API fixture: no model, no login, no Core.
//
//   node probe.mjs <SDK entry sdk.mjs> <claude executable> <report.json>
//
// Each phase runs one prompt whose first answer is a Read call. The fixture
// holds that answer until the follow-up is queued, so Claude Code takes the
// follow-up in after the tool round. Phase "sdk" records the SDK frames;
// phase "bridge" drives ClaudeBridge (send, then append) and records what it
// emits, message_delivery included.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ClaudeBridge, PromptQueue } from '../../runtimes/claude/bridge.mjs';

const [sdkEntry, cliArg, out] = process.argv.slice(2);
if (!sdkEntry || !cliArg || !out) throw new Error('usage: probe.mjs <sdk.mjs> <claude> <report.json>');
// Claude Code runs in the fixture folder, so its path must not be relative.
const cli = resolve(cliArg);
const root = await mkdtemp(join(tmpdir(), 'yn82-'));
const profile = join(root, 'profile');
const home = join(root, 'home');
await mkdir(profile); await mkdir(home);
await writeFile(join(root, 'note.txt'), 'fixture note\n');
const { query } = await import(pathToFileURL(sdkEntry).href);
const MODEL = 'claude-sonnet-4-6';
const FIRST = 'YN82-FIRST: read note.txt';
const FOLLOW = 'YN82-FOLLOW-UP: also say hello';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { root, cli, sdkEntry, phases: {} };

// One phase's fixture: the first main-loop request is held until release().
let phase = null;
function newPhase(name) {
  let release; let held;
  const released = new Promise(resolve => { release = resolve; });
  const heldRequest = new Promise(resolve => { held = resolve; });
  phase = { name, requests: [], release, released, held, heldRequest };
  return phase;
}
const textOf = content => (typeof content === 'string' ? content
  : (content ?? []).map(b => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `[tool_result ${b.tool_use_id}]` : `[${b.type}]`)).join(' | '));
function sse(res, message, blocks, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [{ type: 'message_start', message }];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
  let parsed = {}; try { parsed = JSON.parse(body); } catch { /* not JSON */ }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const last = messages.at(-1);
  const all = JSON.stringify(messages);
  const main = Array.isArray(parsed.tools) && parsed.tools.some(t => t.name === 'Read');
  const toolResult = Array.isArray(last?.content) && last.content.some(b => b.type === 'tool_result');
  const entry = { url: req.url, main, messages: messages.length, toolResult, followUpSeen: all.includes(FOLLOW),
    lastUser: last?.role === 'user' ? textOf(last.content).slice(0, 600) : null };
  phase?.requests.push(entry);
  const message = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', content: [], model: MODEL,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  if (main && all.includes(FIRST) && !toolResult && !all.includes('toolu_yn82')) {
    entry.answer = 'tool_use (held)';
    phase?.held();
    await phase?.released;
    sse(res, message, [{ type: 'tool_use', id: 'toolu_yn82_read', name: 'Read', input: { file_path: join(root, 'note.txt') } }], 'tool_use');
    return;
  }
  entry.answer = 'text';
  sse(res, message, [{ type: 'text', text: entry.followUpSeen ? 'Fixture saw the follow-up.' : 'Fixture reply.' }], 'end_turn');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: 'yn82-local-fixture',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' });
const fixtureOptions = { env, settingSources: [], tools: ['Read'], allowedTools: ['Read'] };

// The fields that say which prompt a frame answers or which command it is about.
const summary = frame => Object.fromEntries(Object.entries({
  type: frame.type, subtype: frame.subtype, uuid: frame.uuid, user_message_uuid: frame.user_message_uuid,
  user_message_uuids: frame.user_message_uuids, command_uuid: frame.command_uuid, state: frame.state,
  origin: frame.origin?.kind, isReplay: frame.isReplay, priority: frame.priority, parent_tool_use_id: frame.parent_tool_use_id ?? undefined,
  event: frame.type === 'stream_event' ? frame.event?.type : undefined,
  content: frame.type === 'user' || frame.type === 'assistant' ? textOf(frame.message?.content).slice(0, 300) : undefined,
  capabilities: frame.subtype === 'init' ? frame.capabilities : undefined, claude_code_version: frame.claude_code_version,
}).filter(([, value]) => value !== undefined));
const quiet = (rows, ms) => new Promise(resolve => {
  let seen = rows.length; const timer = setInterval(() => { if (rows.length === seen) { clearInterval(timer); resolve(); } seen = rows.length; }, ms);
});
const until = async (check, ms) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await sleep(50); return check(); };

async function sdkPhase() {
  const p = newPhase('sdk');
  const first = randomUUID(); const follow = randomUUID();
  const frames = [];
  const prompts = new PromptQueue();
  const q = query({ prompt: prompts, options: { cwd: root, pathToClaudeCodeExecutable: cli, model: MODEL, persistSession: false,
    permissionMode: 'default', includePartialMessages: true, ...fixtureOptions } });
  const reading = (async () => { for await (const frame of q) frames.push(summary(frame)); })();
  prompts.push({ type: 'user', message: { role: 'user', content: FIRST }, parent_tool_use_id: null, uuid: first });
  await Promise.race([p.heldRequest, sleep(60_000)]);
  prompts.push({ type: 'user', message: { role: 'user', content: FOLLOW }, parent_tool_use_id: null, uuid: follow });
  await until(() => frames.some(f => f.command_uuid === follow), 5000);
  p.release();
  await until(() => frames.some(f => f.type === 'result'), 60_000);
  await quiet(frames, 3000);
  q.close(); prompts.close();
  await reading.catch(error => { report.phases.sdkError = String(error); });
  return { first, follow, frames: frames.filter(f => f.type !== 'stream_event' || f.user_message_uuid), requests: p.requests };
}

async function bridgePhase() {
  const p = newPhase('bridge');
  const first = randomUUID(); const follow = randomUUID();
  const emitted = [];
  const bridge = new ClaudeBridge({ query, emit: event => emitted.push(event), options: fixtureOptions });
  const reply = id => emitted.find(e => e.type === 'response' && e.id === id);
  await bridge.handle({ id: 'start', op: 'start', cwd: root, executable: cli, model: MODEL });
  if (reply('start')?.error) throw new Error(`bridge start: ${reply('start').error}`);
  await bridge.handle({ id: 'send', op: 'send', turnId: 'turn-1', uuid: first, text: FIRST });
  await Promise.race([p.heldRequest, sleep(60_000)]);
  await bridge.handle({ id: 'append', op: 'append', expectedTurnId: 'turn-1', clientMessageId: 'client-follow',
    followUpTurnId: 'turn-follow', uuid: follow, text: FOLLOW });
  await until(() => emitted.some(e => e.event?.command_uuid === follow), 5000);
  p.release();
  await until(() => emitted.some(e => e.event?.type === 'result'), 60_000);
  await quiet(emitted, 3000);
  await bridge.handle({ id: 'close', op: 'close' });
  await bridge.reader?.catch(() => {});
  const rows = emitted.filter(e => e.type !== 'event' || e.event?.type !== 'stream_event' || e.event?.user_message_uuid).map(e => (e.type === 'event'
    ? { emitted: 'event', turnId: e.turnId, nativeTurnId: e.nativeTurnId, ...summary(e.event) }
    : e.type === 'message_delivery' ? { emitted: 'message_delivery', clientMessageId: e.clientMessageId, status: e.status, turnId: e.turnId }
      : { emitted: e.type, id: e.id, error: e.error }));
  // The reply to the follow-up is the first assistant frame after Claude
  // Code says it took the follow-up in; accepted before it means the user
  // sees it received while the turn still runs, not only when it ends.
  const takenAt = rows.findIndex(r => r.type === 'command_lifecycle' && r.command_uuid === follow && r.state === 'started');
  const replyAt = rows.findIndex((r, i) => i > takenAt && takenAt !== -1 && r.type === 'assistant');
  const acceptedAt = rows.findIndex(r => r.emitted === 'message_delivery' && r.status === 'accepted');
  return { first, follow, rows, requests: p.requests,
    verdict: { followUpReachedModel: p.requests.some(r => r.followUpSeen), takenAt, replyAt, acceptedAt,
      resultAt: rows.findIndex(r => r.type === 'result'), deliveries: rows.filter(r => r.emitted === 'message_delivery').length,
      acceptedBeforeReply: acceptedAt !== -1 && replyAt !== -1 && acceptedAt < replyAt } };
}

try {
  report.phases.sdk = await sdkPhase();
  report.phases.bridge = await bridgePhase();
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  phase?.release();
  server.close();
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: out, error: report.error, verdict: report.phases.bridge?.verdict }));
  process.exit(0);
}

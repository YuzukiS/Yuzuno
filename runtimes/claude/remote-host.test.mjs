import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YUZUNO_HOST_POLL_MS = '50';
process.env.YUZUNO_HOST_EXIT_MS = '300';
process.env.YUZUNO_HOST_KILL_MS = '300';
const { RemoteHost, DENY_MESSAGE, busy, idle } = await import('./remote-host.mjs');

// A scripted bridge, run as a real child process: it accepts one start, a
// send opens a turn that asks for approval (or works for `ms` without one),
// and it records every command it gets.
const FAKE_BRIDGE = `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const log = process.env.FAKE_LOG;
let started = false, turn = null, pending = new Set(), asks = 0, asked = 0;
const out = v => process.stdout.write(JSON.stringify(v) + '\\n');
const ask = () => { const id = 'r' + (++asked); pending.add(id); out({ type: 'permission', turnId: 't1', requestId: id, toolName: 'Bash' }); };
const end = extra => setTimeout(() => { turn = null; out({ type: 'event', event: { type: 'result', ...extra } }); }, 30);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  appendFileSync(log, JSON.stringify(c) + '\\n');
  const reply = (result, error) => out({ type: 'response', id: c.id, ...(error ? { error } : { result }) });
  switch (c.op) {
    case 'start':
      if (started) return reply(null, 'already started');
      started = true; return reply({ started: true, sessionId: 'session-1' });
    case 'send':
      turn = 't1';
      reply({ accepted: true });
      // hidden: an approval the bridge counts but has not announced.
      if (c.hidden) pending.add('unannounced');
      else if (c.ask) { asks = c.ask === true ? 1 : c.ask; ask(); }
      else setTimeout(() => { turn = null; out({ type: 'event', event: { type: 'result' } }); }, c.ms || 0);
      return;
    case 'respond':
      pending.delete(c.requestId);
      reply({ answered: true });
      if (asked < asks) setTimeout(ask, 30); else end({ decision: c.decision });
      return;
    case 'interrupt':
      pending.clear();
      reply({ interrupted: true });
      end({ interrupted: true });
      return;
    case 'status':
      if (process.env.FAKE_STATUS === 'silent') return;
      return reply({ ready: started, turnId: turn, pendingCount: pending.size, configuring: false, interrupting: false });
    default: return reply({});
  }
});
// FAKE_STUBBORN: 1 ignores the end of stdin (SIGTERM still ends it), 2 also
// ignores SIGTERM.
if (process.env.FAKE_STUBBORN === '2') process.on('SIGTERM', () => {});
if (process.env.FAKE_STUBBORN) setInterval(() => {}, 1000);
else process.stdin.on('end', () => process.exit(0));
`;

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'yuzuno-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, 'fake-bridge.mjs');
  writeFileSync(bridge, FAKE_BRIDGE);
  const commands = join(root, 'commands.jsonl');
  writeFileSync(commands, '');
  process.env.FAKE_LOG = commands;
  let exited;
  const stopped = new Promise(resolve => { exited = resolve; });
  const host = new RemoteHost({ root, bridge, exit: code => exited(code) });
  t.after(() => host.shutdown('test over'));
  const received = () => readFileSync(commands, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const log = () => readFileSync(join(root, 'host.log'), 'utf8').trim().split('\n').map(JSON.parse);
  return { host, root, stopped, received, log };
}

/** A client on the host's socket: send commands, wait for frames. */
async function client(path) {
  const socket = net.connect(path);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const frames = [];
  let waiting = null;
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
      waiting?.();
    }
  });
  const closed = new Promise(resolve => socket.once('close', resolve));
  return {
    socket, frames, closed,
    send: command => socket.write(JSON.stringify(command) + '\n'),
    async next(match, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const found = frames.find(match);
        if (found) return found;
        if (Date.now() > end) throw new Error(`no frame matched; got ${JSON.stringify(frames)}`);
        await new Promise(resolve => { waiting = resolve; setTimeout(resolve, 50); });
      }
    },
  };
}

test('busy() is true only while the bridge has work', () => {
  assert.equal(busy(null), false);
  assert.equal(busy({ turnId: null, pendingCount: 0 }), false);
  assert.equal(busy({ turnId: 't1', pendingCount: 0 }), true);
  assert.equal(busy({ turnId: null, pendingCount: 1 }), true);
  assert.equal(busy({ turnId: null, pendingCount: 0, interrupting: true }), true);
});

test('idle() is true only for a started bridge that said it has no work', () => {
  const quiet = { ready: true, turnId: null, pendingCount: 0, configuring: false, interrupting: false };
  assert.equal(idle(quiet), true);
  assert.equal(idle(null), false, 'no answer is not idle');
  for (const change of [{ ready: false }, { turnId: 't1' }, { pendingCount: 1 }, { configuring: true }, { interrupting: true }, { configuring: undefined }]) {
    assert.equal(idle({ ...quiet, ...change }), false, JSON.stringify(change));
  }
});

test('its own state is published before its socket accepts anyone, replacing what an earlier host left (T-156)', async t => {
  const { host, root } = setup(t);
  // An earlier host died mid-turn and left this behind.
  writeFileSync(join(root, 'state.json'), JSON.stringify({ pid: 1, attached: false, busy: true, turnId: 't-earlier' }));
  // The helper takes a socket that answers as this host being ready, then reads state.json.
  let listeningAtFirstState;
  const state = host.state.bind(host);
  host.state = extra => { listeningAtFirstState ??= !!host.server?.listening; state(extra); };
  await host.listen();
  assert.equal(listeningAtFirstState, false);
  const published = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  assert.equal(published.pid, process.pid);
  assert.equal(published.busy, undefined);
});

test('a connection that sends nothing (a liveness check) neither attaches nor stops the host', async t => {
  const { host, log } = setup(t);
  await host.listen();
  const probe = await client(host.socketPath);
  probe.socket.destroy();
  await probe.closed;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(host.stopping, false);
  assert.equal(host.client, null);
  assert.ok(!log().some(entry => ['attached', 'detached', 'stopping'].includes(entry.event)));
  const real = await client(host.socketPath);
  real.send({ op: 'start', id: '1', cwd: '/tmp' });
  assert.ok((await real.next(f => f.id === '1')).result.started);
});

test("a client's commands reach the bridge and the bridge's frames come back", async t => {
  const { host } = setup(t);
  await host.listen();
  const c = await client(host.socketPath);
  c.send({ op: 'start', id: '1', cwd: '/tmp' });
  const response = await c.next(f => f.type === 'response' && f.id === '1');
  assert.deepEqual(response.result, { started: true, sessionId: 'session-1' });
  c.send({ op: 'send', id: '2', ms: 10 });
  await c.next(f => f.type === 'event');
  assert.equal(host.started, true);
  // The host's own status questions never reach the client.
  assert.ok(c.frames.every(f => !String(f.id ?? '').startsWith('host-')));
});

test('a client gone while an approval waits: the host denies it, never allows it, lets the turn end and stops', async t => {
  const { host, stopped, received, log } = setup(t);
  await host.listen();
  const c = await client(host.socketPath);
  c.send({ op: 'start', id: '1', cwd: '/tmp' });
  await c.next(f => f.id === '1');
  c.send({ op: 'send', id: '2', ask: true });
  await c.next(f => f.type === 'permission');
  c.socket.destroy();
  assert.equal(await stopped, 0);
  const answers = received().filter(command => command.op === 'respond');
  assert.deepEqual(answers.map(a => [a.requestId, a.decision, a.message]), [['r1', 'deny', DENY_MESSAGE]]);
  const events = log().map(entry => entry.event);
  assert.deepEqual(events.filter(e => ['detached', 'denied', 'stopping', 'bridgeClosed'].includes(e)), ['detached', 'denied', 'stopping', 'bridgeClosed']);
  assert.equal(log().find(entry => entry.event === 'stopping').reason, 'idle without a client');
  // The log holds lifecycle events, not protocol content.
  assert.ok(!readFileSync(join(host.root, 'host.log'), 'utf8').includes('session-1'));
});

test('an approval asked after the client left is denied too, never allowed; then the host stops (R1)', async t => {
  const { host, stopped, received, log } = setup(t);
  await host.listen();
  const c = await client(host.socketPath);
  c.send({ op: 'start', id: '1', cwd: '/tmp' });
  await c.next(f => f.id === '1');
  c.send({ op: 'send', id: '2', ask: 2 });
  await c.next(f => f.type === 'permission');
  c.socket.destroy();
  assert.equal(await stopped, 0);
  const answers = received().filter(command => command.op === 'respond');
  assert.deepEqual(answers.map(a => [a.requestId, a.decision]), [['r1', 'deny'], ['r2', 'deny']]);
  assert.deepEqual(log().filter(entry => entry.event === 'denied').map(entry => entry.requestId), ['r1', 'r2']);
});

test('an approval the bridge counts but never announced: the turn is interrupted, nothing is allowed, the host stops', async t => {
  const { host, stopped, received, log } = setup(t);
  await host.listen();
  const c = await client(host.socketPath);
  c.send({ op: 'start', id: '1', cwd: '/tmp' });
  await c.next(f => f.id === '1');
  c.send({ op: 'send', id: '2', hidden: true });
  await c.next(f => f.id === '2');
  c.socket.destroy();
  assert.equal(await stopped, 0);
  assert.equal(received().filter(command => command.op === 'interrupt').length, 1);
  assert.equal(received().filter(command => command.op === 'respond').length, 0);
  assert.ok(log().some(entry => entry.event === 'interrupting'));
});

test('a new client while the earlier turn still runs is refused; it may come back once that turn ends', async t => {
  const { host, stopped } = setup(t);
  await host.listen();
  const first = await client(host.socketPath);
  first.send({ op: 'start', id: '1', cwd: '/tmp' });
  await first.next(f => f.id === '1');
  first.send({ op: 'send', id: '2', ms: 600 });
  await first.next(f => f.id === '2');
  first.socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = await client(host.socketPath);
  second.send({ op: 'start', id: '1', cwd: '/tmp', sessionId: 'session-1' });
  const refusal = await second.next(f => f.type === 'disconnected');
  assert.equal(refusal.hostBusy, true);
  await second.closed;
  // With no client, the host stops once the turn has ended.
  assert.equal(await stopped, 0);
});

test('another client while the bridge is idle replaces the first, with a fresh bridge for its own start', async t => {
  const { host, received } = setup(t);
  await host.listen();
  const first = await client(host.socketPath);
  first.send({ op: 'start', id: '1', cwd: '/tmp' });
  await first.next(f => f.id === '1');
  const second = await client(host.socketPath);
  second.send({ op: 'start', id: '1', cwd: '/tmp', sessionId: 'session-1' });
  await first.closed;
  const response = await second.next(f => f.id === '1');
  assert.ok(response.result?.started, 'a fresh bridge accepted the second start');
  assert.equal(received().filter(command => command.op === 'start').length, 2);
});

test('host_stop on an idle host closes the bridge, waits for its exit and says so; the host exits once the client closes (T-184)', async t => {
  const { host, root, stopped, received, log } = setup(t);
  await host.listen();
  const c = await client(host.socketPath);
  c.send({ op: 'start', id: '1', cwd: '/tmp' });
  await c.next(f => f.id === '1');
  c.send({ op: 'host_stop', id: '2' });
  const answer = await c.next(f => f.id === '2');
  assert.deepEqual(answer.result, { stopped: true, exit: { code: 0, signal: null } });
  assert.equal(host.bridge, null);
  assert.ok(!received().some(command => command.op === 'host_stop'), 'the host answers it; the bridge never sees it');
  // Stopping: a reconnect waits rather than attach (remote_helper.py claude_ensure).
  assert.equal(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).stopping, true);
  const late = await client(host.socketPath);
  await late.closed;
  assert.equal(late.frames.length, 0, 'no new client is taken');
  c.send({ op: 'send', id: '3', ms: 10 });
  assert.match((await c.next(f => f.id === '3')).error, /stopping/);
  c.socket.end();
  assert.equal(await stopped, 0);
  const stopping = log().filter(entry => entry.event === 'stopping');
  assert.deepEqual(stopping.map(entry => entry.reason), ['disconnected by the user']);
  assert.equal(log().find(entry => entry.event === 'bridgeClosed').exited, true);
  assert.equal(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).stopped, true);
});

test('host_stop while a turn runs or an approval waits is refused and changes nothing (T-184)', async t => {
  const { host, received } = setup(t);
  await host.listen();
  const c = await client(host.socketPath);
  c.send({ op: 'start', id: '1', cwd: '/tmp' });
  await c.next(f => f.id === '1');
  c.send({ op: 'send', id: '2', ms: 400 });
  await c.next(f => f.id === '2');
  c.send({ op: 'host_stop', id: '3' });
  assert.deepEqual((await c.next(f => f.id === '3')).result, { stopped: false, reason: 'Claude on this machine is not idle' });
  await c.next(f => f.type === 'event');
  c.send({ op: 'send', id: '4', ask: true });
  await c.next(f => f.type === 'permission');
  c.send({ op: 'host_stop', id: '5' });
  assert.equal((await c.next(f => f.id === '5')).result.stopped, false);
  assert.equal(host.stopping, false);
  assert.ok(host.bridge, 'the bridge is kept');
  // The same client goes on as before.
  c.send({ op: 'respond', id: '6', requestId: 'r1', decision: 'allow' });
  await c.next(f => f.id === '6');
  assert.deepEqual(received().filter(command => command.op === 'respond').map(command => command.decision), ['allow']);
});

test('host_stop before the bridge has started, or when it does not answer its status, is refused (T-184)', async t => {
  // This bridge never answers a status question (it reads the variable as it starts).
  process.env.FAKE_STATUS = 'silent';
  t.after(() => { delete process.env.FAKE_STATUS; });
  const { host } = setup(t);
  await host.listen();
  const c = await client(host.socketPath);
  c.send({ op: 'host_stop', id: '1' });
  assert.equal((await c.next(f => f.id === '1')).result.stopped, false, 'nothing started: no status to trust');
  c.send({ op: 'start', id: '2', cwd: '/tmp' });
  await c.next(f => f.id === '2');
  c.send({ op: 'host_stop', id: '3' });
  assert.deepEqual((await c.next(f => f.id === '3', 15000)).result, { stopped: false, reason: "Claude on this machine didn't answer whether it is idle" });
  assert.equal(host.stopping, false);
  assert.ok(host.bridge);
  delete process.env.FAKE_STATUS;
});

test('a bridge that only ends after SIGTERM, or not at all, is an unconfirmed stop, never stopped (T-184)', async t => {
  const forced = { stopped: null, reason: 'the Claude bridge on this machine only ended after SIGTERM, so its Claude CLI may not have stopped' };
  const never = { stopped: null, reason: "the Claude bridge on this machine didn't exit, even after SIGTERM" };
  for (const [stubborn, expected] of [['1', forced], ['2', never]]) {
    process.env.FAKE_STUBBORN = stubborn;
    t.after(() => { delete process.env.FAKE_STUBBORN; });
    const { host, stopped } = setup(t);
    await host.listen();
    const c = await client(host.socketPath);
    c.send({ op: 'start', id: '1', cwd: '/tmp' });
    await c.next(f => f.id === '1');
    const pid = host.bridge.pid;
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
    c.send({ op: 'host_stop', id: '2' });
    assert.deepEqual((await c.next(f => f.id === '2')).result, expected);
    c.socket.end();
    assert.equal(await stopped, 0);
    delete process.env.FAKE_STUBBORN;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YUZUNO_HOST_POLL_MS = '50';
const { RemoteHost, DENY_MESSAGE, busy } = await import('./remote-host.mjs');

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
    case 'status': return reply({ ready: started, turnId: turn, pendingCount: pending.size });
    default: return reply({});
  }
});
process.stdin.on('end', () => process.exit(0));
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

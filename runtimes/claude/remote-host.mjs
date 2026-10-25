// The remote side of a Claude Agent on another machine (T-28). Core reaches
// this host through SSH; it keeps one bridge (bridge.mjs, unchanged) for one
// Agent running on this machine while SSH connections come and go:
//
// - One client at a time, on a private Unix socket. Its lines go to the
//   bridge's stdin and the bridge's lines come back, as if Core had spawned
//   the bridge itself.
// - When the client goes (SSH dropped, Core stopped), the turn goes on here.
//   A pending approval is denied, never allowed, so the turn can end; frames
//   the bridge writes meanwhile are not kept. Once the bridge is idle the host
//   closes it and exits. What the turn did is in Claude's own saved session,
//   which Core reads when it resumes that session.
// - A new client while the bridge still works is refused: two queries must
//   never write one native session. An idle bridge is replaced by a fresh one
//   so the new client starts (and resumes) a session of its own.
// - The user's Disconnect (T-184): the client asks the host itself to stop
//   (`host_stop`). A host whose bridge says it is idle closes it and says
//   stopped only when it ended on its own, at once and cleanly, as when its
//   input ends; a bridge that needed SIGTERM may have left its Claude CLI
//   behind, so that stop is unconfirmed. Any doubt about idle refuses and
//   changes nothing. Closing SSH alone could not tell Core the bridge had
//   stopped.
//
// It reads no credentials (the installed Claude CLI owns them) and logs only
// lifecycle events, never protocol content.
//
// Usage: node remote-host.mjs serve <private runtime dir>
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const DENY_MESSAGE = 'Yuzuno lost its connection to this machine before anyone answered; not approved.';
const IDLE_POLL_MS = Number(process.env.YUZUNO_HOST_POLL_MS || 2000);
const FIRST_CLIENT_MS = Number(process.env.YUZUNO_HOST_FIRST_CLIENT_MS || 60_000);
const HOST_REPLY_MS = 10_000;
const BRIDGE_EXIT_MS = Number(process.env.YUZUNO_HOST_EXIT_MS || 8000);
// After SIGTERM, how long a bridge's exit is still awaited before it is
// reported as not seen.
const BRIDGE_KILL_MS = Number(process.env.YUZUNO_HOST_KILL_MS || 5000);
// After host_stop has answered, how long the client has to close.
const CLIENT_CLOSE_MS = 10_000;
const STDERR_TAIL = 16 * 1024;

/** True while the bridge has work that a new query would collide with. */
export function busy(status) {
  return !!status && !!(status.turnId || status.pendingCount || status.configuring || status.interrupting);
}

/** True only when the bridge has said it is started and has no work: an
 * unanswered status is not idle (as Core's updates/lifecycle claude_idle). */
export function idle(status) {
  return !!status && status.ready === true && status.turnId === null && status.pendingCount === 0
    && status.configuring === false && status.interrupting === false;
}

export class RemoteHost {
  constructor({ root, bridge, spawnBridge = defaultSpawn, now = () => new Date().toISOString(), exit = code => process.exit(code) }) {
    this.root = root;
    this.bridgePath = bridge;
    this.spawnBridge = spawnBridge;
    this.now = now;
    this.exit = exit;
    this.socketPath = join(root, 'claude.sock');
    this.bridge = null;
    this.client = null;
    this.started = false;
    this.pending = new Set();
    this.replies = new Map();
    this.nextReply = 0;
    this.stderrTail = '';
    this.stopping = false;
    this.detachedWork = null;
  }

  log(event, data = {}) {
    try { appendFileSync(join(this.root, 'host.log'), JSON.stringify({ at: this.now(), event, ...data }) + '\n', { mode: 0o600 }); } catch {}
  }

  state(extra = {}) {
    const value = { pid: process.pid, attached: !!this.client, started: this.started, pendingCount: this.pending.size, stopping: this.stopping, updatedAt: this.now(), ...extra };
    try {
      const temporary = join(this.root, `state.${process.pid}.tmp`);
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, join(this.root, 'state.json'));
    } catch {}
  }

  async listen() {
    rmSync(this.socketPath, { force: true });
    // Before the socket accepts anyone: the helper takes a socket that answers
    // as this host being ready and then reads state.json, which must be this
    // host's own, not what an earlier one left (T-156).
    this.state();
    this.server = net.createServer(socket => this.connection(socket));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socketPath, resolve); });
    chmodSync(this.socketPath, 0o600);
    this.log('listening', { pid: process.pid });
    this.firstClient = setTimeout(() => { if (!this.client && !this.started) this.shutdown('no client came'); }, FIRST_CLIENT_MS);
  }

  startBridge() {
    const child = this.spawnBridge(this.bridgePath);
    this.bridge = child;
    this.started = false;
    this.pending.clear();
    child.stderr?.on('data', chunk => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    readline.createInterface({ input: child.stdout }).on('line', line => this.fromBridge(child, line));
    child.on('exit', (code, signal) => {
      if (this.bridge !== child) return;
      this.log('bridgeExited', { code, signal });
      this.bridge = null;
      for (const [, reply] of this.replies) reply.reject(new Error('bridge exited'));
      this.replies.clear();
      try { writeFileSync(join(this.root, 'bridge.stderr'), this.stderrTail, { mode: 0o600 }); } catch {}
      // Core sees the end of its connection the way it sees a local bridge end.
      this.client?.end();
      this.shutdown('bridge exited');
    });
    this.log('bridgeStarted', { pid: child.pid });
  }

  fromBridge(child, line) {
    if (child !== this.bridge) return;
    let message = null;
    try { message = JSON.parse(line); } catch {}
    if (message?.type === 'response' && typeof message.id === 'string' && message.id.startsWith('host-')) {
      const reply = this.replies.get(message.id);
      if (reply) {
        this.replies.delete(message.id);
        if (message.error) reply.reject(new Error(String(message.error?.message ?? message.error)));
        else reply.resolve(message.result);
      }
      return;
    }
    if (message?.type === 'permission' && typeof message.requestId === 'string') {
      this.pending.add(message.requestId);
      // Asked while no one is attached (R1): denied at once, like those that
      // were waiting when the client left.
      if (!this.client && this.started) this.denyPending();
    }
    if (message?.type === 'permission_cancelled' && typeof message.requestId === 'string') this.pending.delete(message.requestId);
    if (message?.type === 'response' && this.client && this.awaitingStart === message.id && !message.error) this.started = true;
    // Detached: the frame is not kept. The saved session has what it says.
    this.client?.write(line + '\n');
  }

  request(command) {
    const child = this.bridge;
    if (!child) return Promise.reject(new Error('no bridge'));
    const id = `host-${++this.nextReply}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(id); reject(new Error('bridge did not answer')); }, HOST_REPLY_MS);
      this.replies.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }

  async status() {
    if (!this.bridge || !this.started) return null;
    return this.request({ op: 'status' }).catch(() => null);
  }

  /** A connection is a client once it sends its first line; one that sends
   * nothing (the helper checking the socket is alive) changes nothing. */
  connection(socket) {
    if (this.stopping) { socket.end(); return; }
    socket.on('error', () => {});
    const queued = [];
    let state = 'new';
    readline.createInterface({ input: socket }).on('line', line => {
      if (state === 'attached') return this.fromClient(socket, line);
      queued.push(line);
      if (state !== 'new') return;
      state = 'deciding';
      this.attach(socket).then(attached => {
        state = attached ? 'attached' : 'refused';
        if (attached) for (const pending of queued.splice(0)) this.fromClient(socket, pending);
      }, error => {
        state = 'refused';
        this.log('attachFailed', { error: String(error?.message || error).slice(0, 300) });
        socket.destroy();
      });
    });
  }

  async attach(socket) {
    if (this.stopping) { socket.end(); return false; }
    clearTimeout(this.firstClient);
    const status = await this.status();
    if (busy(status)) {
      // The earlier turn is still running here; it must end first.
      this.log('refused', { reason: 'busy', turnId: status.turnId ?? null });
      socket.end(JSON.stringify({ type: 'disconnected', error: 'The previous Claude turn is still running on this machine; reconnect once it has ended.', hostBusy: true }) + '\n');
      return false;
    }
    if (this.client) {
      this.log('replaced');
      const previous = this.client;
      this.client = null;
      previous.destroy();
    }
    if (this.bridge && this.started) {
      // Idle but already started: a fresh bridge, so this client's own start
      // (with the session it resumes) is the only query.
      await this.closeBridge();
    }
    if (!this.bridge) this.startBridge();
    this.client = socket;
    this.log('attached');
    this.state();
    socket.on('close', () => {
      if (this.client !== socket) return;
      this.client = null;
      this.log('detached', { started: this.started, pendingCount: this.pending.size });
      this.state();
      this.detachedWork = this.whileDetached();
    });
    if (socket.destroyed) socket.emit('close');
    return true;
  }

  fromClient(socket, line) {
    if (socket !== this.client) return;
    let command = null;
    try { command = JSON.parse(line); } catch {}
    if (command?.op === 'host_stop') return void this.stopFor(socket, command.id);
    // Once a stop is asked for, nothing more reaches the bridge.
    if (this.stopAsked || this.stopping) {
      if (command?.id != null) socket.write(JSON.stringify({ type: 'response', id: command.id, error: 'This Claude host is stopping.' }) + '\n');
      return;
    }
    if (!this.bridge) return;
    if (command?.op === 'start') this.awaitingStart = command.id;
    if (command?.op === 'respond' && typeof command.requestId === 'string') this.pending.delete(command.requestId);
    this.bridge.stdin.write(line + '\n');
  }

  /**
   * The user's Disconnect (T-184), asked by the attached client. It goes on
   * only if the bridge itself says it is idle, and that answer is about the
   * same client and bridge; commands this client sends meanwhile are refused.
   * Then the host takes no more clients, closes the bridge, and answers
   * `stopped: true` only if it exited by itself within BRIDGE_EXIT_MS with
   * code 0. `stopped: false` means only that the bridge said it has work: no
   * stop began, and this client and bridge are as they were. Anything else
   * is `stopped: null`, with why: not known to have stopped, nor not to have.
   * It exits once the client has closed (or a while after).
   */
  async stopFor(socket, id) {
    const answer = result => { if (!socket.destroyed) socket.write(JSON.stringify({ type: 'response', id, result }) + '\n'); };
    if (this.stopAsked || this.stopping) return answer({ stopped: null, reason: 'this Claude host is already stopping' });
    this.stopAsked = true;
    const bridge = this.bridge;
    const status = await this.status();
    const doubt = socket !== this.client ? 'another connection took this Claude host over'
      : this.stopping ? 'this Claude host is already stopping'
      : !bridge || this.bridge !== bridge ? 'the Claude bridge on this machine changed while it was asked'
      : !status ? "Claude on this machine didn't answer whether it is idle" : null;
    const busyNow = !doubt && (!idle(status) || this.pending.size > 0);
    if (doubt || busyNow) {
      this.stopAsked = false;
      const reason = doubt || 'Claude on this machine is not idle';
      this.log('stopRefused', { reason });
      return answer({ stopped: doubt ? null : false, reason });
    }
    this.stopping = true;
    clearTimeout(this.firstClient);
    this.log('stopping', { reason: 'disconnected by the user' });
    this.state();
    const exit = await this.closeBridge();
    const unconfirmed = !exit ? "the Claude bridge on this machine didn't exit, even after SIGTERM"
      : exit.forced ? 'the Claude bridge on this machine only ended after SIGTERM, so its Claude CLI may not have stopped'
      : exit.code !== 0 || exit.signal !== null ? `the Claude bridge on this machine exited with ${exit.signal ?? `code ${exit.code}`}` : null;
    answer(unconfirmed ? { stopped: null, reason: unconfirmed } : { stopped: true, exit: { code: exit.code, signal: exit.signal } });
    const finish = () => { clearTimeout(timer); this.finish('disconnected by the user'); };
    const timer = setTimeout(finish, CLIENT_CLOSE_MS);
    if (socket.destroyed) finish();
    else socket.once('close', finish);
  }

  /** No client: deny what waits for one, let the turn end, then stop. */
  /** Denies every approval this host knows is waiting, never allows one. */
  async denyPending() {
    for (const requestId of [...this.pending]) {
      if (this.client || this.denying?.has(requestId)) continue;
      (this.denying ??= new Set()).add(requestId);
      try {
        await this.request({ op: 'respond', requestId, decision: 'deny', message: DENY_MESSAGE });
        this.log('denied', { requestId });
      } catch (error) {
        this.log('denyFailed', { requestId, error: String(error?.message || error).slice(0, 200) });
      }
      this.pending.delete(requestId);
      this.denying.delete(requestId);
    }
  }

  /** No client: deny what waits for one (also what is asked later), let the
   * turn end, then stop. An approval the bridge counts but never announced
   * cannot be named to deny; the turn is then interrupted, once. */
  async whileDetached() {
    if (!this.started) return this.shutdown('client left before a session started');
    let unnamed = 0;
    let interrupted = false;
    while (!this.client && !this.stopping) {
      await this.denyPending();
      if (this.client) return;
      const status = await this.status();
      this.state({ busy: busy(status), turnId: status?.turnId ?? null });
      if (!busy(status)) return this.shutdown('idle without a client');
      unnamed = status?.pendingCount && !this.pending.size ? unnamed + 1 : 0;
      if (unnamed >= 2 && !interrupted) {
        interrupted = true;
        this.log('interrupting', { reason: 'an approval no one can answer', pendingCount: status.pendingCount });
        await this.request({ op: 'interrupt' }).catch(error => this.log('interruptFailed', { error: String(error?.message || error).slice(0, 200) }));
      }
      await new Promise(resolve => setTimeout(resolve, IDLE_POLL_MS));
    }
  }

  /** Ends the bridge: its stdin first, SIGTERM if it hasn't exited after
   * BRIDGE_EXIT_MS. Returns how it exited (`forced` once SIGTERM was sent),
   * or null if no exit was seen. */
  async closeBridge() {
    const child = this.bridge;
    if (!child) return null;
    this.bridge = null;
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const within = ms => Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
    child.stdin.end();
    let exit = await within(BRIDGE_EXIT_MS);
    if (!exit) {
      child.kill('SIGTERM');
      exit = await within(BRIDGE_KILL_MS);
      if (exit) exit = { ...exit, forced: true };
    }
    this.started = false;
    this.pending.clear();
    this.log('bridgeClosed', { exited: !!exit });
    return exit;
  }

  async shutdown(reason) {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.firstClient);
    this.log('stopping', { reason });
    await this.closeBridge();
    this.finish(reason);
  }

  finish(reason) {
    if (this.finished) return;
    this.finished = true;
    this.client?.destroy();
    this.client = null;
    this.server?.close();
    rmSync(this.socketPath, { force: true });
    this.state({ stopped: true, reason });
    this.exit(0);
  }
}

function defaultSpawn(bridge) {
  return spawn(process.execPath, [bridge], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, root] = process.argv.slice(2);
  if (mode !== 'serve' || !root) {
    console.error('Usage: node remote-host.mjs serve <private runtime dir>');
    process.exit(2);
  }
  const host = new RemoteHost({ root, bridge: join(dirname(fileURLToPath(import.meta.url)), 'bridge.mjs') });
  process.on('SIGTERM', () => host.shutdown('SIGTERM'));
  host.listen().catch(error => {
    host.log('listenFailed', { error: String(error?.message || error).slice(0, 300) });
    process.exit(1);
  });
}

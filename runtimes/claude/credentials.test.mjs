import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeBridge, PromptQueue } from './bridge.mjs';
import { CredentialMask } from './credentials.mjs';

const parent = resolve('../../target/claude-tests');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'credential-'));
after(() => rmSync(root, { recursive: true, force: true }));
const secret = randomBytes(32).toString('hex');
const collaboration = { url: 'http://127.0.0.1:4999/mcp/test', headers: { Authorization: `Bearer ${secret}` } };
const start = { id: 'start', op: 'start', cwd: root, collaborationMcp: collaboration };

function fixture({ initialize = async () => ({}), register, ...extra } = {}) {
  const events = []; const diagnostics = []; const calls = [];
  const output = new PromptQueue();
  output.initializationResult = initialize;
  output.setMcpServers = async servers => {
    calls.push(servers);
    return register ? register(servers) : { added: ['yuzuno'], removed: [], errors: {} };
  };
  output.close = () => PromptQueue.prototype.close.call(output);
  let options;
  const bridge = new ClaudeBridge({
    query: args => { options = args.options; return output; },
    emit: event => events.push(event), stderr: text => diagnostics.push(text),
    resolveCli: () => '/native/claude', version: async () => null, ...extra,
  });
  return { bridge, output, events, diagnostics, calls, options: () => options };
}

test('registration retains other SDK servers, user settings, allowed tools and hooks; secret is absent from launch options', async () => {
  const hook = { hooks: [() => ({})] };
  const other = { type: 'http', url: 'http://127.0.0.1:4000/other' };
  const f = fixture({ options: { mcpServers: { other }, allowedTools: ['Read'], hooks: { Stop: [hook] } } });
  await f.bridge.handle(start);
  assert.equal(f.events.some(e => e.result?.started), true);
  assert.equal(f.options().mcpServers.yuzuno, undefined);
  assert.equal(JSON.stringify(f.options()).includes(secret), false);
  assert.deepEqual(f.calls[0].other, other);
  assert.equal(f.calls[0].yuzuno.headers.Authorization === collaboration.headers.Authorization, true);
  assert.deepEqual(f.options().allowedTools, ['Read', 'mcp__yuzuno__*']);
  assert.deepEqual(f.options().settingSources, ['user', 'project', 'local']);
  assert.equal(f.options().hooks.Stop[0], hook);
  assert.equal(typeof f.options().hooks.PostToolUse.at(-1).hooks[0], 'function');
  f.bridge.emit({ type: 'event', event: { diagnostic: `native echo ${secret}` } });
  assert.equal(JSON.stringify(f.events).includes(secret), false);
  f.bridge.close(); await f.bridge.reader;
});

test('redaction covers every stderr split and redacts before diagnostic truncation', async () => {
  for (let split = 1; split < secret.length; split++) {
    const mask = new CredentialMask(); mask.set(collaboration.headers.Authorization);
    const text = mask.chunk(`before ${secret.slice(0, split)}`) + mask.chunk(`${secret.slice(split)} after`);
    assert.equal(text.includes(secret), false);
    assert.equal(text, 'before [REDACTED] after');
  }
  const f = fixture({ register: async () => { throw new Error('x'.repeat(3990) + secret); } });
  await f.bridge.handle(start); await f.bridge.reader;
  const error = f.events.find(e => e.type === 'response').error;
  assert.equal(error.includes(secret.slice(0, 10)), false);
  assert.equal(f.bridge.ready, false);
});

test('MCP registration is inside the ready timeout and never queues a model task', async () => {
  let complete;
  const f = fixture({ initializationTimeoutMs: 15, register: () => new Promise(resolve => { complete = resolve; }) });
  await f.bridge.handle(start);
  assert.equal(f.bridge.ready, false);
  assert.equal(f.bridge.closed, true);
  assert.match(f.events.find(e => e.id === 'start').error, /timed out/);
  await f.bridge.handle({ id: 'send', op: 'send', turnId: 't', text: 'must not start' });
  assert.equal(f.events.some(e => e.result?.queued), false);
  complete({ added: ['yuzuno'], removed: [], errors: {} });
  await f.bridge.reader;
  assert.equal(f.events.some(e => e.result?.started), false);
  assert.equal((await f.bridge.queue.next()).done, true);
});

test('close during native initialization prevents later MCP registration and ready', async () => {
  let complete;
  const f = fixture({ initialize: () => new Promise(resolve => { complete = resolve; }) });
  const pending = f.bridge.handle(start);
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  f.bridge.close(); complete({});
  await pending; await f.bridge.reader;
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.some(e => e.result?.started), false);
});

test('registration errors, unsupported APIs and close during registration fail without exposing credentials', async () => {
  for (const register of [
    async () => ({ added: [], removed: [], errors: { yuzuno: `failed ${secret}` } }),
    async () => { throw new Error(`unsupported ${secret}`); },
  ]) {
    const f = fixture({ register });
    await f.bridge.handle(start); await f.bridge.reader;
    assert.equal(f.bridge.ready, false);
    assert.equal(f.bridge.closed, true);
    assert.equal(JSON.stringify(f.events).includes(secret), false);
  }
  let complete;
  const f = fixture({ register: () => new Promise(resolve => { complete = resolve; }) });
  const pending = f.bridge.handle(start);
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  f.bridge.close(); complete({ added: ['yuzuno'], removed: [], errors: {} });
  await pending; await f.bridge.reader;
  assert.equal(f.events.some(e => e.result?.started), false);
});

test('real pinned SDK sends the token through stdin only, with no MCP credential file or argv value', async () => {
  const cli = join(root, 'fake-cli.mjs');
  writeFileSync(cli, `import {createInterface} from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const r=JSON.parse(line); if(r.type!=='control_request') continue;
      let response={};
      if(r.request.subtype==='mcp_set_servers') {
        const token=r.request.servers.yuzuno.headers.Authorization.slice(7);
        process.stderr.write('diagnostic '+token.slice(0,13));
        await new Promise(resolve=>setTimeout(resolve,5));
        process.stderr.write(token.slice(13)+' done\\n');
        response={added:Object.keys(r.request.servers),removed:[],errors:{}};
      }
      process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:r.request_id,response}})+'\\n');
    }
  `);
  const events = []; const diagnostics = []; let actualArgs;
  const bridge = new ClaudeBridge({
    query: args => {
      // Instrument only this test's subprocess. Production uses SDK defaults.
      args.options.spawnClaudeCodeProcess = options => {
        actualArgs = options.args;
        const child = spawn(options.command, options.args, {
          cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', args.options.stderr);
        return child;
      };
      return query(args);
    },
    emit: event => events.push(event), stderr: text => diagnostics.push(text),
    resolveCli: () => cli, version: async () => null,
  });
  try {
    await bridge.handle(start);
    assert.equal(events.some(e => e.result?.started), true);
    assert.equal(JSON.stringify(actualArgs).includes(secret), false);
    assert.equal(actualArgs.some(arg => arg.includes('mcp-config')), false);
    assert.equal((JSON.stringify(events) + diagnostics.join('')).includes(secret), false);
    assert.equal(diagnostics.join('').includes('[REDACTED]'), true);
  } finally { bridge.close(); await bridge.reader; }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { safeMcpServers, mcpStatusReader } from './mcp-status.mjs';
import { ClaudeBridge } from './bridge.mjs';

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const runtime = query => ({ ready: true, closed: false, sessionId: 'session-a', query });

test('closed schema preserves native states, categorizes failures and drops credentials/configuration', () => {
  const states = ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'new-native-state'];
  const output = safeMcpServers(states.map((status, index) => ({ name: `service-${index}`, status,
    error: '401 Authorization: Bearer native-secret', config: { url: 'https://user:password@example.test', env: { TOKEN: 'native-secret' } },
    tools: [{ name: 'secret-tool' }], scope: 'secret-scope' })));
  assert.deepEqual(output.servers.map(s => s.status), [...states.slice(0, 5), 'unknown']);
  assert.equal(output.servers[1].reason, 'authentication');
  assert.doesNotMatch(JSON.stringify(output), /native-secret|password|Authorization|config|secret-tool|secret-scope/);
  for (const [error, reason] of [['ETIMEDOUT secret', 'timeout'], ['spawn ENOENT secret', 'executable'], ['ECONNREFUSED secret', 'connection'],
    ['invalid configuration secret', 'configuration'], ['arbitrary raw secret', 'failed']]) {
    assert.equal(safeMcpServers([{ name: 'x', status: 'failed', error }]).servers[0].reason, reason);
  }
  assert.equal(safeMcpServers({ servers: [] }), null);
  assert.equal(safeMcpServers(Array.from({ length: 300 }, () => ({ name: 'ok', status: 'connected' }))).servers.length, 256);
  assert.equal(safeMcpServers(Array(300)).truncated, true);
  for (const name of ['https://user:secret@server', 'token=secret', 'Bearer secret', '\nsecret', 'x'.repeat(161)]) {
    assert.equal(safeMcpServers([{ name, status: 'connected' }]).servers[0].name, 'MCP service 1');
  }
});

test('only queries an existing ready runtime; missing and older capabilities are explicit', async () => {
  let calls = 0;
  const r = runtime({ mcpServerStatus() { calls++; return []; } });
  const read = mcpStatusReader(r);
  r.ready = false; assert.equal((await read()).state, 'unavailable');
  r.ready = true; r.closed = true; assert.equal((await read()).state, 'unavailable');
  r.closed = false; r.query = {}; assert.equal((await read()).state, 'unsupported');
  r.query = { mcpServerStatus() { throw new Error('unknown request mcp_status secret'); } };
  assert.deepEqual(await read(), { state: 'unsupported' });
  assert.equal(calls, 0);
});

test('coalesces concurrent reads and discards a late old-session result', async () => {
  let calls = 0;
  const held = defer();
  const r = runtime({ mcpServerStatus() { calls++; return held.promise; } });
  const read = mcpStatusReader(r);
  const a = read(), b = read();
  await Promise.resolve(); assert.equal(calls, 1);
  r.sessionId = 'session-b'; held.resolve([{ name: 'old', status: 'connected' }]);
  assert.deepEqual(await a, { state: 'changed' }); assert.deepEqual(await b, { state: 'changed' });
  r.query = { mcpServerStatus: async () => [{ name: 'new', status: 'connected' }] };
  assert.equal((await read()).servers[0].name, 'new');
});

test('bridge op contains synchronous/asynchronous exceptions, can retry, and never emits a raw error', async () => {
  const frames = [];
  const bridge = new ClaudeBridge({ query() { throw new Error('must not start a query'); }, emit: event => frames.push(event) });
  bridge.ready = true; bridge.sessionId = 's';
  bridge.query = { mcpServerStatus() { throw new Error('raw-secret config URL'); } };
  await bridge.handle({ id: 'sync', op: 'mcp_status' });
  bridge.query = { mcpServerStatus: async () => { throw new Error('raw-secret rejected'); } };
  await bridge.handle({ id: 'async', op: 'mcp_status' });
  bridge.query = { mcpServerStatus: async () => [] };
  await bridge.handle({ id: 'retry', op: 'mcp_status' });
  assert.deepEqual(frames.map(f => f.result.state), ['failed', 'failed', 'ready']);
  assert.doesNotMatch(JSON.stringify(frames), /raw-secret|config URL/);
  assert.equal(bridge.turnId, null); assert.equal(bridge.started, false);
});

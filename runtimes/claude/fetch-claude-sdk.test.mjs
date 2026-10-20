import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchSdk, proxied, supportsEnvProxy } from './fetch-claude-sdk.mjs';

const BODY = Buffer.from('fixture package bytes');
const INTEGRITY = `sha512-${createHash('sha512').update(BODY).digest('base64')}`;
const URL = 'https://registry.example/claude-agent-sdk-0.3.296.tgz';

const answering = (status = 200, body = BODY) => async () => new Response(body, { status });

test('the proxy boundary follows the Node versions whose fetch() honours it', () => {
  for (const version of ['22.21.0', '22.23.2', '24.0.0', '25.1.0']) assert.equal(supportsEnvProxy(version), true, version);
  for (const version of ['20.19.0', '22.20.9', '23.11.0']) assert.equal(supportsEnvProxy(version), false, version);
  assert.equal(proxied({}), false);
  assert.equal(proxied({ https_proxy: 'http://proxy.example:3128' }), true);
  assert.equal(proxied({ HTTP_PROXY: 'http://proxy.example:3128' }), true);
});

test('a package matching the locked integrity is written whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fetch-sdk-'));
  const out = join(dir, 'sdk.tgz');
  assert.equal(await fetchSdk(URL, INTEGRITY, out, { fetch: answering(), env: {} }), BODY.length);
  assert.deepEqual(await readFile(out), BODY);
  assert.deepEqual(await readdir(dir), ['sdk.tgz']);
});

test('other bytes, an HTTP error or no integrity leave nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fetch-sdk-'));
  const out = join(dir, 'sdk.tgz');
  await assert.rejects(fetchSdk(URL, INTEGRITY, out, { fetch: answering(200, Buffer.from('other')), env: {} }),
    error => error.exitCode === 4 && /locked integrity/.test(error.message));
  await assert.rejects(fetchSdk(URL, INTEGRITY, out, { fetch: answering(404), env: {} }), /HTTP 404/);
  await assert.rejects(fetchSdk(URL, 'sha1-x', out, { fetch: answering(), env: {} }), /no sha512 integrity/);
  await assert.rejects(fetchSdk('http://registry.example/x.tgz', INTEGRITY, out, { fetch: answering(), env: {} }), /no HTTPS/);
  assert.deepEqual(await readdir(dir), []);
});

test('with a proxy set, an older Node refuses rather than connecting around it', async () => {
  let called = false;
  const get = async () => { called = true; return new Response(BODY); };
  const env = { HTTPS_PROXY: 'http://user:secret@proxy.example:3128' };
  await assert.rejects(fetchSdk(URL, INTEGRITY, '/nonexistent/x', { fetch: get, env, version: '22.20.0' }),
    error => error.exitCode === 3 && /22\.21\.0/.test(error.message) && !error.message.includes('secret'));
  assert.equal(called, false);
});

test('a failed connection is described without the proxy URL', async () => {
  const get = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED http://user:secret@proxy.example:3128'), { code: 'ECONNREFUSED' }) }); };
  await assert.rejects(fetchSdk(URL, INTEGRITY, '/nonexistent/x', { fetch: get, env: {} }),
    error => /ECONNREFUSED/.test(error.message) && !error.message.includes('secret') && !error.message.includes('proxy.example'));
});

test('the command line exits non-zero with the reason and leaves nothing', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'fetch-sdk-'));
  const script = new globalThis.URL('./fetch-claude-sdk.mjs', import.meta.url).pathname;
  const refused = spawnSync(process.execPath, [script, 'http://registry.example/x.tgz', INTEGRITY, join(dir, 'a.tgz')],
    { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^Claude Agent SDK: claude-agent-sdk\.json names no HTTPS source/);
  assert.deepEqual(await readdir(dir), []);
});

// Downloads the Claude Agent SDK's package for Core (T-159), which prepares
// the Claude runtime on this machine: a public release leaves the SDK out.
// Core runs it as `node fetch-claude-sdk.mjs <url> <integrity> <out>` with the
// URL and sha512 integrity of claude-agent-sdk.json, checks the result again
// and unpacks it itself.
//
// Proxies: with HTTPS_PROXY or HTTP_PROXY set (any case), Core starts this with
// NODE_USE_ENV_PROXY=1, which Node's fetch() honours from 22.21.0 on the 22
// line and from 24.0.0. An older Node would ignore the proxy and connect
// directly, so it is refused instead. TLS certificates are checked as Node
// does (NODE_EXTRA_CA_CERTS, when set, is Node's own). Proxy URLs, which may
// carry credentials, are never printed.
import { createHash } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PROXY_NEEDS = 'Node 22.21.0 or later on the 22 line, or 24.0.0 or later';
const TIMEOUT_MS = 120_000;
const LIMIT = 64 * 1024 * 1024;

export function proxied(env = process.env) {
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(name => env[name]);
}

/** Whether this Node's fetch() can use the proxy in the environment. */
export function supportsEnvProxy(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

/** The base64 digest of a `sha512-<base64>` integrity, or null. */
export function sha512Of(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  return match ? match[1] : null;
}

/** A message without anything that could hold a proxy's credentials. */
function describe(error) {
  const code = error?.cause?.code ?? error?.code;
  const name = error?.name === 'TimeoutError' ? 'timed out' : (code ?? error?.name ?? 'failed');
  return `the download ${name === 'timed out' ? 'timed out' : `failed (${name})`}`;
}

export async function fetchSdk(url, integrity, out, { fetch: get = fetch, env = process.env, version = process.versions.node } = {}) {
  const expected = sha512Of(integrity);
  if (!expected) throw new Error('claude-agent-sdk.json names no sha512 integrity');
  if (!/^https:\/\//.test(url)) throw new Error('claude-agent-sdk.json names no HTTPS source');
  if (proxied(env) && !supportsEnvProxy(version)) {
    const error = new Error(`a proxy is set; downloading through it needs ${PROXY_NEEDS} (this is ${version}). Core does not connect around the proxy.`);
    error.exitCode = 3;
    throw error;
  }
  let response;
  try {
    response = await get(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (error) {
    throw new Error(describe(error));
  }
  if (!response.ok) throw new Error(`the registry answered HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > LIMIT) throw new Error('the package is larger than expected');
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (actual !== expected) {
    const error = new Error('the downloaded package does not match the locked integrity');
    error.exitCode = 4;
    throw error;
  }
  const part = `${out}.part`;
  await writeFile(part, bytes, { mode: 0o600 });
  await rename(part, out);
  return bytes.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, integrity, out] = process.argv.slice(2);
  try {
    await fetchSdk(url, integrity, out);
  } catch (error) {
    await rm(`${out}.part`, { force: true });
    process.stderr.write(`Claude Agent SDK: ${error.message}\n`);
    process.exit(error.exitCode ?? 2);
  }
}

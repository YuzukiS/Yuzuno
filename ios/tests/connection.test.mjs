import '../../web/tools/jsdom-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The iOS app's connection page, in JSDOM, as desktop/tests checks the
// desktop's: jsdom comes from web/node_modules.
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');
const html = await readFile(new URL('../connection/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../connection/connection.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function mount(invoke) {
  // JSDOM cannot navigate; opening the Workspace is checked by its message.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'tauri://localhost/index.html', runScripts: 'outside-only', virtualConsole });
  if (invoke) dom.window.__TAURI__ = { core: { invoke } };
  dom.window.eval(script);
  await settle();
  return dom;
}

const submit = (dom) =>
  dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

test('the last Workspace is filled in, not opened, until Connect', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_core') return 'https://core.example.ts.net/';
    if (command === 'connect_core') return args.url.trim();
  });
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector('#core-url').value, 'https://core.example.ts.net/');
    assert.match(document.querySelector('[role="status"]').textContent, /last workspace/);
    assert.deepEqual(calls.map((call) => call.command), ['saved_core'], 'nothing is connected by itself');
    submit(dom);
    await settle();
    // The arguments are made in JSDOM's own realm: compare their fields.
    assert.equal(calls.at(-1).command, 'connect_core');
    assert.equal(calls.at(-1).args.url, 'https://core.example.ts.net/');
    assert.match(document.querySelector('[role="status"]').textContent, /Opening your workspace/);
  } finally { dom.window.close(); }
});

test('a refused address keeps the field to correct, and the next try sends what was typed', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_core') return null;
    throw "Use your Workspace's HTTPS address. This app does not connect over plain HTTP.";
  });
  try {
    const document = dom.window.document;
    const field = document.querySelector('#core-url');
    assert.equal(field.value, '');
    assert.match(document.querySelector('[role="status"]').textContent, /Enter your workspace address/);
    field.value = 'http://core.example.ts.net';
    submit(dom);
    await settle();
    const status = document.querySelector('[role="status"]');
    assert.match(status.textContent, /HTTPS address/);
    assert.equal(status.dataset.error, 'true');
    assert.equal(field.disabled, false);
    assert.equal(document.querySelector('#connect-button').disabled, false);
    field.value = 'https://core.example.ts.net';
    submit(dom);
    await settle();
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 2);
    assert.equal(calls.at(-1).args.url, 'https://core.example.ts.net');
  } finally { dom.window.close(); }
});

test('a second Connect while one is checking sends nothing more', async () => {
  let finish;
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_core') return 'https://core.example.ts.net/';
    return new Promise((resolve) => { finish = resolve; });
  });
  try {
    submit(dom);
    submit(dom);
    await settle();
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1);
    assert.equal(dom.window.document.querySelector('#connect-button').disabled, true);
    finish('https://core.example.ts.net/');
    await settle();
  } finally { dom.window.close(); }
});

test('outside the app the page says so and offers nothing to submit', async () => {
  const dom = await mount(null);
  try {
    const document = dom.window.document;
    assert.match(document.querySelector('[role="status"]').textContent, /inside the Yuzuno app/);
    assert.equal(document.querySelector('#connect-button').disabled, true);
  } finally { dom.window.close(); }
});

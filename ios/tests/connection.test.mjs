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
    if (command === 'saved_core') return { state: 'saved', url: 'https://core.example.ts.net/' };
    if (command === 'connect_core') return { url: args.url.trim(), saved: true };
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
    if (command === 'saved_core') return { state: 'never' };
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
    if (command === 'saved_core') return { state: 'saved', url: 'https://core.example.ts.net/' };
    return new Promise((resolve) => { finish = resolve; });
  });
  try {
    submit(dom);
    submit(dom);
    await settle();
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1);
    assert.equal(dom.window.document.querySelector('#connect-button').disabled, true);
    finish({ url: 'https://core.example.ts.net/', saved: true });
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

test('a saved address that cannot be used is said so, not taken for a first launch', async () => {
  for (const answer of [
    async (command) => { if (command === 'saved_core') return { state: 'unreadable', reason: 'it is not a saved Workspace address' }; },
    async (command) => { if (command === 'saved_core') throw 'the app did not answer'; },
  ]) {
    const calls = [];
    const dom = await mount(async (command, args) => { calls.push({ command, args }); return answer(command); });
    try {
      const document = dom.window.document;
      const status = document.querySelector('[role="status"]');
      assert.equal(document.querySelector('#core-url').value, '', 'nothing is filled in');
      assert.match(status.textContent, /saved on this iPhone could not be used \((it is not a saved Workspace address|the app did not answer)\)/);
      assert.doesNotMatch(status.textContent, /to begin/);
      assert.equal(status.dataset.error, 'true');
      assert.deepEqual(calls.map((call) => call.command), ['saved_core'], 'nothing is connected by itself');
    } finally { dom.window.close(); }
  }
});

test('a Workspace that answered but could not be saved says so, keeps its address and opens only when asked', async () => {
  const calls = [];
  let save = false;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_core') return { state: 'never' };
    return save ? { url: args.url.trim(), saved: true }
      : { url: args.url.trim(), saved: false, saveError: 'No space left on device (os error 28)' };
  });
  try {
    const document = dom.window.document;
    const field = document.querySelector('#core-url');
    const status = document.querySelector('[role="status"]');
    const unsaved = document.querySelector('#open-unsaved');
    assert.equal(unsaved.hidden, true, 'nothing to open yet');
    field.value = 'https://core.example.ts.net/';
    submit(dom);
    await settle();
    assert.match(status.textContent, /answered, but this iPhone could not save its address \(No space left on device \(os error 28\)\)/);
    assert.doesNotMatch(status.textContent, /not reachable|Opening your workspace/, 'neither offline nor saved');
    assert.equal(status.dataset.error, 'true');
    assert.equal(field.value, 'https://core.example.ts.net/', 'the address stays');
    assert.equal(field.disabled, false);
    assert.equal(document.querySelector('#connect-button').disabled, false);
    assert.equal(unsaved.hidden, false);

    // Another address is not the Workspace that answered.
    field.value = 'https://other.example.ts.net/';
    field.dispatchEvent(new dom.window.Event('input'));
    assert.equal(unsaved.hidden, true);
    field.value = 'https://core.example.ts.net/';
    submit(dom);
    await settle();
    assert.equal(unsaved.hidden, false);

    // Open without saving opens what answered, and connects nothing more.
    const connects = calls.filter((call) => call.command === 'connect_core').length;
    unsaved.click();
    assert.match(status.textContent, /Opening your workspace without saving/);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, connects);

    // Connect tries again, and opens once it is saved.
    save = true;
    submit(dom);
    await settle();
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, connects + 1);
    assert.equal(calls.at(-1).args.url, 'https://core.example.ts.net/');
    assert.match(status.textContent, /Found it. Opening your workspace/);
    assert.equal(unsaved.hidden, true);
  } finally { dom.window.close(); }
});

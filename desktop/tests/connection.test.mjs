import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Reuse the frontend's existing DOM test dependency; the shipped shell has no
// Node or frontend build requirement.
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = await readFile(new URL('../connection/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../connection/connection.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function mount(invoke, nativeWindow) {
  const dom = new JSDOM(html, { url: 'http://tauri.localhost/index.html', runScripts: 'outside-only' });
  if (invoke) dom.window.__TAURI__ = { core: { invoke } };
  if (nativeWindow) dom.window.__TAURI__.window = { getCurrentWindow: () => nativeWindow };
  dom.window.eval(script);
  await settle();
  return dom;
}

test('an offline Core keeps a visible address and an actionable retry', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return { coreUrl: 'http://localhost:4321/', autoConnect: true };
    throw 'Core is not reachable yet.';
  });
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector('#core-url').value, 'http://localhost:4321/');
    assert.match(document.querySelector('[role="status"]').textContent, /not reachable/);
    assert.equal(document.querySelector('button').disabled, false);
    document.querySelector('#core-url').value = 'http://localhost:4322';
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(calls.at(-1).args.url, 'http://localhost:4322');
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 2);
    assert.equal(document.querySelector('#core-url').disabled, false);
  } finally { dom.window.close(); }
});

// T-171: the saved Core in WSL, as connection_info names it.
const saved = { coreUrl: 'http://127.0.0.1:4317/', autoConnect: true, startDistro: 'Ubuntu-24.04' };
const offline = 'Core is not reachable yet. Start it in WSL or on your chosen host, then try again.';

test('a saved Core in WSL is offered a start once connecting to it fails, and starts once', async () => {
  const calls = [];
  let finish;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return saved;
    if (command === 'start_core') return new Promise((resolve) => { finish = resolve; });
    if (command === 'connect_core') throw offline;
  });
  try {
    const document = dom.window.document;
    const startButton = document.querySelector('#start-button');
    assert.equal(document.querySelector('#start-row').hidden, false);
    assert.equal(startButton.textContent, 'Start Core in WSL (Ubuntu-24.04)');
    startButton.click();
    await settle();
    assert.match(document.querySelector('[role="status"]').textContent, /Starting Core in WSL \(Ubuntu-24\.04\)/);
    for (const control of ['#start-button', '#connect-button', '#core-url'])
      assert.equal(document.querySelector(control).disabled, true, control);
    // Clicking again, or connecting, while it starts asks for nothing more.
    startButton.click();
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await settle();
    assert.deepEqual(calls.filter((call) => call.command === 'start_core').map((call) => call.args.url),
      ['http://127.0.0.1:4317/']);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1);
    finish('http://127.0.0.1:4317/?shell=desktop');
    await settle();
    assert.match(document.querySelector('[role="status"]').textContent, /Core is running/);
  } finally { dom.window.close(); }
});

test('the start is offered only at the saved address, and a failed one keeps both choices', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return saved;
    if (command === 'start_core') throw 'Port 4317 is used by something other than Yuzuno Core. Nothing was started.';
    throw offline;
  });
  try {
    const document = dom.window.document;
    const row = document.querySelector('#start-row');
    const address = document.querySelector('#core-url');
    address.value = 'http://127.0.0.1:4321';
    address.dispatchEvent(new dom.window.Event('input'));
    assert.equal(row.hidden, true);
    address.value = 'http://127.0.0.1:4317';
    address.dispatchEvent(new dom.window.Event('input'));
    assert.equal(row.hidden, false);
    document.querySelector('#start-button').click();
    await settle();
    const status = document.querySelector('[role="status"]');
    assert.match(status.textContent, /used by something other than Yuzuno Core/);
    assert.equal(status.dataset.error, 'true');
    assert.equal(address.value, 'http://127.0.0.1:4317');
    assert.equal(row.hidden, false);
    for (const control of ['#start-button', '#connect-button', '#core-url'])
      assert.equal(document.querySelector(control).disabled, false, control);
  } finally { dom.window.close(); }
});

test('no start is offered without a saved Core in WSL, or while Core answers', async () => {
  for (const [info, connected] of [[{ ...saved, startDistro: undefined }, false], [saved, true]]) {
    const dom = await mount(async (command) => {
      if (command === 'connection_info') return info;
      if (command === 'connect_core' && connected) return 'http://127.0.0.1:4317/?shell=desktop';
      throw offline;
    });
    try {
      assert.equal(dom.window.document.querySelector('#start-row').hidden, true);
    } finally { dom.window.close(); }
  }
});

test('opening Connection from the native menu waits for a deliberate new selection', async () => {
  const calls = [];
  const dom = await mount(async (command) => {
    calls.push(command);
    return { coreUrl: 'http://127.0.0.1:4317/', autoConnect: false };
  });
  try {
    assert.deepEqual(calls, ['set_appearance', 'connection_info']);
    assert.match(dom.window.document.querySelector('[role="status"]').textContent, /Choose a workspace/);
  } finally { dom.window.close(); }
});

test('invalid launch configuration is shown without silently connecting to the default', async () => {
  const calls = [];
  const dom = await mount(async (command) => {
    calls.push(command);
    return { coreUrl: 'http://127.0.0.1:4317/', autoConnect: true, error: 'Core URLs cannot contain a username or password.' };
  });
  try {
    assert.deepEqual(calls, ['set_appearance', 'connection_info']);
    assert.match(dom.window.document.querySelector('[role="status"]').textContent, /username or password/);
  } finally { dom.window.close(); }
});

test('a plain browser preview never claims that a workspace is connected', async () => {
  const dom = await mount();
  try {
    assert.equal(dom.window.document.querySelector('button').disabled, true);
    assert.match(dom.window.document.querySelector('[role="status"]').textContent, /preview/);
  } finally { dom.window.close(); }
});

function fakeWindow(decorated) {
  const calls = [];
  const record = (name) => async () => { calls.push(name); };
  return {
    calls,
    isDecorated: async () => decorated,
    minimize: record('minimize'),
    toggleMaximize: record('toggleMaximize'),
    close: record('close'),
    startDragging: record('startDragging'),
  };
}
const idle = async () => ({ coreUrl: 'http://127.0.0.1:4317/', autoConnect: false });

test('a frameless window shows its own controls and moves from the top band only', async () => {
  const frame = fakeWindow(false);
  const dom = await mount(idle, frame);
  try {
    const document = dom.window.document;
    const controls = document.querySelector('.window-controls');
    assert.equal(controls.hidden, false);
    for (const action of ['minimize', 'maximize', 'close'])
      document.querySelector(`[data-window="${action}"]`).click();
    assert.deepEqual(frame.calls, ['minimize', 'toggleMaximize', 'close']);
    frame.calls.length = 0;
    const press = (target, clientY, detail = 1) => target.dispatchEvent(
      new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY, detail }));
    press(document.querySelector('.wordmark'), 40);
    press(document.querySelector('.wordmark'), 40, 2);
    press(document.querySelector('main'), 400);
    press(document.querySelector('#core-url'), 40);
    press(document.querySelector('[data-window="close"]'), 20);
    assert.deepEqual(frame.calls, ['startDragging', 'toggleMaximize']);
    // The Connect button is still the page's first button.
    assert.equal(document.querySelector('button').id, 'connect-button');
  } finally { dom.window.close(); }
});

test('a system frame or an older shell keeps the window controls hidden', async () => {
  for (const nativeWindow of [fakeWindow(true), undefined]) {
    const dom = await mount(idle, nativeWindow);
    try {
      assert.equal(dom.window.document.querySelector('.window-controls').hidden, true);
    } finally { dom.window.close(); }
  }
});

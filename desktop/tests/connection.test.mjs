import '../../web/tools/jsdom-guard.mjs';
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
const saved = { coreUrl: 'http://127.0.0.1:4317/', autoConnect: true, startDistro: 'Ubuntu-24.04', startConfirmed: true };
const unconfirmed = { ...saved, startConfirmed: false };
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
    assert.equal(startButton.textContent, "Start in this computer's WSL (Ubuntu-24.04)");
    assert.match(document.querySelector('#start-hint').textContent, /has started it here before/);
    startButton.click();
    await settle();
    assert.match(document.querySelector('[role="status"]').textContent, /Starting Core in this computer's WSL \(Ubuntu-24\.04\)/);
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

test('a start no one has confirmed here says so, and goes once this computer refuses it', async () => {
  const calls = [];
  // Native side: the profile is forgotten after this computer's WSL refused it.
  let offered = unconfirmed;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return offered;
    if (command === 'start_core') {
      offered = { ...unconfirmed, startDistro: undefined, startConfirmed: false };
      throw "Not started: this computer's WSL has no matching installation for this Workspace. If this address leads to another computer, such as an SSH tunnel, start Core there.";
    }
    throw offline;
  });
  try {
    const document = dom.window.document;
    const row = document.querySelector('#start-row');
    assert.equal(row.hidden, false);
    assert.equal(document.querySelector('#start-button').textContent, "Start in this computer's WSL");
    const hint = document.querySelector('#start-hint').textContent;
    assert.match(hint, /says its Core is in WSL \(Ubuntu-24\.04\)/);
    assert.match(hint, /only if it is installed in this computer's WSL/);
    // No identifiers or folders on the page.
    assert.doesNotMatch(document.body.textContent, /\/home\/|workspace-?id|[0-9a-f]{8}-[0-9a-f]{4}/i);
    document.querySelector('#start-button').click();
    await settle();
    assert.match(document.querySelector('[role="status"]').textContent, /no matching installation/);
    assert.equal(row.hidden, true, 'no longer offered');
    assert.equal(calls.filter((call) => call.command === 'start_core').length, 1, 'never retried by itself');
  } finally { dom.window.close(); }
});

test('a start that fails for another reason keeps what was offered, and is not retried', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return unconfirmed;
    if (command === 'start_core') throw "WSL could not run Yuzuno's start in Ubuntu-24.04: The operation timed out. Start Core in WSL yourself, or check that the distribution and installation still exist.";
    throw offline;
  });
  try {
    const document = dom.window.document;
    document.querySelector('#start-button').click();
    await settle();
    await settle();
    assert.match(document.querySelector('[role="status"]').textContent, /operation timed out/);
    assert.equal(document.querySelector('#start-row').hidden, false);
    assert.equal(document.querySelector('#start-button').textContent, "Start in this computer's WSL");
    assert.equal(document.querySelector('#start-button').disabled, false);
    assert.equal(calls.filter((call) => call.command === 'start_core').length, 1);
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

// T-195: the named Workspaces this computer keeps. One entry may start a
// Core; the rest are addresses. Saved is not reachable, and a list that
// could not be read is not an empty list.
const twoSaved = {
  coreUrl: 'http://127.0.0.1:4317/',
  autoConnect: false,
  selected: 'core-1',
  saved: [
    { id: 'core-1', name: 'Home', url: 'http://127.0.0.1:4317/', workspaceId: 'w-one', startable: true },
    { id: 'core-2', name: 'Home', url: 'http://127.0.0.1:4318/', workspaceId: 'w-two', startable: false },
  ],
};

test('saved workspaces are listed apart by workspace, with only one able to start a Core', async () => {
  const dom = await mount(async (command) => {
    if (command === 'connection_info') return twoSaved;
  });
  try {
    const document = dom.window.document;
    const items = [...document.querySelectorAll('#saved-list li')];
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.querySelector('.saved-name').textContent), ['Home', 'Home']);
    assert.deepEqual(items.map((item) => item.querySelector('.saved-url').textContent), [
      'http://127.0.0.1:4317/',
      'http://127.0.0.1:4318/',
    ]);
    assert.deepEqual(items.map((item) => item.querySelector('.saved-workspace').textContent), [
      'workspace w-one',
      'workspace w-two',
    ]);
    // Only one may start, and it is the one the record said.
    assert.deepEqual(items.map((item) => Boolean(item.querySelector('.saved-start'))), [true, false]);
    // Saved is not reachable.
    assert.doesNotMatch(document.querySelector('#saved-cores').textContent, /reachable|online|connected/i);
  } finally { dom.window.close(); }
});

test('a workspace that answers as another one is refused, and nothing is opened', async () => {
  const calls = [];
  const refusal =
    '“Home” answered as a different workspace than the one saved under that name, so it was not opened. ' +
    "Its conversations, drafts and reading places are that other workspace's. " +
    'Give this workspace an address of its own: two workspaces at one address share what this app has stored ' +
    'for that address. Removing the saved workspace does not clear what is stored for that address, and this ' +
    'computer goes on remembering which workspace was there -- so removing it is not a way to open another one here.';
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return twoSaved;
    if (command === 'connect_core') throw refusal;
  });
  try {
    const document = dom.window.document;
    document.querySelector('#saved-list li .saved-open').click();
    await settle();
    const status = document.querySelector('[role="status"]');
    assert.match(status.textContent, /answered as a different workspace/);
    assert.equal(status.dataset.error, 'true');
    assert.doesNotMatch(status.textContent, /Opening|Connected/i);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1, 'asked once, not retried');
    // The list is still there to choose another; refusing is not forgetting.
    assert.equal(document.querySelectorAll('#saved-list li').length, 2);
    // It must not offer removal as a way to separate two workspaces' data:
    // removing forgets the entry and its start profile, and clears nothing
    // this app has stored for that address.
    assert.doesNotMatch(status.textContent, /forgets its drafts|clear.*drafts|removing .* drafts/i);
    assert.match(status.textContent, /does not clear what is stored for that address/);
    // Removing is no longer offered as a way round this, because it is
    // not one: the address stays remembered.
    assert.match(status.textContent, /not a way to open another one here/);
  } finally { dom.window.close(); }
});

test('an unreadable list is not an empty list: nothing is listed, nothing is written over it', async () => {
  const calls = [];
  const dom = await mount(async (command) => {
    calls.push(command);
    if (command === 'connection_info')
      return { coreUrl: 'http://127.0.0.1:4317/', autoConnect: false, saved: [], savedError: 'one of its Workspaces is not one this app opens' };
  });
  try {
    const document = dom.window.document;
    const status = document.querySelector('[role="status"]');
    assert.equal(document.querySelector('#saved-cores').hidden, true, 'nothing is listed');
    assert.match(status.textContent, /could not be used \(one of its Workspaces is not one this app opens\)/);
    assert.match(status.textContent, /has not been changed/);
    assert.match(status.textContent, /will not open a workspace/);
    // Never "enter it again and it will be saved": connecting is refused.
    assert.doesNotMatch(status.textContent, /saves it anew|saved anew/);
    // Nothing offers to discard the record: losing what is saved is not
    // this page's to offer.
    assert.equal(
      [...document.querySelectorAll('button')].some((button) => /reset|discard|forget all|clear/i.test(button.textContent)),
      false,
    );
    // It did not connect by itself.
    assert.equal(calls.filter((command) => command === 'connect_core').length, 0);
  } finally { dom.window.close(); }
});

test('renaming and removing change this computer only, and removing asks first', async () => {
  const calls = [];
  let record = twoSaved;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return record;
    if (command === 'rename_core') {
      record = { ...twoSaved, saved: [{ ...twoSaved.saved[0], name: args.name.trim() }, twoSaved.saved[1]] };
      return record;
    }
    if (command === 'remove_core') {
      record = { ...twoSaved, selected: null, saved: twoSaved.saved.filter((entry) => entry.id !== args.entry) };
      return record;
    }
  });
  try {
    const document = dom.window.document;
    // JSDOM implements neither, and the page asks at click time.
    dom.window.prompt = () => ' Studio ';
    dom.window.confirm = () => true;
    document.querySelector('#saved-list li .saved-rename').click();
    await settle();
    assert.equal(calls.at(-1).command, 'rename_core');
    assert.equal(calls.at(-1).args.name, ' Studio ', 'what was typed is sent; the app trims and bounds it');
    assert.equal(document.querySelector('#saved-list li .saved-name').textContent, 'Studio');
    assert.match(document.querySelector('[role="status"]').textContent, /the workspace itself is unchanged/);

    document.querySelector('#saved-list li .saved-remove').click();
    await settle();
    assert.equal(calls.at(-1).command, 'remove_core');
    assert.equal(document.querySelectorAll('#saved-list li').length, 1, 'the other one stays');
    assert.match(document.querySelector('[role="status"]').textContent, /no longer saved on this computer/);
  } finally { dom.window.close(); }
});

const withRemembered = {
  ...twoSaved,
  remembered: [{ url: 'http://127.0.0.1:4319/', workspaceId: 'w-three' }],
};

test('an address with no workspace saved is shown as remembered, and forgetting it says what stays', async () => {
  const calls = [];
  let asked = '';
  let record = withRemembered;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return record;
    if (command === 'forget_address') {
      record = { ...withRemembered, remembered: [] };
      return record;
    }
  });
  try {
    const document = dom.window.document;
    const section = document.querySelector('#remembered');
    assert.equal(section.hidden, false, 'the reason a connection there is refused is visible');
    const item = document.querySelector('#remembered-list li');
    assert.match(item.textContent, /127\.0\.0\.1:4319/);
    assert.match(item.textContent, /w-three was here/);
    // It is not one of the saved Workspaces: nothing offers to open it.
    assert.equal(document.querySelectorAll('#saved-list li').length, 2);
    assert.equal(item.querySelector('.saved-open'), null, 'no way to open an address nothing is saved at');

    dom.window.confirm = (text) => {
      asked = text;
      return true;
    };
    item.querySelector('.saved-forget').click();
    await settle();

    // What it asks has to be what it does: the stored data stays, another
    // workspace here may read it, and a separate address is the real remedy.
    assert.match(asked, /stored for this address stays/i);
    assert.match(asked, /drafts, reading places and signed-in state are still there/i);
    assert.match(asked, /may read them/i);
    assert.match(asked, /does not delete them/i);
    assert.match(asked, /does not connect to anything/i);
    assert.match(asked, /address of its own/i);
    // It must never be dressed up as clearing or resetting the data.
    assert.doesNotMatch(asked, /clears? (your|the) data|delete the drafts|reset|wipe/i);

    assert.equal(calls.at(-1).command, 'forget_address');
    assert.equal(calls.at(-1).args.url, 'http://127.0.0.1:4319/');
    assert.equal(document.querySelector('#remembered').hidden, true, 'it is no longer remembered');
    assert.match(
      document.querySelector('[role="status"]').textContent,
      /no longer remembers which workspace was at .*4319.*still there/,
    );
  } finally { dom.window.close(); }
});

test('forgetting an address is not done when it is not confirmed, and never follows a removal', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push(command);
    if (command === 'connection_info') return withRemembered;
    // Answered properly, so a removal that succeeds is what is observed --
    // not an error path that happens to call nothing further.
    if (command === 'remove_core') {
      return { ...withRemembered, selected: null, saved: withRemembered.saved.filter((e) => e.id !== args.entry) };
    }
  });
  try {
    const document = dom.window.document;
    dom.window.confirm = () => false;
    document.querySelector('#remembered-list li .saved-forget').click();
    await settle();
    assert.equal(calls.filter((command) => command === 'forget_address').length, 0);
    assert.equal(document.querySelectorAll('#remembered-list li').length, 1);

    // Removing a saved Workspace must not forget an address as well: it is a
    // deliberate second step, never chained onto the first.
    dom.window.confirm = () => true;
    document.querySelector('#saved-list li .saved-remove').click();
    await settle();
    assert.equal(calls.at(-1), 'remove_core', 'the removal itself went through');
    assert.equal(calls.filter((command) => command === 'forget_address').length, 0, 'removal forgets no address');
    assert.equal(document.querySelectorAll('#remembered-list li').length, 1, 'and the address is still remembered');
  } finally { dom.window.close(); }
});

test('removing is not done when it is not confirmed', async () => {
  const calls = [];
  const dom = await mount(async (command) => {
    calls.push(command);
    if (command === 'connection_info') return twoSaved;
  });
  try {
    dom.window.confirm = () => false;
    dom.window.document.querySelector('#saved-list li .saved-remove').click();
    await settle();
    assert.equal(calls.filter((command) => command === 'remove_core').length, 0);
    assert.equal(dom.window.document.querySelectorAll('#saved-list li').length, 2);
  } finally { dom.window.close(); }
});

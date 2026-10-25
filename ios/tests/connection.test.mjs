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

async function mount(invoke, prepare) {
  // JSDOM cannot navigate; opening the Workspace is checked by its message.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'tauri://localhost/index.html', runScripts: 'outside-only', virtualConsole });
  if (invoke) dom.window.__TAURI__ = { core: { invoke } };
  prepare?.(dom.window);
  dom.window.eval(script);
  await settle();
  return dom;
}

// One saved Workspace, as `saved_cores` answers it.
const one = (url, workspaceId) => ({
  state: 'saved',
  selected: 'core-1',
  profiles: [{ id: 'core-1', name: 'Home', url, ...(workspaceId ? { workspaceId } : {}) }],
});

const submit = (dom) =>
  dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

test('the last Workspace is filled in, not opened, until Connect', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return one('https://core.example.ts.net/');
    if (command === 'connect_core') return { url: args.url.trim(), saved: true };
  });
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector('#core-url').value, 'https://core.example.ts.net/');
    assert.match(document.querySelector('[role="status"]').textContent, /last workspace/);
    assert.deepEqual(calls.map((call) => call.command), ['saved_cores'], 'nothing is connected by itself');
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
    if (command === 'saved_cores') return { state: 'never', profiles: [] };
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
    if (command === 'saved_cores') return one('https://core.example.ts.net/');
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

test('the status bar backdrop follows the visual viewport the keyboard scrolls', async () => {
  // JSDOM has no visual viewport: this one moves as iOS's did with the
  // keyboard open, where the page went up 223 pt (runs 40061280002 and
  // 40064169256) while fixed elements stayed at the top.
  let visual;
  const dom = await mount(async () => null, (window) => {
    visual = new window.EventTarget();
    visual.offsetTop = 0;
    window.visualViewport = visual;
  });
  try {
    const root = dom.window.document.documentElement;
    assert.equal(root.style.getPropertyValue('--visual-top'), '0px');
    visual.offsetTop = 223;
    visual.dispatchEvent(new dom.window.Event('scroll'));
    assert.equal(root.style.getPropertyValue('--visual-top'), '223px');
    visual.offsetTop = 0;
    visual.dispatchEvent(new dom.window.Event('resize'));
    assert.equal(root.style.getPropertyValue('--visual-top'), '0px');
  } finally { dom.window.close(); }
});

test('a saved address that cannot be used is said so, not taken for a first launch', async () => {
  for (const answer of [
    async (command) => { if (command === 'saved_cores') return { state: 'unreadable', reason: 'it is not a saved Workspace record', profiles: [] }; },
    async (command) => { if (command === 'saved_cores') throw 'the app did not answer'; },
  ]) {
    const calls = [];
    const dom = await mount(async (command, args) => { calls.push({ command, args }); return answer(command); });
    try {
      const document = dom.window.document;
      const status = document.querySelector('[role="status"]');
      assert.equal(document.querySelector('#core-url').value, '', 'nothing is filled in');
      assert.match(status.textContent, /saved on this iPhone could not be used \((it is not a saved Workspace record|the app did not answer)\)/);
      assert.doesNotMatch(status.textContent, /to begin/);
      assert.equal(status.dataset.error, 'true');
      assert.deepEqual(calls.map((call) => call.command), ['saved_cores'], 'nothing is connected by itself');
    } finally { dom.window.close(); }
  }
});

test('a Workspace that answered but could not be saved says so, keeps its address and opens only when asked', async () => {
  const calls = [];
  let save = false;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return { state: 'never', profiles: [] };
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

// T-195: the named Workspaces this iPhone keeps. Two of them are two, even
// when they share a name or an address; what tells them apart is the
// workspaceId their Core answers with.
const two = {
  state: 'saved',
  selected: 'core-1',
  profiles: [
    { id: 'core-1', name: 'Home', url: 'https://one.example.ts.net/', workspaceId: 'w-one' },
    { id: 'core-2', name: 'Home', url: 'https://two.example.ts.net/', workspaceId: 'w-two' },
  ],
};

test('two saved Workspaces are listed apart, by workspace, though they share a name', async () => {
  const dom = await mount(async (command) => {
    if (command === 'saved_cores') return two;
  });
  try {
    const document = dom.window.document;
    const items = [...document.querySelectorAll('#saved-list li')];
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => item.querySelector('.saved-name').textContent),
      ['Home', 'Home'],
      'the same name on both: a name is a label, not an identity',
    );
    assert.deepEqual(items.map((item) => item.querySelector('.saved-url').textContent), [
      'https://one.example.ts.net/',
      'https://two.example.ts.net/',
    ]);
    assert.deepEqual(items.map((item) => item.querySelector('.saved-workspace').textContent), [
      'workspace w-one',
      'workspace w-two',
    ]);
    // Saved is not reachable: the list says nothing about either answering.
    assert.doesNotMatch(document.querySelector('#saved-cores').textContent, /reachable|online|connected/i);
    assert.match(document.querySelector('#saved-cores .hint').textContent, /known only when you open it/);
  } finally { dom.window.close(); }
});

test('a saved Workspace that answers as another one is refused, not offered', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return two;
    if (command === 'connect_core')
      // The address still answers, as a different Workspace than the one
      // saved under this name.
      return {
        url: args.url,
        opened: false,
        identity: 'changed',
        profileName: 'Home',
        savedWorkspaceId: 'w-one',
        workspaceId: 'w-other',
      };
  });
  try {
    const document = dom.window.document;
    const status = document.querySelector('[role="status"]');
    const identity = document.querySelector('#identity-check');
    assert.equal(identity.hidden, true);
    document.querySelector('#saved-list li .saved-open').click();
    await settle();

    assert.equal(identity.hidden, false);
    assert.match(status.textContent, /not the workspace saved under that name/);
    assert.equal(status.dataset.error, 'true');
    assert.doesNotMatch(status.textContent, /Opening your workspace|Found it/);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1, 'asked once, not retried');
    assert.equal(calls.at(-1).args.profile, 'core-1', 'asked as the saved Workspace it was meant to be');

    // Nothing offers to open it: this app cannot keep two Workspaces at one
    // address apart, and says why rather than handing over a switch that
    // would mix their unsent drafts.
    assert.equal(document.querySelector('#identity-open'), null, 'no way to open it anyway');
    assert.match(document.querySelector('#identity-text').textContent, /kept per agent, not per workspace/);
    assert.equal(
      [...document.querySelectorAll('#identity-check button')].length,
      1,
      'only leaving it closed',
    );

    document.querySelector('#identity-cancel').click();
    assert.equal(identity.hidden, true);
    assert.match(status.textContent, /Left closed/);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1);
  } finally { dom.window.close(); }
});

test('renaming and removing change this iPhone only, and removing asks first', async () => {
  const calls = [];
  let record = two;
  const dom = await mount(
    async (command, args) => {
      calls.push({ command, args });
      if (command === 'saved_cores') return record;
      if (command === 'rename_core') {
        record = { ...two, profiles: [{ ...two.profiles[0], name: args.name.trim() }, two.profiles[1]] };
        return record;
      }
      if (command === 'remove_core') {
        record = { ...two, selected: null, profiles: two.profiles.filter((p) => p.id !== args.profile) };
        return record;
      }
    },
    (window) => {
      window.prompt = () => ' Studio ';
      window.confirm = () => true;
    },
  );
  try {
    const document = dom.window.document;
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
    assert.match(document.querySelector('[role="status"]').textContent, /no longer saved on this iPhone/);
  } finally { dom.window.close(); }
});

test('removing is not done when it is not confirmed', async () => {
  const calls = [];
  const dom = await mount(
    async (command) => {
      calls.push(command);
      if (command === 'saved_cores') return two;
    },
    (window) => { window.confirm = () => false; },
  );
  try {
    dom.window.document.querySelector('#saved-list li .saved-remove').click();
    await settle();
    assert.equal(calls.filter((command) => command === 'remove_core').length, 0);
    assert.equal(dom.window.document.querySelectorAll('#saved-list li').length, 2);
  } finally { dom.window.close(); }
});

test('a Workspace that cannot be reached is said so, and the list is still there to try another', async () => {
  const dom = await mount(async (command) => {
    if (command === 'saved_cores') return two;
    if (command === 'connect_core') throw 'Your workspace is not reachable. Check its address, and that this iPhone is connected to your private network.';
  });
  try {
    const document = dom.window.document;
    document.querySelector('#saved-list li .saved-open').click();
    await settle();
    const status = document.querySelector('[role="status"]');
    assert.match(status.textContent, /not reachable/);
    assert.equal(status.dataset.error, 'true');
    // Recoverable: the saved Workspaces are still listed and still openable.
    assert.equal(document.querySelectorAll('#saved-list li').length, 2);
    assert.equal(document.querySelector('#saved-list li .saved-open').disabled, false);
    assert.equal(document.querySelector('#connect-button').disabled, false);
  } finally { dom.window.close(); }
});

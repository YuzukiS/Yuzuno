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
      // What is saved is untouched, and nothing is opened until it reads:
      // never "enter it again and it will be saved", which is what this said
      // before connecting was refused.
      assert.match(status.textContent, /has not been changed/);
      assert.match(status.textContent, /will not open a workspace/);
      assert.doesNotMatch(status.textContent, /saves it anew|saved anew/);
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

// These two are at addresses of their own. That they are listed apart says
// nothing about two Workspaces at ONE address, which is the case the app has
// to refuse: JSDOM does not navigate, so no test here opens either origin.
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

test('an answer that cannot confirm the saved Workspace opens nothing', async () => {
  // The regression: a Core at an address already bound to a Workspace that
  // names none -- or names one too long to keep -- used to be let through,
  // and the page navigated to the Core's own origin, which is the storage
  // the refusal exists to keep apart.
  for (const [identity, expected] of [
    ['unverified', /did not say which workspace it is/],
    ['unkeepable', /longer than this iPhone keeps/],
    // A reason this build of the page does not know must still not open.
    ['something-new', /did not open that workspace/],
  ]) {
    const calls = [];
    const dom = await mount(async (command, args) => {
      calls.push({ command, args });
      if (command === 'saved_cores') return two;
      if (command === 'connect_core')
        return {
          url: args.url,
          opened: false,
          identity,
          profileName: 'Home',
          savedWorkspaceId: 'w-one',
          workspaceId: identity === 'unverified' ? null : 'w-' + 'x'.repeat(300),
        };
    });
    try {
      const document = dom.window.document;
      document.querySelector('#saved-list li .saved-open').click();
      await settle();
      const status = document.querySelector('[role="status"]');
      assert.match(status.textContent, expected, identity);
      assert.equal(status.dataset.error, 'true', identity);
      // Nothing claimed it opened. (The page navigates right after saying
      // so, and JSDOM has no navigation to count, so what it said is the
      // honest observable here.)
      assert.doesNotMatch(status.textContent, /Opening your workspace|Found it/, identity);
      // Nor did it fall through to the could-not-save path, which is where
      // an unrecognised refusal used to land.
      assert.doesNotMatch(status.textContent, /could not save its address/, identity);
      // Only the one ask: a refusal is not retried.
      assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1, identity);
    } finally { dom.window.close(); }
  }
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
    // Removing a saved Workspace takes it off this iPhone's list; it never
    // reaches what the web view stored for that address, which is where the
    // drafts are. So removal is not offered as a way to keep two Workspaces
    // apart, and is not said to forget their drafts.
    assert.doesNotMatch(
      document.querySelector('#identity-text').textContent,
      /forgets its drafts|clear.*drafts|removing .* drafts/i,
    );
    assert.match(
      document.querySelector('#identity-text').textContent,
      /only forgets what this iPhone saved about it/,
    );
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

// The case the refusal exists for: one saved address, a different Workspace
// answering there now. The app opens the Core's own origin in its one
// WebView, so this is the same storage as the saved Workspace's.
const sameAddress = {
  state: 'saved',
  selected: 'core-1',
  profiles: [{ id: 'core-1', name: 'Home', url: 'https://one.example.ts.net/', workspaceId: 'w-one' }],
};

test('a different Workspace at a saved address is refused, and nothing is opened there', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return sameAddress;
    if (command === 'connect_core')
      return {
        url: 'https://one.example.ts.net/',
        opened: false,
        identity: 'changed',
        profileName: 'Home',
        savedWorkspaceId: 'w-one',
        workspaceId: 'w-two',
      };
  });
  try {
    const document = dom.window.document;
    document.querySelector('#saved-list li .saved-open').click();
    await settle();
    // Asked at that one address, as that one profile.
    assert.equal(calls.at(-1).args.url, 'https://one.example.ts.net/');
    assert.equal(calls.at(-1).args.profile, 'core-1');
    // Refused, with no second call and no way to proceed.
    assert.equal(document.querySelector('#identity-check').hidden, false);
    assert.equal(document.querySelector('#identity-open'), null);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1);
    assert.doesNotMatch(document.querySelector('[role="status"]').textContent, /Opening|Found it/);
    // The profile is still saved: refusing is not forgetting.
    assert.equal(document.querySelectorAll('#saved-list li').length, 1);
    assert.equal(document.querySelector('.saved-url').textContent, 'https://one.example.ts.net/');
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

const withRemembered = {
  ...two,
  remembered: [{ url: 'https://gone.example.ts.net/', workspaceId: 'w-three' }],
};

test('an address with no workspace saved is shown as remembered, and forgetting it says what stays', async () => {
  const calls = [];
  let asked = '';
  let record = withRemembered;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return record;
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
    assert.match(item.textContent, /gone\.example\.ts\.net/);
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
    assert.equal(calls.at(-1).args.url, 'https://gone.example.ts.net/');
    assert.equal(document.querySelector('#remembered').hidden, true, 'it is no longer remembered');
    assert.match(
      document.querySelector('[role="status"]').textContent,
      /no longer remembers which workspace was at .*gone.*still there/,
    );
  } finally { dom.window.close(); }
});

test('with nothing saved but an address remembered, the page asks for an address', async () => {
  // The record holds something, so this is not a first launch -- but there
  // is nothing to open either. It must not say "Your last workspace. Open
  // it", which is what every state 'saved' used to say.
  const dom = await mount(async (command) => {
    if (command === 'saved_cores')
      return { state: 'saved', selected: null, profiles: [], remembered: [{ url: 'https://gone.example.ts.net/', workspaceId: 'w-three' }] };
  });
  try {
    const document = dom.window.document;
    const status = document.querySelector('[role="status"]');
    assert.match(status.textContent, /Enter your workspace address/);
    assert.doesNotMatch(status.textContent, /Your last workspace|Choose a workspace to open/);
    // Nothing is listed to open, and the remembered address is shown, so a
    // refusal there has a visible cause.
    assert.equal(document.querySelectorAll('#saved-list li').length, 0);
    assert.equal(document.querySelector('#remembered').hidden, false);
    assert.match(document.querySelector('#remembered-list li').textContent, /w-three was here/);
  } finally { dom.window.close(); }
});

// Two labels at one address recording different workspaces, plus an
// independent one. This is a record the build before the fix could write.
const disputedSaved = {
  state: 'saved',
  selected: 'core-1',
  profiles: [
    { id: 'core-1', name: 'Home', url: 'https://one.example.ts.net/', workspaceId: 'w-a' },
    { id: 'core-2', name: 'Home again', url: 'https://one.example.ts.net/', workspaceId: 'w-b' },
    { id: 'core-3', name: 'Studio', url: 'https://two.example.ts.net/', workspaceId: 'w-c' },
  ],
  remembered: [],
};

test('a disputed address offers Forget, and forgetting it keeps both workspaces', async () => {
  const calls = [];
  let asked = '';
  let record = disputedSaved;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return record;
    if (command === 'forget_address') {
      // What the app does: the labels stay, their identities go.
      record = {
        ...disputedSaved,
        profiles: disputedSaved.profiles.map((p) =>
          p.url === args.url ? { id: p.id, name: p.name, url: p.url } : p,
        ),
      };
      return record;
    }
  });
  try {
    const document = dom.window.document;
    // The whole list is there: nothing of theirs was lost to the dispute.
    assert.equal(document.querySelectorAll('#saved-list li').length, 3);

    // The button the refusal tells them to press has to exist. It is derived
    // from the list, since a disputed address is never in `remembered`.
    const item = document.querySelector('#remembered-list li[data-disputed]');
    assert.ok(item, 'a disputed address is offered a Forget');
    assert.match(item.textContent, /one\.example\.ts\.net/);
    assert.match(item.textContent, /record different workspaces/);
    // The independent address is not listed as disputed.
    assert.doesNotMatch(document.querySelector('#remembered').textContent, /two\.example\.ts\.net/);

    dom.window.confirm = (text) => {
      asked = text;
      return true;
    };
    item.querySelector('.saved-forget').click();
    await settle();

    // Same promise as any forget: the data stays and nothing is cleared.
    assert.match(asked, /stored for this address stays/i);
    assert.match(asked, /does not delete them/i);
    assert.match(asked, /does not connect to anything/i);
    assert.doesNotMatch(asked, /clears? (your|the) data|reset|wipe/i);

    assert.equal(calls.at(-1).command, 'forget_address');
    assert.equal(calls.at(-1).args.url, 'https://one.example.ts.net/');
    // Nothing was opened by forgetting.
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 0);

    // After it: both labels still saved, their identity gone, C untouched.
    assert.equal(document.querySelectorAll('#saved-list li').length, 3, 'no workspace was removed');
    assert.equal(document.querySelector('#remembered-list li[data-disputed]'), null, 'no longer disputed');
    const names = [...document.querySelectorAll('#saved-list .saved-name')].map((span) => span.textContent);
    assert.deepEqual(names, ['Home', 'Home again', 'Studio'], 'every label kept its name');
    assert.match(
      document.querySelector('[role="status"]').textContent,
      /no longer remembers which workspace was at .*one\.example/,
    );
  } finally { dom.window.close(); }
});

test('a disputed address is not forgotten unless it is confirmed', async () => {
  const calls = [];
  const dom = await mount(async (command) => {
    calls.push(command);
    if (command === 'saved_cores') return disputedSaved;
  });
  try {
    const document = dom.window.document;
    dom.window.confirm = () => false;
    document.querySelector('#remembered-list li[data-disputed] .saved-forget').click();
    await settle();
    assert.equal(calls.filter((command) => command === 'forget_address').length, 0);
    assert.equal(calls.filter((command) => command === 'connect_core').length, 0);
    assert.ok(document.querySelector('#remembered-list li[data-disputed]'), 'it is still disputed');
  } finally { dom.window.close(); }
});

test('a refusal about another address names that address, not the one typed', async () => {
  // Pointing a saved workspace at a *different* address is refused because of
  // the disputed one it would leave. The two addresses must differ, or this
  // proves nothing: falling back to `result.url` would read the same.
  const typed = 'https://three.example.ts.net/';
  const atFault = 'https://one.example.ts.net/';
  let sent = '';
  const dom = await mount(async (command, args) => {
    if (command === 'saved_cores') return disputedSaved;
    if (command === 'connect_core') {
      sent = args.url;
      return {
        url: typed,
        opened: false,
        identity: 'conflict',
        address: atFault,
        profileName: 'Home',
        savedWorkspaceId: null,
        workspaceId: null,
      };
    }
  });
  try {
    const document = dom.window.document;
    const status = document.querySelector('[role="status"]');
    const address = document.querySelector('#core-url');
    address.value = typed;
    submit(dom);
    await settle();
    assert.equal(sent, typed, 'the address typed is the one asked about');
    // It names the address at fault, which is not the one typed.
    assert.match(status.textContent, /one\.example\.ts\.net/, 'it names the disputed address');
    assert.doesNotMatch(status.textContent, /three\.example\.ts\.net/, 'not the address typed');
    assert.match(status.textContent, /nothing was opened or changed/);
    assert.equal(status.dataset.error, 'true');
    // Not a save that failed: there is no offer to open it without saving.
    assert.doesNotMatch(status.textContent, /could not save its address|without saving/);
    assert.equal(document.querySelector('#open-unsaved')?.hidden, true);
  } finally { dom.window.close(); }
});

test('forgetting an address is not done unconfirmed, and removing a Workspace never forgets one', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push(command);
    if (command === 'saved_cores') return withRemembered;
    if (command === 'remove_core')
      return { ...withRemembered, selected: null, profiles: withRemembered.profiles.filter((p) => p.id !== args.profile) };
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

// T-195: a record this app cannot read is usable for nothing. It will not
// open a Workspace it cannot check against the saved ones, and writes
// nothing, so what is saved stays exactly as it is. A first launch is not
// that case: nothing is saved, so the first Workspace opens and is kept.
const unreadable = {
  state: 'unreadable',
  reason: 'one of its Workspaces is not one this app opens',
  profiles: [],
};
const refusal =
  'The Workspaces saved on this iPhone could not be read (one of its Workspaces is not one this app opens). ' +
  'This app will not open a workspace it cannot check against them, and has changed nothing of what is saved.';

test('with an unreadable record nothing is opened, and nothing is written over it', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return unreadable;
    if (command === 'connect_core') throw refusal;
  });
  try {
    const document = dom.window.document;
    const status = document.querySelector('[role="status"]');
    // On opening, the record is reported as unusable rather than as a first
    // launch, and no Workspace is listed to tap.
    assert.match(status.textContent, /could not be used \(one of its Workspaces is not one this app opens\)/);
    assert.doesNotMatch(status.textContent, /to begin/);
    assert.equal(document.querySelectorAll('#saved-list li').length, 0);
    assert.equal(document.querySelector('#saved-cores').hidden, true);

    // Connecting is refused, and the page says so rather than opening.
    document.querySelector('#core-url').value = 'https://one.example.ts.net';
    submit(dom);
    await settle();
    assert.match(status.textContent, /will not open a workspace it cannot check/);
    assert.equal(status.dataset.error, 'true');
    assert.doesNotMatch(status.textContent, /Opening your workspace|Found it/);
    // Nothing offers to open it anyway, and nothing offers to discard the
    // record: losing what is saved is not this page's to offer.
    assert.equal(document.querySelector('#identity-open'), null);
    assert.equal(document.querySelector('#open-unsaved').hidden, true);
    assert.equal(
      [...document.querySelectorAll('button')].some((button) => /reset|discard|forget all|clear/i.test(button.textContent)),
      false,
    );
    // The field keeps what was typed, so the address is not lost either.
    assert.equal(document.querySelector('#core-url').value, 'https://one.example.ts.net');
    assert.equal(document.querySelector('#connect-button').disabled, false);
    // Only the read and the one refused connect: nothing wrote.
    assert.deepEqual(
      calls.map((call) => call.command),
      ['saved_cores', 'connect_core'],
    );
  } finally { dom.window.close(); }
});

test('a first launch is not an unreadable record: the first Workspace opens and is kept', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'saved_cores') return { state: 'never', profiles: [] };
    if (command === 'connect_core')
      return { url: args.url.trim(), opened: true, identity: 'known', profile: 'core-1', saved: true };
  });
  try {
    const document = dom.window.document;
    const status = document.querySelector('[role="status"]');
    assert.match(status.textContent, /Enter your workspace address/);
    document.querySelector('#core-url').value = 'https://one.example.ts.net';
    submit(dom);
    await settle();
    assert.equal(calls.at(-1).command, 'connect_core');
    assert.match(status.textContent, /Found it. Opening your workspace/);
  } finally { dom.window.close(); }
});

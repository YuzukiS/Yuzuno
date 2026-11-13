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
const i18n = await readFile(new URL('../connection/i18n.js', import.meta.url), 'utf8');
const script = await readFile(new URL('../connection/connection.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
// Objects made in the page are another realm's: compare their JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Tauri's ipc Channel, as the page makes one: the app sends progress to
// `onmessage`.
class FakeChannel {
  constructor() {
    this.onmessage = undefined;
  }
}

async function mount(invoke, nativeWindow, { lang, guideDismissed } = {}) {
  const dom = new JSDOM(html, { url: 'http://tauri.localhost/index.html', runScripts: 'outside-only' });
  dom.window.localStorage.clear();
  if (lang) dom.window.localStorage.setItem('yuzuno.connection.lang', lang);
  if (guideDismissed) dom.window.localStorage.setItem('yuzuno.connection.guideDismissed', 'yes');
  if (invoke) dom.window.__TAURI__ = { core: { invoke, Channel: FakeChannel } };
  if (nativeWindow) dom.window.__TAURI__.window = { getCurrentWindow: () => nativeWindow };
  dom.window.eval(i18n);
  dom.window.eval(script);
  await settle();
  return dom;
}

const status = (document) => document.querySelector('#connection-message');
const visible = (element) => {
  for (let at = element; at; at = at.parentElement) if (at.hidden) return false;
  return true;
};
const offline = 'Core is not reachable yet. Start it in WSL or on your chosen host, then try again.';
const wslTargets = {
  platform: 'wsl',
  available: true,
  targets: [
    { id: 'main-distro', label: 'main-distro', kind: 'wsl', selectable: true, isDefault: true },
    { id: 'old-distro', label: 'old-distro', kind: 'wsl', selectable: false, isDefault: false, note: 'WSL 1: run `wsl --set-version old-distro 2` in Windows first.' },
  ],
};
const macTargets = { platform: 'macos', available: false, reason: 'comingSoon', targets: [] };

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
    assert.match(status(document).textContent, /not reachable/);
    assert.equal(document.querySelector('#connect-button').disabled, false);
    assert.match(document.querySelector('#connect-button').textContent, /Try again/);
    document.querySelector('#core-url').value = 'http://localhost:4322';
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(calls.at(-1).args.url, 'http://localhost:4322');
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 2);
    assert.equal(document.querySelector('#core-url').disabled, false);
  } finally { dom.window.close(); }
});

// The saved Core this app may start, as connection_info names it (T-171,
// YN-111): one this computer has started before, and one it has not.
const saved = {
  coreUrl: 'http://127.0.0.1:4317/',
  autoConnect: false,
  startDistro: 'Ubuntu-24.04',
  startPlatform: 'wsl',
  startConfirmed: true,
  autoStartLocalCore: true,
};
const unconfirmed = { ...saved, startConfirmed: false };

test('a Core this computer started before is offered as Start, with its badge and switch, and starts once', async () => {
  const calls = [];
  let finish;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return saved;
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'start_core') return new Promise((resolve) => { finish = resolve; });
    if (command === 'connect_core') throw offline;
  });
  try {
    const document = dom.window.document;
    const startButton = document.querySelector('#start-button');
    assert.equal(startButton.textContent, 'Start');
    assert.equal(startButton.classList.contains('secondary'), false, 'the main action');
    assert.equal(visible(document.querySelector('#start-badge')), true);
    assert.equal(document.querySelector('#start-badge').textContent, 'started here before');
    assert.equal(document.querySelector('#start-desc').textContent, 'Ubuntu-24.04 · port 4317');
    assert.equal(visible(document.querySelector('#auto-start')), true);
    assert.equal(document.querySelector('#auto-start').checked, true);
    startButton.click();
    await settle();
    assert.match(document.querySelector('#start-message').textContent, /Starting Core in this computer's WSL \(Ubuntu-24\.04\)/);
    for (const control of ['#start-button', '#connect-button', '#core-url', '#install-button'])
      assert.equal(document.querySelector(control).disabled, true, control);
    // Clicking again, or connecting, while it starts asks for nothing more.
    startButton.click();
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await settle();
    assert.deepEqual(calls.filter((call) => call.command === 'start_core').map((call) => call.args.url), ['http://127.0.0.1:4317/']);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 0);
    finish('http://127.0.0.1:4317/?shell=desktop');
    await settle();
    assert.match(document.querySelector('#start-message').textContent, /Core is running/);
  } finally { dom.window.close(); }
});

test('Start starts the saved Core at its own address, not what is typed, and a failure is shown and not retried', async () => {
  const calls = [];
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return saved;
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'start_core') throw 'Port 4317 is used by something other than Yuzuno Core. Nothing was started.';
    throw offline;
  });
  try {
    const document = dom.window.document;
    document.querySelector('#core-url').value = 'http://127.0.0.1:4321';
    document.querySelector('#start-button').click();
    await settle();
    await settle();
    assert.deepEqual(calls.filter((call) => call.command === 'start_core').map((call) => call.args.url), ['http://127.0.0.1:4317/']);
    const said = document.querySelector('#start-message');
    assert.match(said.textContent, /used by something other than Yuzuno Core/);
    assert.equal(said.dataset.error, 'true');
    assert.equal(document.querySelector('#core-url').value, 'http://127.0.0.1:4321', 'what was typed stays');
    for (const control of ['#start-button', '#connect-button', '#core-url'])
      assert.equal(document.querySelector(control).disabled, false, control);
    assert.equal(document.querySelector('#start-button').textContent, 'Start', 'still offered');
    assert.equal(calls.filter((call) => call.command === 'start_core').length, 1, 'never retried by itself');
  } finally { dom.window.close(); }
});

test('a start no one has confirmed here keeps its caution, has no badge or switch, and goes once this computer refuses it', async () => {
  const calls = [];
  // Native side: the profile is forgotten after this computer's WSL refused it.
  let offered = unconfirmed;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return offered;
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'start_core') {
      offered = { ...unconfirmed, startDistro: null, startPlatform: null, startConfirmed: false };
      throw "Not started: this computer's WSL has no matching installation for this Workspace. If this address leads to another computer, such as an SSH tunnel, start Core there.";
    }
    throw offline;
  });
  try {
    const document = dom.window.document;
    const startButton = document.querySelector('#start-button');
    assert.equal(startButton.textContent, 'Start');
    assert.equal(startButton.classList.contains('secondary'), true);
    assert.equal(visible(document.querySelector('#start-badge')), false);
    assert.equal(visible(document.querySelector('#auto-start')), false, 'the switch acts on confirmed starts only');
    const desc = document.querySelector('#start-desc').textContent;
    assert.match(desc, /says its Core is in WSL \(Ubuntu-24\.04\)/);
    assert.match(desc, /only if it is installed in this computer's WSL/);
    // No identifiers or folders on the page.
    assert.doesNotMatch(document.body.textContent, /\/home\/|workspace-?id|[0-9a-f]{8}-[0-9a-f]{4}/i);
    startButton.click();
    await settle();
    await settle();
    assert.match(document.querySelector('#start-message').textContent, /no matching installation/);
    assert.equal(startButton.textContent, 'Find…', 'no longer offered');
    assert.equal(calls.filter((call) => call.command === 'start_core').length, 1, 'never retried by itself');
  } finally { dom.window.close(); }
});

test('without a start this app can run, Start looks for an installed Core', async () => {
  for (const info of [
    { ...saved, startDistro: undefined, startPlatform: undefined, startConfirmed: false },
    // A start no back end here can run: the app names no platform.
    { ...saved, startPlatform: null },
  ]) {
    const dom = await mount(async (command) => {
      if (command === 'connection_info') return info;
      if (command === 'local_core_targets') return wslTargets;
      throw offline;
    });
    try {
      const document = dom.window.document;
      assert.equal(document.querySelector('#start-button').textContent, 'Find…');
      assert.equal(document.querySelector('#start-button').classList.contains('secondary'), true);
      assert.equal(visible(document.querySelector('#start-badge')), false);
      assert.equal(visible(document.querySelector('#auto-start')), false);
      assert.match(document.querySelector('#start-desc').textContent, /already installed in a WSL distribution/);
    } finally { dom.window.close(); }
  }
});

// YN-111: starting this computer's confirmed Core when the app opens.
function autoStartCase(info, connectError = offline) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return info;
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'connect_core') throw connectError;
    if (command === 'start_core') throw 'WSL gave no answer within 3 minutes. Core may still be starting: try Connect in a moment. Nothing was stopped, and nothing is tried again by itself.';
  };
  return { calls, invoke };
}

test('when the app opens and its confirmed Core does not answer, it is started once, and a failure is not retried', async () => {
  const { calls, invoke } = autoStartCase({ ...saved, autoConnect: true });
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    await settle();
    const order = calls.map((call) => call.command).filter((command) => ['connect_core', 'start_core'].includes(command));
    assert.deepEqual(order, ['connect_core', 'start_core']);
    assert.equal(calls.find((call) => call.command === 'start_core').args.url, 'http://127.0.0.1:4317/');
    const said = document.querySelector('#start-message');
    assert.match(said.textContent, /no answer within 3 minutes/);
    assert.equal(said.dataset.error, 'true');
    await settle();
    await settle();
    assert.equal(calls.filter((call) => call.command === 'start_core').length, 1, 'once');
    assert.equal(document.querySelector('#start-button').disabled, false, 'it can still be started by hand');
  } finally { dom.window.close(); }
});

test('the app says it is starting by itself while it does', async () => {
  let finish;
  const entry = { id: 'core-1', name: 'Home', url: 'http://127.0.0.1:4317/', workspaceId: 'w-one', startable: true };
  const dom = await mount(async (command) => {
    if (command === 'connection_info') return { ...saved, autoConnect: true, saved: [entry], selected: 'core-1' };
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'connect_core') throw offline;
    if (command === 'start_core') return new Promise((resolve) => { finish = resolve; });
  });
  try {
    assert.match(dom.window.document.querySelector('#start-message').textContent, /Starting this computer's Core automatically/);
    assert.match(dom.window.document.querySelector('#intro').textContent, /did not answer\. Start it/);
    finish('http://127.0.0.1:4317/?shell=desktop');
    await settle();
  } finally { dom.window.close(); }
});

test('nothing starts by itself unless the Core is confirmed, the switch is on, the app just opened and nothing answered', async () => {
  const cases = [
    ['unconfirmed', { ...unconfirmed, autoConnect: true }],
    ['switched off', { ...saved, autoConnect: true, autoStartLocalCore: false }],
    ['opened from the menu', { ...saved, autoConnect: false }],
    ['no platform here', { ...saved, autoConnect: true, startPlatform: null }],
    ['another Workspace answered', { ...saved, autoConnect: true }, '“Home” answered as a different workspace than the one saved under that name, so it was not opened.'],
  ];
  for (const [name, info, error] of cases) {
    const { calls, invoke } = autoStartCase(info, error);
    const dom = await mount(invoke);
    try {
      await settle();
      assert.equal(calls.filter((call) => call.command === 'start_core').length, 0, name);
    } finally { dom.window.close(); }
  }
});

test('a record without the switch is on, and turning it off goes through the app', async () => {
  const calls = [];
  let refuse = false;
  const dom = await mount(async (command, args) => {
    calls.push({ command, args });
    if (command === 'connection_info') return { ...saved, autoStartLocalCore: undefined };
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'local_core_auto_start') {
      if (refuse) throw { code: 'notSaved', message: 'This computer could not save the change (disk full). The setting is as it was.' };
      return { enabled: args.enabled };
    }
  });
  try {
    const document = dom.window.document;
    const box = document.querySelector('#auto-start');
    assert.equal(box.checked, true, 'absent means on');
    box.checked = false;
    box.dispatchEvent(new dom.window.Event('change'));
    await settle();
    assert.deepEqual(plain(calls.filter((call) => call.command === 'local_core_auto_start').map((call) => call.args)), [{ enabled: false }]);
    assert.equal(box.checked, false);
    refuse = true;
    box.checked = true;
    box.dispatchEvent(new dom.window.Event('change'));
    await settle();
    assert.equal(box.checked, false, 'a change that was not saved is not shown as made');
    assert.match(document.querySelector('#auto-start-message').textContent, /could not save the change/);
    // Changing the switch starts nothing.
    assert.equal(calls.filter((call) => call.command === 'start_core').length, 0);
  } finally { dom.window.close(); }
});

// YN-111: the Mac until YN-108 connects its own, and other systems.
test('where this app cannot install or start Core, only Connect is shown', async () => {
  for (const targets of [macTargets, { platform: null, available: false, reason: 'unsupported', targets: [] }]) {
    const dom = await mount(async (command) => {
      if (command === 'connection_info')
        return { coreUrl: 'http://127.0.0.1:4317/', autoConnect: true, saved: [{ id: 'core-1', name: 'Studio', url: 'http://127.0.0.1:4317/', workspaceId: 'w-one', startable: false }], remembered: [] };
      if (command === 'local_core_targets') return targets;
      throw offline;
    });
    try {
      const document = dom.window.document;
      assert.equal(visible(document.querySelector('#act-start')), false, targets.reason);
      assert.equal(visible(document.querySelector('#act-install')), false, targets.reason);
      assert.equal(visible(document.querySelector('#act-connect')), true);
      assert.equal(visible(document.querySelector('#guide')), false, 'its steps are WSL steps');
      assert.equal(document.querySelector('#intro').textContent, 'Your last workspace did not answer. Try again, or choose another.');
    } finally { dom.window.close(); }
  }
});

// YN-111: the first-run guide.
const nothing = { coreUrl: 'http://127.0.0.1:4317/', autoConnect: true, saved: [], remembered: [] };

test('the first-run guide shows while nothing is saved and the default address does not answer, until it is dismissed', async () => {
  const invoke = async (command) => {
    if (command === 'connection_info') return nothing;
    if (command === 'local_core_targets') return wslTargets;
    throw offline;
  };
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    const guide = document.querySelector('#guide');
    assert.equal(visible(guide), true);
    assert.equal(guide.querySelectorAll('ol li').length, 3);
    assert.match(guide.textContent, /No administrator rights/);
    assert.match(document.querySelector('#intro').textContent, /this computer's WSL/);
    document.querySelector('#guide-dismiss').click();
    assert.equal(visible(guide), false);
    assert.equal(dom.window.localStorage.getItem('yuzuno.connection.guideDismissed'), 'yes');
  } finally { dom.window.close(); }
  const again = await mount(invoke, undefined, { guideDismissed: true });
  try {
    assert.equal(visible(again.window.document.querySelector('#guide')), false, 'not shown again');
  } finally { again.window.close(); }
});

test('the guide is not shown once something is saved, before the address is tried, when the list cannot be read, or on the Mac', async () => {
  for (const [info, targets = wslTargets] of [
    [{ ...nothing, saved: [{ id: 'core-1', name: 'Home', url: 'http://127.0.0.1:4317/', workspaceId: 'w-one', startable: false }] }],
    [{ ...nothing, remembered: [{ url: 'http://127.0.0.1:4319/', workspaceId: 'w-three' }] }],
    [{ ...nothing, autoConnect: false }],
    [{ ...nothing, savedError: 'it could not be read (denied)' }],
    [nothing, macTargets],
  ]) {
    const dom = await mount(async (command) => {
      if (command === 'connection_info') return info;
      if (command === 'local_core_targets') return targets;
      throw offline;
    });
    try {
      assert.equal(visible(dom.window.document.querySelector('#guide')), false, JSON.stringify(info));
    } finally { dom.window.close(); }
  }
});

// YN-111: install. Targets, then the check, then the install, in that order,
// with what the check gave.
const check = {
  target: 'main-distro',
  platform: 'wsl',
  user: 'someone',
  home: '/home/someone',
  checks: [
    { id: 'wsl2', level: 'required', state: 'ok' },
    { id: 'user', level: 'required', state: 'ok', detail: 'someone' },
    { id: 'arch', level: 'required', state: 'ok', detail: 'x86_64' },
    { id: 'glibc', level: 'required', state: 'ok', detail: '2.39' },
    { id: 'paths', level: 'required', state: 'ok' },
    { id: 'tools', level: 'required', state: 'ok' },
    { id: 'port', level: 'required', state: 'ok', detail: '4318' },
    { id: 'node', level: 'recommended', state: 'ok', detail: 'v22.11.0' },
    { id: 'git', level: 'recommended', state: 'ok', detail: 'git version 2.43.0' },
    { id: 'python3', level: 'recommended', state: 'ok', detail: 'Python 3.12.3' },
    { id: 'systemd', level: 'recommended', state: 'ok', detail: 'running' },
    { id: 'claude', level: 'recommended', state: 'ok', detail: '2.1.3 (Claude Code)' },
    { id: 'codex', level: 'recommended', state: 'missing', detail: 'Not found on PATH.' },
    { id: 'gh', level: 'recommended', state: 'missing', detail: 'gh is not signed in to github.com (gh auth login).' },
  ],
  installation: null,
  defaults: { installDir: '/home/someone/.local/share/yuzuno-core', dataDir: '/home/someone/.local/share/yuzuno-core-data', port: 4318 },
  installable: true,
};
const installed = {
  ...check,
  installation: { installDir: '/home/someone/.local/share/yuzuno-core', releaseId: '20261113-b870c92', port: 4317, workspaceId: 'ws-1', recorded: true },
  installable: false,
};

function installCase(answers = {}) {
  const calls = [];
  const pending = {};
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command in answers) return answers[command](args);
    if (command === 'connection_info') return { coreUrl: 'http://127.0.0.1:4317/', autoConnect: false, saved: [], remembered: [] };
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'local_core_check') return check;
    if (command === 'local_core_install') return new Promise((resolve, reject) => Object.assign(pending, { resolve, reject, channel: args.onProgress }));
    if (command === 'local_core_cancel') return null;
  };
  return { calls, pending, invoke };
}

const steps = (document) => [...document.querySelectorAll('#steps li')].map((step) => step.dataset.state);

test('installing lists the targets, checks the chosen one, then installs with its defaults and shows each step', async () => {
  const { calls, pending, invoke } = installCase();
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    calls.length = 0;
    document.querySelector('#install-button').click();
    await settle();
    assert.deepEqual(calls.map((call) => call.command), ['local_core_targets', 'local_core_check']);
    assert.equal(calls[1].args.target, 'main-distro', 'the default, selectable one');
    const options = [...document.querySelectorAll('#distro option')];
    assert.deepEqual(options.map((option) => option.disabled), [false, true], 'WSL 1 is listed and cannot be chosen');
    assert.match(options[1].textContent, /wsl --set-version old-distro 2/);
    assert.equal(visible(document.querySelector('#install-body')), true);
    assert.equal(document.querySelector('#act-install').dataset.open, 'true');
    // Required and recommended items, each with how to fix what is missing.
    const checks = document.querySelector('#checks');
    assert.deepEqual([...checks.querySelectorAll('h3')].map((heading) => heading.textContent), ['Required', 'Recommended']);
    assert.equal(checks.querySelector('[data-id="codex"]').dataset.state, 'missing');
    assert.match(checks.querySelector('[data-id="gh"]').textContent, /gh auth login/);
    assert.match(checks.querySelector('[data-id="glibc"]').textContent, /2\.35 or newer.*2\.39/);
    assert.equal(document.querySelector('#where-install').textContent, '~/.local/share/yuzuno-core');
    assert.equal(document.querySelector('#where-port').textContent, '4318');
    const go = document.querySelector('#go');
    assert.equal(go.textContent, 'Install and start');
    assert.equal(go.disabled, false);
    go.click();
    await settle();
    const install = calls.find((call) => call.command === 'local_core_install');
    assert.deepEqual(
      { target: install.args.target, installDir: install.args.installDir, dataDir: install.args.dataDir, port: install.args.port },
      { target: 'main-distro', installDir: '/home/someone/.local/share/yuzuno-core', dataDir: '/home/someone/.local/share/yuzuno-core-data', port: 4318 },
    );
    assert.ok(install.args.onProgress instanceof FakeChannel, 'progress comes through a Channel');
    assert.deepEqual(steps(document), ['todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    pending.channel.onmessage({ phase: 'release', detail: 'core-20261113-b870c92' });
    pending.channel.onmessage({ phase: 'download', done: 18_200_000, total: 34_400_000 });
    assert.deepEqual(steps(document), ['done', 'doing', 'todo', 'todo', 'todo', 'todo', 'todo']);
    assert.match(document.querySelector('#steps').textContent, /core-20261113-b870c92/);
    assert.match(document.querySelector('#steps li[data-phase="download"]').textContent, /18\.2 \/ 34\.4 MB/);
    assert.equal(document.querySelector('#steps li[data-phase="download"] .bar span').style.width, '53%');
    assert.match(document.querySelector('#steps li[data-phase="copy"]').textContent, /Copy into main-distro/);
    const cancel = document.querySelector('#progress-cancel');
    assert.equal(cancel.textContent, 'Cancel install');
    assert.equal(cancel.disabled, false);
    // A step never goes back.
    pending.channel.onmessage({ phase: 'release' });
    assert.deepEqual(steps(document), ['done', 'doing', 'todo', 'todo', 'todo', 'todo', 'todo']);
    for (const control of ['#connect-button', '#start-button', '#install-button', '#core-url'])
      assert.equal(document.querySelector(control).disabled, true, control);
    pending.resolve('http://127.0.0.1:4318/?shell=desktop');
    await settle();
    assert.deepEqual(steps(document), ['done', 'done', 'done', 'done', 'done', 'done', 'done']);
  } finally { dom.window.close(); }
});

test('cancelling is offered only in the first four steps', async () => {
  const { calls, pending, invoke } = installCase();
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#install-button').click();
    await settle();
    document.querySelector('#go').click();
    await settle();
    const cancel = document.querySelector('#progress-cancel');
    for (const phase of ['release', 'download', 'verify', 'copy']) {
      pending.channel.onmessage(phase === 'copy' ? { phase, done: 8_600_000, total: 34_400_000 } : { phase });
      assert.equal(cancel.textContent, 'Cancel install', phase);
      assert.equal(cancel.disabled, false, phase);
      assert.equal(visible(document.querySelector('#progress-hint')), true, phase);
    }
    // Copying in reports its bytes as downloading does.
    const copy = document.querySelector('#steps li[data-phase="copy"]');
    assert.match(copy.textContent, /8\.6 \/ 34\.4 MB/);
    assert.equal(copy.querySelector('.bar span').style.width, '25%');
    for (const phase of ['register', 'start', 'open']) {
      pending.channel.onmessage({ phase });
      assert.equal(cancel.disabled, true, phase);
      assert.equal(cancel.textContent, 'Registering, almost done', phase);
      assert.equal(visible(document.querySelector('#progress-hint')), false, phase);
    }
    cancel.click();
    await settle();
    assert.equal(calls.filter((call) => call.command === 'local_core_cancel').length, 0);
    pending.resolve('http://127.0.0.1:4318/?shell=desktop');
    await settle();
  } finally { dom.window.close(); }
});

test('a cancelled install says what was cleaned up, and trying again installs again', async () => {
  const { calls, pending, invoke } = installCase();
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#install-button').click();
    await settle();
    document.querySelector('#go').click();
    await settle();
    pending.channel.onmessage({ phase: 'download', done: 1_000_000, total: 34_400_000 });
    document.querySelector('#progress-cancel').click();
    await settle();
    assert.equal(calls.filter((call) => call.command === 'local_core_cancel').length, 1);
    assert.equal(document.querySelector('#progress-cancel').textContent, 'Cancelling…');
    pending.reject({ code: 'cancelled', message: 'The install was cancelled.' });
    await settle();
    assert.equal(visible(document.querySelector('#problem')), true);
    assert.equal(document.querySelector('#problem-title').textContent, 'The installation was cancelled');
    assert.match(document.querySelector('#problem-cleaned').textContent, /Nothing was written into the distribution/);
    assert.match(document.querySelector('#problem-detail').textContent, /cancelled: The install was cancelled\./);
    assert.equal(document.querySelector('#steps li[data-phase="download"]').dataset.state, 'failed');
    assert.equal(visible(document.querySelector('#progress-cancel')), false);
    for (const control of ['#connect-button', '#start-button', '#core-url'])
      assert.equal(document.querySelector(control).disabled, false, control);
    document.querySelector('#retry').click();
    await settle();
    assert.equal(calls.filter((call) => call.command === 'local_core_install').length, 2, 'installed again');
    assert.equal(visible(document.querySelector('#problem')), false);
    pending.resolve('http://127.0.0.1:4318/?shell=desktop');
    await settle();
  } finally { dom.window.close(); }
});

test('an install that fails after it is registered keeps the installation, and trying again checks first', async () => {
  const { calls, pending, invoke } = installCase();
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#install-button').click();
    await settle();
    document.querySelector('#go').click();
    await settle();
    for (const phase of ['release', 'download', 'verify', 'copy', 'register', 'start']) pending.channel.onmessage({ phase });
    pending.reject({ code: 'firstStart', message: 'Core exited before it answered.' });
    await settle();
    assert.equal(document.querySelector('#problem-title').textContent, 'The installation did not finish');
    assert.match(document.querySelector('#problem-body').textContent, /installed, but its first start did not finish/);
    assert.match(document.querySelector('#problem-cleaned').textContent, /installation stays/);
    assert.match(document.querySelector('#problem-detail').textContent, /Core exited before it answered/);
    assert.deepEqual(steps(document), ['done', 'done', 'done', 'done', 'done', 'failed', 'todo']);
    const before = calls.filter((call) => call.command === 'local_core_check').length;
    document.querySelector('#retry').click();
    await settle();
    assert.equal(calls.filter((call) => call.command === 'local_core_check').length, before + 1, 'checked again');
    assert.equal(calls.filter((call) => call.command === 'local_core_install').length, 1, 'not installed over it');
    assert.equal(visible(document.querySelector('#pane-check')), true);
  } finally { dom.window.close(); }
});

test('the cases the app names have their own words; any other follows the step it stopped at', async () => {
  const cases = [
    [[], { code: 'busy', message: 'Core is already being started.' }, /Another start or installation is under way/, /Nothing was changed/],
    [[], { code: 'notInstallable', message: 'Required: port (Port 4400 is in use).' }, /cannot be installed here yet/, /Nothing was changed/],
    [['release', 'download', 'verify', 'copy', 'register'], { code: 'tooOld', message: 'The release has no install command. The temporary folder was removed.' },
      /cannot be installed from the app yet/, /Nothing was installed/],
    [['release', 'download', 'verify', 'copy', 'register', 'start'], { code: 'starting', message: 'Core did not answer within 120 s.' },
      /did not answer within two minutes/, /may still be starting/],
    [['release', 'download', 'verify'], { code: 'verifyFailed', message: 'The archive checksum does not match.' },
      /did not pass the signature or checksum check/, /only in memory/],
  ];
  for (const [phases, error, body, cleaned] of cases) {
    const { pending, invoke } = installCase();
    const dom = await mount(invoke);
    try {
      const document = dom.window.document;
      document.querySelector('#install-button').click();
      await settle();
      document.querySelector('#go').click();
      await settle();
      for (const phase of phases) pending.channel.onmessage({ phase });
      pending.reject(error);
      await settle();
      assert.match(document.querySelector('#problem-body').textContent, body, error.code);
      assert.match(document.querySelector('#problem-cleaned').textContent, cleaned, error.code);
      assert.equal(document.querySelector('#problem-detail').textContent, `${error.code}: ${error.message}`);
    } finally { dom.window.close(); }
  }
});

test('a check that is not installable offers no install, and says how to fix each required item', async () => {
  const failing = {
    ...check,
    checks: check.checks.map((item) =>
      item.id === 'glibc' ? { ...item, state: 'missing', detail: 'glibc 2.31; Core needs 2.35 or newer.' }
        : item.id === 'tools' ? { ...item, state: 'unknown' }
          : item),
    installable: false,
  };
  failing.checks.push({ id: 'futureItem', level: 'recommended', state: 'missing', detail: 'Something a later app checks.' });
  const { invoke } = installCase({ local_core_check: () => failing });
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#install-button').click();
    await settle();
    const glibc = document.querySelector('[data-id="glibc"]');
    assert.equal(glibc.dataset.state, 'bad');
    assert.match(glibc.textContent, /Core needs 2\.35 or newer/);
    assert.match(glibc.textContent, /Ubuntu 22\.04 or later/);
    assert.equal(document.querySelector('[data-id="tools"]').dataset.state, 'unknown');
    // An id this page does not know shows what the check said.
    assert.equal(document.querySelector('[data-id="futureItem"]').textContent, '–Something a later app checks.');
    assert.equal(document.querySelector('#go').disabled, true);
    assert.equal(visible(document.querySelector('#change')), false);
  } finally { dom.window.close(); }
});

test('a changed location is checked here and sent with home expanded', async () => {
  const { calls, pending, invoke } = installCase();
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#install-button').click();
    await settle();
    document.querySelector('#change').click();
    const go = document.querySelector('#go');
    const field = (selector, value) => {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input'));
    };
    assert.equal(document.querySelector('#edit-install').value, '~/.local/share/yuzuno-core');
    field('#edit-port', '80');
    assert.equal(go.disabled, true);
    assert.match(document.querySelector('#where-error').textContent, /1024 to 65535/);
    field('#edit-port', '4400');
    field('#edit-data', '~/.local/share/yuzuno-core/data');
    assert.equal(go.disabled, true, 'one inside the other');
    assert.match(document.querySelector('#where-error').textContent, /neither the same folder nor one inside the other/);
    field('#edit-data', '~/my data');
    assert.equal(go.disabled, true, 'spaces are not passed to WSL');
    field('#edit-data', '~/core-data');
    assert.equal(go.disabled, false);
    go.click();
    await settle();
    const install = calls.find((call) => call.command === 'local_core_install');
    assert.deepEqual(
      { installDir: install.args.installDir, dataDir: install.args.dataDir, port: install.args.port },
      { installDir: '/home/someone/.local/share/yuzuno-core', dataDir: '/home/someone/core-data', port: 4400 },
    );
    pending.resolve('http://127.0.0.1:4400/?shell=desktop');
    await settle();
  } finally { dom.window.close(); }
});

test('Find looks in a distribution and starts the Core already installed there', async () => {
  const { calls, invoke } = installCase({ local_core_check: () => installed, local_core_start: () => 'http://127.0.0.1:4317/?shell=desktop' });
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    calls.length = 0;
    document.querySelector('#start-button').click();
    await settle();
    assert.equal(visible(document.querySelector('#start-body #local-panel')), true, 'it opens in the start action');
    assert.equal(document.querySelector('#distro-label').textContent, 'Look in');
    assert.equal(visible(document.querySelector('#checks')), false);
    assert.match(document.querySelector('#found-title').textContent, /already installed in main-distro/);
    assert.match(document.querySelector('#found-body').textContent, /20261113-b870c92 · port 4317 · workspace ws-1/);
    const go = document.querySelector('#go');
    assert.equal(go.textContent, 'Start it');
    go.click();
    await settle();
    assert.deepEqual(calls.map((call) => call.command), ['local_core_targets', 'local_core_check', 'local_core_start']);
    assert.equal(calls[2].args.target, 'main-distro');
    assert.match(document.querySelector('#check-message').textContent, /Core is running/);
  } finally { dom.window.close(); }
});

test('Find with nothing installed moves to installing in that distribution', async () => {
  const { invoke } = installCase();
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#start-button').click();
    await settle();
    assert.equal(visible(document.querySelector('#install-body #local-panel')), true);
    assert.equal(document.querySelector('#start-button').textContent, 'Find…');
    assert.match(document.querySelector('#not-found').textContent, /No Core is installed in main-distro yet/);
    assert.equal(document.querySelector('#go').textContent, 'Install and start');
  } finally { dom.window.close(); }
});

test('a Core already installed is started, not installed again, and a failed start is shown', async () => {
  const { calls, invoke } = installCase({
    local_core_check: () => ({ ...installed, installation: { ...installed.installation, port: null, workspaceId: null, recorded: false } }),
    local_core_start: () => { throw { code: 'startFailed', message: 'core.15 or older: start it once in WSL by hand, or update it.' }; },
  });
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#install-button').click();
    await settle();
    assert.match(document.querySelector('#found-body').textContent, /not started yet/);
    assert.equal(visible(document.querySelector('#where')), false);
    document.querySelector('#go').click();
    await settle();
    assert.equal(calls.filter((call) => call.command === 'local_core_install').length, 0);
    const said = document.querySelector('#check-message');
    assert.match(said.textContent, /start it once in WSL by hand/);
    assert.equal(said.dataset.error, 'true');
  } finally { dom.window.close(); }
});

test('without WSL, the page says how to install it and installs nothing', async () => {
  const { calls, invoke } = installCase({
    local_core_targets: () => ({ platform: 'wsl', available: false, reason: 'noWsl', message: 'WSL is not installed on this computer.', targets: [] }),
  });
  const dom = await mount(invoke);
  try {
    const document = dom.window.document;
    document.querySelector('#install-button').click();
    await settle();
    const said = document.querySelector('#check-message').textContent;
    assert.match(said, /wsl --install/);
    assert.match(said, /https:\/\/learn\.microsoft\.com\/windows\/wsl\/install/);
    assert.equal(calls.filter((call) => call.command === 'local_core_check').length, 0);
    assert.equal(visible(document.querySelector('#act-install')), true);
  } finally { dom.window.close(); }
});

// YN-111: Chinese and English.
test('every key is in both languages, and switching redraws every text the page owns', async () => {
  const dom = await mount(async (command) => {
    if (command === 'connection_info') return { ...saved, autoConnect: true };
    if (command === 'local_core_targets') return wslTargets;
    if (command === 'connect_core') throw offline;
    if (command === 'start_core') throw 'WSL gave no answer within 3 minutes.';
  });
  try {
    const { document } = dom.window;
    const words = dom.window.YUZUNO_I18N;
    assert.deepEqual(Object.keys(words.zh).sort(), Object.keys(words.en).sort());
    for (const key of Object.keys(words.zh)) assert.notEqual(words.zh[key], '', key);
    const owned = [...document.querySelectorAll('[data-t]')];
    assert.ok(owned.length > 30);
    for (const lang of ['zh', 'en', 'zh']) {
      document.querySelector(`[data-lang="${lang}"]`).click();
      assert.equal(document.documentElement.lang, lang === 'zh' ? 'zh-CN' : 'en');
      assert.equal(dom.window.localStorage.getItem('yuzuno.connection.lang'), lang);
      for (const element of owned) {
        const expected = words[lang][element.dataset.t];
        assert.notEqual(expected, undefined, element.dataset.t);
        if ('html' in element.dataset) assert.equal(element.innerHTML.replace(/<br>/g, '<br />'), expected, element.dataset.t);
        else assert.equal(element.textContent, expected, element.dataset.t);
      }
      for (const element of document.querySelectorAll('[data-t-label]'))
        assert.equal(element.getAttribute('aria-label'), words[lang][element.dataset.tLabel]);
      assert.equal(document.querySelector(`[data-lang="${lang}"]`).getAttribute('aria-pressed'), 'true');
    }
    // What the page drew itself follows too.
    assert.equal(document.querySelector('#start-button').textContent, '启动');
    assert.equal(document.querySelector('#start-desc').textContent, 'Ubuntu-24.04 · 端口 4317');
    assert.equal(document.querySelector('#intro').textContent, words.zh.introLocal);
    // A command's own words stay as they are, under Details, below a title
    // in the page's language.
    const said = status(document);
    assert.match(said.textContent, /^没能打开这个工作区。/);
    assert.equal(said.querySelector('details code').textContent, offline);
    assert.match(document.querySelector('#start-message').textContent, /^Core 没有启动。/);
    assert.equal(document.querySelector('#start-message details code').textContent, 'WSL gave no answer within 3 minutes.');
    document.querySelector('[data-lang="en"]').click();
    assert.equal(said.textContent, `${words.en.connectFailed} ${offline}`, 'in English it follows the page sentence');
    assert.equal(said.querySelector('details'), null);
  } finally { dom.window.close(); }
});

test('the page starts in the system language, or the one picked here before', async () => {
  const idleInfo = async (command) => (command === 'connection_info' ? { coreUrl: 'http://127.0.0.1:4317/', autoConnect: false } : undefined);
  const dom = await mount(idleInfo, undefined, { lang: 'zh' });
  try {
    assert.equal(dom.window.document.querySelector('#connect-title').textContent, '连接别的 Core');
    assert.equal(dom.window.document.documentElement.lang, 'zh-CN');
  } finally { dom.window.close(); }
  const english = await mount(idleInfo);
  try {
    // JSDOM's navigator.language is en-US.
    assert.equal(english.window.document.querySelector('#connect-title').textContent, 'Connect to another Core');
  } finally { english.window.close(); }
});

test('the new controls are at least 11px', async () => {
  const css = await readFile(new URL('../connection/connection.css', import.meta.url), 'utf8');
  for (const selector of ['.badge', '.lang button', 'button.quiet', '.toggle', '.check small', '.step-detail', '.footer-tag']) {
    const rule = css.match(new RegExp(`(?:^|\\n|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, selector);
    const size = rule[1].match(/font-size:\s*([\d.]+)px/);
    assert.ok(size && Number(size[1]) >= 11, `${selector}: ${size?.[1]}`);
  }
});

test('opening Connection from the native menu waits for a deliberate new selection', async () => {
  const calls = [];
  const dom = await mount(async (command) => {
    calls.push(command);
    if (command === 'local_core_targets') return wslTargets;
    return { coreUrl: 'http://127.0.0.1:4317/', autoConnect: false };
  });
  try {
    assert.deepEqual(calls.slice(0, 2), ['set_appearance', 'connection_info']);
    assert.equal(calls.filter((command) => ['connect_core', 'start_core', 'local_core_check', 'local_core_install'].includes(command)).length, 0);
    assert.match(status(dom.window.document).textContent, /Choose a workspace/);
  } finally { dom.window.close(); }
});

test('invalid launch configuration is shown without silently connecting to the default', async () => {
  const calls = [];
  const dom = await mount(async (command) => {
    calls.push(command);
    return { coreUrl: 'http://127.0.0.1:4317/', autoConnect: true, error: 'Core URLs cannot contain a username or password.' };
  });
  try {
    assert.equal(calls.filter((command) => command === 'connect_core').length, 0);
    assert.match(status(dom.window.document).textContent, /username or password/);
  } finally { dom.window.close(); }
});

test('a plain browser preview never claims that a workspace is connected', async () => {
  const dom = await mount();
  try {
    const document = dom.window.document;
    for (const control of ['#connect-button', '#start-button', '#install-button'])
      assert.equal(document.querySelector(control).disabled, true, control);
    assert.match(status(document).textContent, /preview/);
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
    // The page's own controls come before the window's in reading order.
    assert.equal(document.querySelector('button').closest('.window-controls'), null);
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

// YN-90: on macOS the system's own window buttons stand over the top band.
test('on macOS the top band moves the window under the system buttons, and a double click does what the system setting says', async () => {
  const frame = fakeWindow(true);
  let doubleClick = 'zoom';
  const dom = await mount(async (command) => (command === 'desktop_title_bar' ? { inset: 71, doubleClick } : idle()), frame);
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector('.window-controls').hidden, true, 'the system draws the window buttons');
    const press = (type, target, clientY, detail, clientX = 300) => target.dispatchEvent(
      new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY, detail }));
    const wordmark = document.querySelector('.wordmark');
    press('mousedown', wordmark, 40, 1);
    press('mousedown', document.querySelector('main'), 400, 1);
    press('mousedown', document.querySelector('#core-url'), 40, 1);
    assert.deepEqual(frame.calls, ['startDragging'], 'the band only, and not its controls');
    frame.calls.length = 0;
    // A double click: the second press is released where it began.
    const double = async (movedBy = 0) => {
      press('mousedown', wordmark, 40, 1);
      press('mousedown', wordmark, 40, 2);
      press('mouseup', wordmark, 40, 2, 300 + movedBy);
      await settle();
    };
    await double();
    doubleClick = 'minimize';
    await double();
    doubleClick = 'none';
    await double();
    doubleClick = 'zoom';
    await double(6);
    assert.deepEqual(frame.calls, [
      'startDragging', 'toggleMaximize',
      'startDragging', 'minimize',
      'startDragging',
      'startDragging',
    ], 'zoom, minimize, nothing, and nothing once the pointer moved');
  } finally { dom.window.close(); }
});

test('a Mac shell without the title bar command leaves the page as it is', async () => {
  const frame = fakeWindow(true);
  const dom = await mount(async (command) => {
    if (command === 'desktop_title_bar') throw 'Command desktop_title_bar not found';
    return idle();
  }, frame);
  try {
    dom.window.document.querySelector('.wordmark').dispatchEvent(
      new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 40, detail: 1 }));
    assert.deepEqual(frame.calls, []);
    assert.equal(dom.window.document.querySelector('.window-controls').hidden, true);
  } finally { dom.window.close(); }
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
    assert.equal(visible(document.querySelector('#saved-list')), true, 'inside Connect');
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
    const said = status(document);
    assert.match(said.textContent, /answered as a different workspace/);
    assert.equal(said.dataset.error, 'true');
    assert.doesNotMatch(said.textContent, /Opening|Connected/i);
    assert.equal(calls.filter((call) => call.command === 'connect_core').length, 1, 'asked once, not retried');
    // The list is still there to choose another; refusing is not forgetting.
    assert.equal(document.querySelectorAll('#saved-list li').length, 2);
    // It must not offer removal as a way to separate two workspaces' data:
    // removing forgets the entry and its start profile, and clears nothing
    // this app has stored for that address.
    assert.doesNotMatch(said.textContent, /forgets its drafts|clear.*drafts|removing .* drafts/i);
    assert.match(said.textContent, /does not clear what is stored for that address/);
    // Removing is no longer offered as a way round this, because it is
    // not one: the address stays remembered.
    assert.match(said.textContent, /not a way to open another one here/);
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
    const said = status(document);
    assert.equal(document.querySelector('#saved-cores').hidden, true, 'nothing is listed');
    assert.match(said.textContent, /could not be used \(one of its Workspaces is not one this app opens\)/);
    assert.match(said.textContent, /has not been changed/);
    assert.match(said.textContent, /will not open a workspace/);
    // Never "enter it again and it will be saved": connecting is refused.
    assert.doesNotMatch(said.textContent, /saves it anew|saved anew/);
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
    assert.match(status(document).textContent, /the workspace itself is unchanged/);

    document.querySelector('#saved-list li .saved-remove').click();
    await settle();
    assert.equal(calls.at(-1).command, 'remove_core');
    assert.equal(document.querySelectorAll('#saved-list li').length, 1, 'the other one stays');
    assert.match(status(document).textContent, /no longer saved on this computer/);
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
      status(document).textContent,
      /no longer remembers which workspace was at .*4319.*still there/,
    );
  } finally { dom.window.close(); }
});

test('the questions before removing and forgetting are asked in Chinese too, and say the same', async () => {
  let asked = '';
  const dom = await mount(async (command) => (command === 'connection_info' ? withRemembered : undefined), undefined, { lang: 'zh' });
  try {
    dom.window.confirm = (text) => {
      asked = text;
      return false;
    };
    dom.window.document.querySelector('#remembered-list li .saved-forget').click();
    assert.match(asked, /存的东西还在/);
    assert.match(asked, /不会删除它们/);
    assert.match(asked, /不会连接任何东西/);
    dom.window.document.querySelector('#saved-list li .saved-remove').click();
    assert.match(asked, /不会被清掉/);
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

// The page reaches the app through its own commands and nothing else: no
// event listener, no plugin, no shell (YN-107 design 7, part 4).
test('the page calls only the connection page commands', async () => {
  const allowed = JSON.parse(await readFile(new URL('../capabilities/connection.json', import.meta.url), 'utf8')).permissions
    .filter((permission) => permission.startsWith('allow-'))
    .map((permission) => permission.slice('allow-'.length).replace(/-/g, '_'));
  const invoked = [...script.matchAll(/invoke\('([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(invoked.length > 10);
  for (const command of new Set(invoked)) assert.ok(allowed.includes(command), command);
  for (const command of ['local_core_targets', 'local_core_check', 'local_core_install', 'local_core_start', 'local_core_cancel', 'local_core_auto_start', 'start_core'])
    assert.ok(invoked.includes(command), command);
  assert.doesNotMatch(script, /__TAURI__\??\.(event|shell|fs|http|process)|plugin:/);
});

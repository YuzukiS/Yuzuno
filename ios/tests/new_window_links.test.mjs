import '../../web/tools/jsdom-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The window's script for new-window links (src/new_window_links.js), on a
// Core page in JSDOM. JSDOM cannot navigate, so the script's one navigation
// is recorded here instead. That a WKWebView makes it, and that the app then
// opens Safari or Mail, is a Simulator check, not this one.
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');
const source = await readFile(new URL('../src/new_window_links.js', import.meta.url), 'utf8');
const navigation = 'window.location.href = request;';
const script = source.replace(navigation, 'window.requests.push(request);');
const core = 'https://core.example.ts.net';

function mount(body, url = `${core}/agents/a`) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, {
    url,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  dom.window.requests = [];
  dom.window.eval(script);
  return dom;
}

function click(dom, selector, init = {}) {
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  dom.window.document.querySelector(selector).dispatchEvent(event);
  return event;
}

// What the app reads from a request: `encodeURIComponent`'s characters only
// (core_url.rs `requested_link`), decoded once.
function carried(request) {
  assert.match(request, /^yuzuno-open:[A-Za-z0-9\-_.!~*'()%]+$/);
  return decodeURIComponent(request.slice('yuzuno-open:'.length));
}

test('the script navigates in one place, and nowhere else', () => {
  assert.equal(source.split(navigation).length, 2);
  // Unchanged, it makes JSDOM try that one navigation.
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><a id="web" href="https://example.com/" target="_blank">example</a>', {
    url: `${core}/`,
    runScripts: 'outside-only',
    virtualConsole,
  });
  try {
    dom.window.eval(source);
    click(dom, '#web');
    assert.deepEqual(errors, ['Not implemented: navigation to another Document']);
  } finally { dom.window.close(); }
});

test('an attachment on the Core is sent to the app as its absolute URL', () => {
  const dom = mount('<a id="file" href="/api/attachments/a%2Fb%20c.png?download=1" target="_blank">a/b c.png</a>');
  try {
    assert.equal(click(dom, '#file').defaultPrevented, true, 'no new-window action of its own');
    assert.equal(dom.window.requests.length, 1);
    assert.equal(carried(dom.window.requests[0]), `${core}/api/attachments/a%2Fb%20c.png?download=1`);
  } finally { dom.window.close(); }
});

test('a relative link is resolved against the page', () => {
  const dom = mount('<a id="report" href="files/report.pdf#page=2" target="_BLANK">Report</a>', `${core}/projects/p1/`);
  try {
    click(dom, '#report');
    assert.deepEqual(dom.window.requests.map(carried), [`${core}/projects/p1/files/report.pdf#page=2`]);
  } finally { dom.window.close(); }
});

test('a tap on what is inside a link is a tap on the link', () => {
  const dom = mount(
    '<a href="https://github.com/YuzukiS/Yuzuno/pull/1" target="_blank"><span id="label">PR</span>'
      + '<svg viewBox="0 0 1 1"><path id="icon" d="M0 0h1v1z"/></svg></a>'
      + '<a href="mailto:someone@example.com" target="_blank"><strong id="mail">Mail</strong></a>',
  );
  try {
    click(dom, '#label');
    click(dom, '#icon');
    click(dom, '#mail');
    assert.deepEqual(dom.window.requests.map(carried), [
      'https://github.com/YuzukiS/Yuzuno/pull/1',
      'https://github.com/YuzukiS/Yuzuno/pull/1',
      'mailto:someone@example.com',
    ]);
  } finally { dom.window.close(); }
});

test('a link the page sets to a new window as it is clicked is sent too', () => {
  // As web/src/components.tsx does for a web link in a message.
  const dom = mount('<div id="root"><a id="web" href="https://example.com/a">example</a></div>');
  try {
    dom.window.document.querySelector('#root').addEventListener('click', (event) => {
      event.target.closest('a').target = '_blank';
    });
    click(dom, '#web');
    assert.deepEqual(dom.window.requests.map(carried), ['https://example.com/a']);
  } finally { dom.window.close(); }
});

test('ordinary links, and clicks the page handled itself, are left to the page', () => {
  const dom = mount(
    '<a id="here" href="/settings">Settings</a><a id="self" href="/jobs" target="_self">Jobs</a>'
      + '<div id="root"><a id="handled" href="https://example.com/" target="_blank">handled</a></div>'
      + '<a id="middle" href="https://example.com/" target="_blank">middle</a>',
  );
  try {
    dom.window.document.querySelector('#root').addEventListener('click', (event) => event.preventDefault());
    assert.equal(click(dom, '#here').defaultPrevented, false);
    assert.equal(click(dom, '#self').defaultPrevented, false);
    click(dom, '#handled');
    assert.equal(click(dom, '#middle', { button: 1 }).defaultPrevented, false);
    assert.deepEqual(dom.window.requests, []);
  } finally { dom.window.close(); }
});

test('a link to another scheme, or one that is not a URL, is not sent', () => {
  const hrefs = [
    'javascript:void(0)',
    'file:///etc/hosts',
    'tauri://localhost/index.html',
    'yuzuno-open:https%3A%2F%2Fexample.com%2F',
    'tel:+15555550100',
    'https://[bad',
  ];
  const dom = mount(hrefs.map((href, index) => `<a id="l${index}" href="${href}" target="_blank">${index}</a>`).join(''));
  try {
    for (const index of hrefs.keys()) {
      assert.equal(click(dom, `#l${index}`).defaultPrevented, false, hrefs[index]);
    }
    assert.deepEqual(dom.window.requests, []);
  } finally { dom.window.close(); }
});

test('the script does nothing on the app page', () => {
  const dom = mount('<a id="web" href="https://example.com/" target="_blank">example</a>', 'tauri://localhost/index.html');
  try {
    assert.equal(click(dom, '#web').defaultPrevented, false);
    assert.deepEqual(dom.window.requests, []);
  } finally { dom.window.close(); }
});

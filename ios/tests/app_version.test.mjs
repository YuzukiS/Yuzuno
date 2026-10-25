import '../../web/tools/jsdom-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The window's script that gives each page this app's version
// (src/app_version.js), on a Core page in JSDOM, with the version put in as
// app_version.rs puts it in: one JSON string. That the WKWebView runs it on
// each page, with the version Tauri compiled in, is the iOS build's to show.
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');
const source = await readFile(new URL('../src/app_version.js', import.meta.url), 'utf8');
const PLACE = '"__YUZUNO_APP_VERSION__"';
const filled = (version) => source.replace(PLACE, JSON.stringify(version));

function page() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://core.example.ts.net/', runScripts: 'outside-only', virtualConsole });
  return { dom, window: dom.window, errors };
}

test('the app puts its version in one place', () => {
  assert.equal(source.split(PLACE).length, 2);
});

test('a page reads the version as a value it cannot replace or change', () => {
  const { window, errors } = page();
  try {
    window.eval(filled('0.1.0'));
    assert.equal(window.__YUZUNO_IPHONE_APP__.version, '0.1.0');
    assert.equal(Object.isFrozen(window.__YUZUNO_IPHONE_APP__), true);
    window.eval('window.__YUZUNO_IPHONE_APP__ = { version: "9.9.9" }; try { window.__YUZUNO_IPHONE_APP__.version = "9.9.9"; } catch {}');
    assert.equal(window.__YUZUNO_IPHONE_APP__.version, '0.1.0');
    assert.throws(() => window.eval('Object.defineProperty(window, "__YUZUNO_IPHONE_APP__", { value: { version: "9.9.9" } })'));
    assert.equal(window.__YUZUNO_IPHONE_APP__.version, '0.1.0');
    assert.equal(Object.keys(window).includes('__YUZUNO_IPHONE_APP__'), false, "not listed with the page's own globals");
    assert.deepEqual(errors, []);
  } finally { window.close(); }
});

test('it defines that one value, calls nothing of the app, and an odd version stays one string', () => {
  const { window, errors } = page();
  try {
    const touched = [];
    for (const name of ['__TAURI__', '__TAURI_INTERNALS__', 'fetch', 'XMLHttpRequest'])
      Object.defineProperty(window, name, { configurable: true, get: () => { touched.push(name); return undefined; } });
    const before = new Set(Object.getOwnPropertyNames(window));
    const odd = '1";alert(1)//';
    window.eval(filled(odd));
    assert.deepEqual(Object.getOwnPropertyNames(window).filter((name) => !before.has(name)), ['__YUZUNO_IPHONE_APP__']);
    assert.equal(window.__YUZUNO_IPHONE_APP__.version, odd);
    assert.deepEqual(touched, [], 'nothing of the app, and no request');
    assert.deepEqual(errors, [], 'no alert or other call ran');
  } finally { window.close(); }
});

import "./jsdom-guard.mjs";
// The guard's assertions on real jsdom objects (YN-196): a failing comparison
// about one stays short, however much the page has attached to it.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

function failure(call) {
  try {
    call();
  } catch (error) {
    return error;
  }
  assert.fail("the assertion passed");
}

/** A small page whose items carry a fiber chain, as React's rendered nodes do. */
function page() {
  const dom = new JSDOM(`<!doctype html><ul><li id="zz" class="row">first</li><li>second</li></ul>`);
  const { document } = dom.window;
  const items = [...document.querySelectorAll("li")];
  let fiber = { stateNode: document.body };
  for (let i = 0; i < 2000; i++) fiber = { return: fiber, stateNode: items[i % 2], memoizedProps: { i, children: items } };
  for (const item of items) item.__reactFiber$test = fiber;
  return { dom, document, row: document.getElementById("zz") };
}

function short(error, actual) {
  assert.ok(error instanceof assert.AssertionError, String(error).slice(0, 200));
  assert.ok(error.message.length < 500, `message length ${error.message.length}`);
  assert.equal(error.actual, actual);
}

test("a failing comparison about an element, a text node or a node list is one short line", () => {
  const { dom, document, row } = page();
  try {
    short(failure(() => assert.equal(row, null, "row zz is gone")), '<li id="zz" class="row">');
    short(failure(() => assert.equal(row.firstChild, null)), '#text "first"');
    short(failure(() => assert.deepEqual(document.querySelectorAll("li"), [])), 'NodeList(2) [<li id="zz" class="row">, <li>]');
    short(failure(() => assert.deepEqual([...document.querySelectorAll("li")], [])), 'Array(2) [<li id="zz" class="row">, <li>]');
  } finally {
    dom.window.close();
  }
});

test("a failing comparison about the window is one short line", () => {
  const { dom } = page();
  try {
    short(failure(() => assert.equal(dom.window, null)), "Window");
  } finally {
    dom.window.close();
  }
});

test("passing comparisons about real nodes still pass", () => {
  const { dom, document, row } = page();
  try {
    assert.equal(row, document.querySelector(".row"));
    assert.notEqual(row, null);
    assert.deepEqual([row], [row]);
    assert.notDeepEqual([row], []);
  } finally {
    dom.window.close();
  }
});

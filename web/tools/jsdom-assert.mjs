// Failing assertions about DOM objects, kept short (YN-196). A failing strict
// comparison builds its message by inspecting both values (depth 1000,
// getters on, custom inspectors off, so util.inspect.custom cannot help, and
// a message argument does not stop it either). For a DOM node that walks,
// through React's fiber properties, the whole app: the message alone can
// exhaust a 4 GiB Job before it names the failing test. jsdom-guard.mjs
// installs this for every jsdom test.
//
// When either value is, or directly holds, a DOM node or a window, the
// comparison is made here, as Node makes it; a failure is then Node's own
// assertion again, with each DOM value replaced by a one-line description, so
// its message, argument checks and operator stay Node's. Finding a DOM object
// runs no getter and no Proxy trap: it reads data properties only (a WebIDL
// class name and jsdom's own "impl" record), and a Proxy is left to Node
// (jsdom makes NodeList, HTMLCollection, <form> and <select> Proxies).
// Every other comparison is Node's own. Loads nothing but node: modules.
import assert from "node:assert/strict";
import { inspect, isDeepStrictEqual, types } from "node:util";

const COMPARISONS = {
  equal: (a, b) => Object.is(a, b),
  strictEqual: (a, b) => Object.is(a, b),
  notEqual: (a, b) => !Object.is(a, b),
  notStrictEqual: (a, b) => !Object.is(a, b),
  deepEqual: isDeepStrictEqual,
  deepStrictEqual: isDeepStrictEqual,
  notDeepEqual: (a, b) => !isDeepStrictEqual(a, b),
  notDeepStrictEqual: (a, b) => !isDeepStrictEqual(a, b),
};
const INSTALLED = Symbol.for("yuzuno.jsdom-assert");
/** Whether this Node calls a message function with the two values (Node 26
 *  does; Node 22 takes it as text): asked once of Node's own strictEqual. */
let callsMessages = false;

/** A data property's value, or undefined: never a getter call. */
function data(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** The class names (WebIDL's @@toStringTag) on an object's prototype chain,
 *  up to the first Proxy on it, which is not touched (jsdom's window has one,
 *  WindowProperties, behind Window.prototype); none for a primitive or a Proxy. */
function classes(value) {
  const found = [];
  if (typeof value !== "object" || value === null || types.isProxy(value)) return found;
  for (let proto = Object.getPrototypeOf(value); proto !== null && !types.isProxy(proto); proto = Object.getPrototypeOf(proto)) {
    const tag = data(proto, Symbol.toStringTag);
    if (typeof tag === "string") found.push(tag);
  }
  return found;
}

/** Whether an object is one of jsdom's own: webidl2js keeps what it wraps in
 *  an own data property under a symbol named "impl", on every DOM object and
 *  the window. Read without a getter or trap; a plain object that only looks
 *  like one is left to Node. Should jsdom drop it, these values go to Node's
 *  own path again, and jsdom-assert.test.mjs fails. */
function jsdomOwn(value) {
  return Object.getOwnPropertySymbols(value).some((key) => {
    const held = key.description === "impl" ? data(value, key) : undefined;
    return typeof held === "object" && held !== null;
  });
}

const isNode = (value) => classes(value).includes("Node") && jsdomOwn(value);
const isWindow = (value) => classes(value).includes("Window") && jsdomOwn(value);
const isDom = (value) => isNode(value) || isWindow(value);

/** Own enumerable data values, one level down: array items, object fields. */
function children(value) {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return [];
  return Object.keys(value).map((key) => data(value, key));
}

/** Whether a value is, or directly holds, a DOM node or a window. */
export function holdsDom(value) {
  return isDom(value) || children(value).some(isDom);
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One short line for a value, never an inspection of a DOM object. A DOM
 *  node's own getters are read here, only once it failed a comparison. */
export function describe(value) {
  if (isWindow(value)) return "Window";
  if (isNode(value)) {
    try {
      if (value.nodeType === 1) {
        const id = value.getAttribute("id");
        const className = value.getAttribute("class");
        const name = String(value.localName || value.nodeName).toLowerCase();
        return clip(`<${name}${id ? ` id="${id}"` : ""}${className ? ` class="${className}"` : ""}>`, 120);
      }
      if (value.nodeType === 3) return `#text ${JSON.stringify(clip(String(value.data ?? ""), 40))}`;
      return clip(String(value.nodeName), 120);
    } catch {
      // Not readable as a node after all: its class name, never a TypeError.
      return `[${classes(value)[0]}]`;
    }
  }
  const items = children(value);
  if (items.some(isDom)) {
    const shown = items.slice(0, 3).map((item) => (isDom(item) ? describe(item) : clip(inspect(item, { depth: 0 }), 40)));
    return `${Array.isArray(value) ? "Array" : "Object"}(${items.length}) [${shown.join(", ")}${items.length > 3 ? ", …" : ""}]`;
  }
  return clip(inspect(value, { depth: 1, breakLength: Infinity }), 120);
}

/** Node's assertion, with the stack starting where the test called. */
function call(original, wrapper, args) {
  try {
    return original(...args);
  } catch (error) {
    if (error instanceof assert.AssertionError) Error.captureStackTrace(error, wrapper);
    throw error;
  }
}

function wrap(name, original) {
  const holds = COMPARISONS[name];
  const failsWhenEqual = name.startsWith("not");
  const wrapper = {
    [name](...args) {
      const [actual, expected] = args;
      // Too few arguments, or nothing DOM: Node's own, exactly as called.
      if (args.length < 2 || (!holdsDom(actual) && !holdsDom(expected))) return call(original, wrapper, args);
      if (holds(actual, expected)) return undefined;
      // It failed: Node fails it again on descriptions that fail the same way.
      let a;
      let b;
      if (failsWhenEqual) {
        a = b = describe(holdsDom(actual) ? actual : expected);
      } else {
        a = holdsDom(actual) ? describe(actual) : actual;
        b = holdsDom(expected) ? describe(expected) : expected;
        if (isDeepStrictEqual(a, b)) b = `${String(b)} (another object)`;
      }
      let rest = args.slice(2);
      if (callsMessages && typeof rest[0] === "function") {
        // As Node would call it: once, with the two values themselves. Node
        // then takes what it returned, or what it threw, as from its own call.
        let returned;
        let threw;
        try {
          returned = rest[0](actual, expected);
        } catch (error) {
          threw = { error };
        }
        rest = [() => {
          if (threw) throw threw.error;
          return returned;
        }, ...rest.slice(1)];
      }
      call(original, wrapper, [a, b, ...rest]);
      throw new assert.AssertionError({ message: `${name} failed for a DOM object`, actual: a, expected: b, operator: name, stackStartFn: wrapper });
    },
  }[name];
  return wrapper;
}

/** Wraps node:assert/strict's comparisons once per process. */
export function install() {
  if (assert[INSTALLED]) return;
  try {
    assert.strictEqual(1, 2, () => "yuzuno-probe");
  } catch (error) {
    callsMessages = String(error?.message).startsWith("yuzuno-probe");
  }
  for (const name of Object.keys(COMPARISONS)) assert[name] = wrap(name, assert[name]);
  Object.defineProperty(assert, INSTALLED, { value: true });
}

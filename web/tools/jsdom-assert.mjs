// Failing assertions about DOM objects, kept short (YN-196). A failing strict
// comparison builds its message by inspecting both values (depth 1000,
// getters on, custom inspectors off, so util.inspect.custom cannot help, and
// a message argument does not stop it either). For a DOM node that walks,
// through React's fiber properties, the whole app: the message alone can
// exhaust a 4 GiB Job before it names the failing test. jsdom-guard.mjs
// installs this for every jsdom test. When either value is, or directly
// holds, a DOM node or a window, the comparison is made here and a failure
// names that object in one short line. Every other comparison is Node's own,
// with its own message. Loads nothing but node: modules.
import assert from "node:assert/strict";
import { inspect, isDeepStrictEqual } from "node:util";

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
// The operator Node reports for each, as its own strict assertions do.
const OPERATOR = {
  equal: "strictEqual",
  notEqual: "notStrictEqual",
  deepEqual: "deepStrictEqual",
  notDeepEqual: "notDeepStrictEqual",
};
const INSTALLED = Symbol.for("yuzuno.jsdom-assert");

/** Reads a property that may be a throwing getter or a Proxy trap. */
function read(value, key) {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function isNode(value) {
  return typeof value === "object" && value !== null
    && typeof read(value, "nodeType") === "number" && typeof read(value, "nodeName") === "string";
}

function isWindow(value) {
  return typeof value === "object" && value !== null && read(value, "window") === value;
}

const isDom = (value) => isNode(value) || isWindow(value);

/** Own enumerable values, one level down: array items, NodeList entries, object fields. */
function children(value) {
  if (typeof value !== "object" || value === null) return [];
  try {
    return Object.values(value);
  } catch {
    return [];
  }
}

/** Whether a value is, or directly holds, a DOM node or a window. */
export function holdsDom(value) {
  return isDom(value) || children(value).some(isDom);
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One short line for a value, never an inspection of a DOM object. */
export function describe(value) {
  if (isWindow(value)) return "Window";
  if (isNode(value)) {
    const type = read(value, "nodeType");
    if (type === 1) {
      const attribute = (name) => {
        try {
          return value.getAttribute(name);
        } catch {
          return null;
        }
      };
      const id = attribute("id");
      const className = attribute("class");
      const name = String(read(value, "localName") || read(value, "nodeName")).toLowerCase();
      return clip(`<${name}${id ? ` id="${id}"` : ""}${className ? ` class="${className}"` : ""}>`, 120);
    }
    if (type === 3) return `#text ${JSON.stringify(clip(String(read(value, "data") ?? ""), 40))}`;
    return String(read(value, "nodeName"));
  }
  if (typeof value === "object" && value !== null && children(value).some(isDom)) {
    const items = children(value);
    const kind = Array.isArray(value) ? "Array" : (read(value, "constructor")?.name ?? "Object");
    const shown = items.slice(0, 3).map((item) => (isDom(item) ? describe(item) : clip(inspect(item, { depth: 0 }), 40)));
    return `${kind}(${items.length}) [${shown.join(", ")}${items.length > 3 ? ", …" : ""}]`;
  }
  return clip(inspect(value, { depth: 1, breakLength: Infinity }), 120);
}

function wrap(name, original) {
  const holds = COMPARISONS[name];
  const operator = OPERATOR[name] ?? name;
  const wrapper = {
    [name](...args) {
      const [actual, expected, message] = args;
      if (!holdsDom(actual) && !holdsDom(expected)) {
        // Exactly the arguments given: Node 26 refuses an explicit undefined message.
        try {
          return original(...args);
        } catch (error) {
          // The stack starts where the test called, as it would without this.
          if (error instanceof assert.AssertionError) Error.captureStackTrace(error, wrapper);
          throw error;
        }
      }
      if (holds(actual, expected)) return;
      if (message instanceof Error) throw message;
      // A message may be a function of the two values, as Node 26 allows.
      const text = typeof message === "function" ? String(message(actual, expected)) : message;
      throw new assert.AssertionError({
        message: text ?? `${operator} failed for a DOM object (described, not inspected)`,
        actual: describe(actual),
        expected: describe(expected),
        operator,
        stackStartFn: wrapper,
      });
    },
  }[name];
  return wrapper;
}

/** Wraps node:assert/strict's comparisons once per process. */
export function install() {
  if (assert[INSTALLED]) return;
  for (const name of Object.keys(COMPARISONS)) assert[name] = wrap(name, assert[name]);
  Object.defineProperty(assert, INSTALLED, { value: true });
}

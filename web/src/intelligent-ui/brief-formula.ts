/**
 * A Calc formula (YN-16 S2): a short expression over a section's variables
 * and the Calc's earlier items, parsed by this file alone. No eval, no
 * Function, no property access, no loop, no recursion of its own: a formula
 * becomes a small tree of numbers, true and false, short texts, names, the
 * operators below and a fixed list of functions, and nothing else. The
 * contract (brief-contract.ts) parses and type-checks every formula Core
 * keeps; the renderer evaluates the same trees. No zod here: the renderer
 * imports this file.
 *
 *   expr  := or ("?" expr ":" expr)?
 *   or    := and ("||" and)*            and  := cmp ("&&" cmp)*
 *   cmp   := sum (("<"|"<="|">"|">="|"=="|"!=") sum)?
 *   sum   := prod (("+"|"-") prod)*     prod := unary (("*"|"/"|"%") unary)*
 *   unary := ("-"|"!") unary | pow      pow  := atom ("^" unary)?
 *   atom  := number | true | false | "text" | name | fn "(" expr ("," expr)* ")" | "(" expr ")"
 */
export const FORMULA_LIMITS = { chars: 240, tokens: 80, depth: 8, textChars: 64, perSection: 48 } as const;

/** Each function, with the fewest and most arguments it takes; all take and give numbers. */
export const FORMULA_FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = {
  round: [1, 2], floor: [1, 1], ceil: [1, 1], abs: [1, 1], sqrt: [1, 1], min: [2, 4], max: [2, 4], clamp: [3, 3],
};

export type FormulaType = "number" | "boolean" | "text";
export type FormulaValue = number | boolean | string;
export type FormulaNode =
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "str"; v: string }
  | { k: "var"; v: string; at: number }
  | { k: "un"; op: "-" | "!"; x: FormulaNode; at: number }
  | { k: "fn"; f: string; args: FormulaNode[]; at: number }
  | { k: "if"; c: FormulaNode; a: FormulaNode; b: FormulaNode; at: number }
  | { k: "bin"; op: string; l: FormulaNode; r: FormulaNode; at: number };

/** Why a formula is refused, where (a 0-based character offset), and an English reason an Agent can act on. */
export class FormulaError extends Error {
  readonly at: number;
  readonly reason: string;
  constructor(at: number, reason: string) {
    super(`at character ${at + 1}: ${reason}`);
    this.name = "FormulaError";
    this.at = at;
    this.reason = reason;
  }
}

type Token = { t: "num" | "bool" | "str" | "name" | "op"; v: string | number | boolean; at: number };

function tokenize(text: string): Token[] {
  if (!text.trim()) throw new FormulaError(0, "the formula is empty.");
  if (text.length > FORMULA_LIMITS.chars)
    throw new FormulaError(FORMULA_LIMITS.chars, `the formula has ${text.length} characters; the limit is ${FORMULA_LIMITS.chars}.`);
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\d+(\.\d+)?/.exec(rest))) {
      tokens.push({ t: "num", v: Number(m[0]), at: i });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const word = m[0];
      tokens.push(word === "true" || word === "false" ? { t: "bool", v: word === "true", at: i } : { t: "name", v: word, at: i });
      i += word.length;
    } else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) throw new FormulaError(i, `the text starting here has no closing ${c}.`);
      const value = text.slice(i + 1, end);
      if (value.length > FORMULA_LIMITS.textChars) throw new FormulaError(i, `a text has at most ${FORMULA_LIMITS.textChars} characters.`);
      if (/[\\`$]/.test(value)) throw new FormulaError(i, "a text cannot hold \\, ` or $.");
      tokens.push({ t: "str", v: value, at: i });
      i = end + 1;
    } else if ((m = /^(<=|>=|==|!=|&&|\|\|)/.exec(rest))) {
      tokens.push({ t: "op", v: m[0], at: i });
      i += 2;
    } else if ("+-*/%^()<>!?:,".includes(c)) {
      tokens.push({ t: "op", v: c, at: i });
      i++;
    } else if (c === "=") throw new FormulaError(i, "= assigns, which a formula cannot; compare with ==.");
    else if (c === "." && /\d/.test(text[i + 1] ?? "")) throw new FormulaError(i, "write a number with a digit before its point, e.g. 0.5.");
    else if (c === "." || c === "[" || c === "]") throw new FormulaError(i, `${c} reads a property, which a formula cannot; use the names of this section's variables and the Calc's earlier items.`);
    else throw new FormulaError(i, `${JSON.stringify(c)} is not part of a formula.`);
    if (tokens.length > FORMULA_LIMITS.tokens) throw new FormulaError(i, `the formula has more than ${FORMULA_LIMITS.tokens} parts; split it into items.`);
  }
  return tokens;
}

/** A formula's tree, or a FormulaError saying where and why it does not parse. */
export function parseFormula(text: string): FormulaNode {
  const tokens = tokenize(text);
  let p = 0;
  const at = () => tokens[p]?.at ?? text.length;
  const isOp = (token: Token | undefined, ops: readonly string[]) => token?.t === "op" && ops.includes(token.v as string);
  const take = (op: string) => (isOp(tokens[p], [op]) ? (p++, true) : false);
  const need = (op: string) => {
    if (!take(op)) throw new FormulaError(at(), tokens[p] ? `expected ${op} here, not ${String(tokens[p].v)}.` : `the formula ends where ${op} is expected.`);
  };
  const deep = (depth: number) => {
    if (depth > FORMULA_LIMITS.depth) throw new FormulaError(at(), `the formula nests deeper than ${FORMULA_LIMITS.depth} levels.`);
  };
  const chain = (next: (depth: number) => FormulaNode, ops: readonly string[]) => (depth: number) => {
    let left = next(depth);
    while (isOp(tokens[p], ops)) {
      const token = tokens[p++];
      left = { k: "bin", op: token.v as string, l: left, r: next(depth), at: token.at };
    }
    return left;
  };
  const expr = (depth: number): FormulaNode => {
    deep(depth);
    const start = at();
    const condition = or(depth);
    if (!take("?")) return condition;
    const a = expr(depth + 1);
    need(":");
    return { k: "if", c: condition, a, b: expr(depth + 1), at: start };
  };
  const atom = (depth: number): FormulaNode => {
    const token = tokens[p];
    if (!token) throw new FormulaError(text.length, "the formula ends where a value is expected.");
    p++;
    if (token.t === "num") return { k: "num", v: token.v as number };
    if (token.t === "bool") return { k: "bool", v: token.v as boolean };
    if (token.t === "str") return { k: "str", v: token.v as string };
    if (token.t === "name") {
      const name = token.v as string;
      if (!take("(")) return { k: "var", v: name, at: token.at };
      const arity = Object.hasOwn(FORMULA_FUNCTIONS, name) ? FORMULA_FUNCTIONS[name] : undefined;
      if (!arity) throw new FormulaError(token.at, `${name}() is not a formula function; the functions are ${Object.keys(FORMULA_FUNCTIONS).join(", ")}.`);
      const args = [expr(depth + 1)];
      while (take(",")) args.push(expr(depth + 1));
      need(")");
      if (args.length < arity[0] || args.length > arity[1])
        throw new FormulaError(token.at, `${name}() takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} argument${arity[1] === 1 ? "" : "s"}, not ${args.length}.`);
      return { k: "fn", f: name, args, at: token.at };
    }
    if (isOp(token, ["("])) {
      const inner = expr(depth + 1);
      need(")");
      return inner;
    }
    throw new FormulaError(token.at, `${String(token.v)} cannot start a value here.`);
  };
  const unary = (depth: number): FormulaNode => {
    deep(depth);
    if (isOp(tokens[p], ["-", "!"])) {
      const token = tokens[p++];
      return { k: "un", op: token.v as "-" | "!", x: unary(depth + 1), at: token.at };
    }
    const base = atom(depth);
    const power = tokens[p];
    return take("^") ? { k: "bin", op: "^", l: base, r: unary(depth + 1), at: power.at } : base;
  };
  const prod = chain(unary, ["*", "/", "%"]);
  const sum = chain(prod, ["+", "-"]);
  const cmp = (depth: number): FormulaNode => {
    const left = sum(depth);
    if (!isOp(tokens[p], ["<", "<=", ">", ">=", "==", "!="])) return left;
    const token = tokens[p++];
    return { k: "bin", op: token.v as string, l: left, r: sum(depth), at: token.at };
  };
  const and = chain(cmp, ["&&"]);
  const or = chain(and, ["||"]);
  const tree = expr(0);
  if (p < tokens.length) throw new FormulaError(tokens[p].at, `${String(tokens[p].v)} is left over after a complete formula.`);
  return tree;
}

const ARITHMETIC = ["+", "-", "*", "/", "%", "^"];
const ORDER = ["<", "<=", ">", ">="];

/**
 * A tree's type, given the names it may use and theirs; a FormulaError for a
 * name it may not use or an operator on the wrong types. Arithmetic and order
 * take numbers; && || ! take true or false; a text only sits beside == or !=,
 * with a text on its other side.
 */
export function formulaType(node: FormulaNode, names: Readonly<Record<string, FormulaType>>): FormulaType {
  const wrong = (at: number, what: string): never => {
    throw new FormulaError(at, what);
  };
  switch (node.k) {
    case "num":
      return "number";
    case "bool":
      return "boolean";
    case "str":
      return "text";
    case "var":
      if (!Object.hasOwn(names, node.v))
        return wrong(node.at, `"${node.v}" is neither a variable of this section nor an earlier item of this Calc${Object.keys(names).length ? `; it may use ${Object.keys(names).join(", ")}` : ""}.`);
      return names[node.v];
    case "un": {
      const x = formulaType(node.x, names);
      if (node.op === "-" && x !== "number") wrong(node.at, `- negates a number, not a ${x}.`);
      if (node.op === "!" && x !== "boolean") wrong(node.at, `! negates true or false, not a ${x}.`);
      return x;
    }
    case "fn":
      for (const arg of node.args) if (formulaType(arg, names) !== "number") wrong(node.at, `${node.f}() takes numbers.`);
      return "number";
    case "if": {
      if (formulaType(node.c, names) !== "boolean") wrong(node.at, "the part before ? must be true or false.");
      const a = formulaType(node.a, names);
      const b = formulaType(node.b, names);
      if (a !== b) wrong(node.at, `the two results of ? : must be of one type, not a ${a} and a ${b}.`);
      return a;
    }
    case "bin": {
      const l = formulaType(node.l, names);
      const r = formulaType(node.r, names);
      if (ARITHMETIC.includes(node.op)) return l === "number" && r === "number" ? "number" : wrong(node.at, `${node.op} takes numbers, not a ${l} and a ${r}.`);
      if (ORDER.includes(node.op)) return l === "number" && r === "number" ? "boolean" : wrong(node.at, `${node.op} compares numbers, not a ${l} and a ${r}.`);
      if (node.op === "==" || node.op === "!=") return l === r ? "boolean" : wrong(node.at, `${node.op} compares two values of one type, not a ${l} and a ${r}.`);
      return l === "boolean" && r === "boolean" ? "boolean" : wrong(node.at, `${node.op} takes true or false, not a ${l} and a ${r}.`);
    }
  }
}

/**
 * A number rounded to `digits` decimals as written in decimal, halves away
 * from zero on either side: round(1.005, 2) is 1.01 and round(-1.005, 2) is
 * -1.01; round(2.5) is 3 and round(-2.5) is -3 (S2 R1 P3). Never -0.
 */
function roundTo(value: number, digits: number) {
  if (!Number.isFinite(value)) return Number.NaN;
  const size = Math.abs(value);
  const rounded = /e/i.test(String(size))
    ? Math.round(size * 10 ** digits) / 10 ** digits
    : Number(`${Math.round(Number(`${size}e${digits}`))}e-${digits}`);
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

/**
 * A checked tree's value. A number that is not finite (dividing by zero, the
 * square root of a negative, an overflow) is NaN, which the renderer shows as
 * a dash with its reason, never as NaN or Infinity.
 */
export function evaluateFormula(node: FormulaNode, values: Readonly<Record<string, FormulaValue>>): FormulaValue {
  const number = (value: FormulaValue) => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
  switch (node.k) {
    case "num":
    case "bool":
    case "str":
      return node.v;
    case "var":
      return Object.hasOwn(values, node.v) ? values[node.v] : Number.NaN;
    case "un":
      return node.op === "-" ? -number(evaluateFormula(node.x, values)) : !evaluateFormula(node.x, values);
    case "if":
      return evaluateFormula(node.c, values) === true ? evaluateFormula(node.a, values) : evaluateFormula(node.b, values);
    case "fn": {
      const a = node.args.map((arg) => number(evaluateFormula(arg, values)));
      switch (node.f) {
        case "round":
          return roundTo(a[0], Math.max(0, Math.min(6, Math.trunc(a[1] ?? 0))));
        case "floor":
          return Math.floor(a[0]);
        case "ceil":
          return Math.ceil(a[0]);
        case "abs":
          return Math.abs(a[0]);
        case "sqrt":
          return a[0] < 0 ? Number.NaN : Math.sqrt(a[0]);
        case "min":
          return Math.min(...a);
        case "max":
          return Math.max(...a);
        case "clamp":
          return Math.min(Math.max(a[0], a[1]), a[2]);
      }
      return Number.NaN;
    }
    case "bin": {
      if (node.op === "&&") return evaluateFormula(node.l, values) === true && evaluateFormula(node.r, values) === true;
      if (node.op === "||") return evaluateFormula(node.l, values) === true || evaluateFormula(node.r, values) === true;
      const l = evaluateFormula(node.l, values);
      const r = evaluateFormula(node.r, values);
      if (node.op === "==") return l === r;
      if (node.op === "!=") return l !== r;
      const x = number(l);
      const y = number(r);
      switch (node.op) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        case "/":
          return y === 0 ? Number.NaN : x / y;
        case "%":
          return y === 0 ? Number.NaN : x % y;
        case "^":
          return x ** y;
        case "<":
          return x < y;
        case "<=":
          return x <= y;
        case ">":
          return x > y;
        case ">=":
          return x >= y;
      }
    }
  }
  return Number.NaN;
}

/** A Calc item: its id (a name later items use), and its formulas. */
export type CalcItem = { id: string; expr: string; when?: string };
export type CalcResult = { id: string; value: number; shown: boolean };

/**
 * A Calc's items, in order, against the section's variables: each item's
 * value (NaN when it cannot be computed) and whether its when holds. Later
 * items read earlier ones by id; an item hidden by its when still gives its
 * value to them. A formula that does not parse (which Core would not keep)
 * gives NaN.
 */
export function calcResults(items: readonly CalcItem[], variables: Readonly<Record<string, FormulaValue>>): CalcResult[] {
  const values: Record<string, FormulaValue> = { ...variables };
  return items.map((item) => {
    const run = (text: string) => {
      try {
        return evaluateFormula(parseFormula(text), values);
      } catch {
        return Number.NaN;
      }
    };
    const raw = run(item.expr);
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NaN;
    values[item.id] = value;
    return { id: item.id, value, shown: item.when === undefined || run(item.when) === true };
  });
}

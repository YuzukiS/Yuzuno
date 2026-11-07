/**
 * A Brief section's inputs and the variables they declare (YN-16): read the
 * same way by the contract (brief-contract.ts), which checks a body, and by
 * the renderer, which draws it. No zod here: the renderer imports this file
 * and does not carry the contract's schemas.
 *
 * A variable lives in one section's window only: an input writes it, a
 * block's `visible` reads it. It is never saved, never sent to an Agent and
 * never starts anything.
 */
export const INPUT_TYPES = ["NumberInput", "Switch", "Segmented"] as const;
export type InputType = (typeof INPUT_TYPES)[number];
export const isInput = (type: unknown): type is InputType => (INPUT_TYPES as readonly unknown[]).includes(type);

/** A variable's name: a letter a-z, then up to 31 letters or digits. */
export const VARIABLE_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
export type VariableKind = "number" | "boolean" | "text";
export type VariableValue = number | boolean | string;

type Node = { type?: unknown; props?: unknown; children?: unknown };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The variable an input declares, with its kind and starting value; null for any other block or a malformed input. */
export function declaredVariable(node: Node | undefined): { name: string; kind: VariableKind; value: VariableValue } | null {
  if (!node || !isInput(node.type) || !record(node.props)) return null;
  const { name, value } = node.props;
  if (typeof name !== "string" || !VARIABLE_NAME.test(name)) return null;
  if (node.type === "NumberInput") return typeof value === "number" && Number.isFinite(value) ? { name, kind: "number", value } : null;
  if (node.type === "Switch") return typeof value === "boolean" ? { name, kind: "boolean", value } : null;
  if (typeof value === "number" && Number.isFinite(value)) return { name, kind: "number", value };
  return typeof value === "string" ? { name, kind: "text", value } : null;
}

/** Blocks whose parts the reader selects (YN-16 S3): a Diagram's nodes, into the variable its select names. */
export const SELECTING_TYPES = ["Diagram"] as const;

/** The variable a block selects into and the ids it sets it to; null for any other block, or one without select. */
export function selectOf(node: Node | undefined): { name: string; ids: string[] } | null {
  if (!node || !(SELECTING_TYPES as readonly unknown[]).includes(node.type) || !record(node.props)) return null;
  const { select, nodes } = node.props;
  if (typeof select !== "string" || !VARIABLE_NAME.test(select)) return null;
  const ids = (Array.isArray(nodes) ? nodes : []).flatMap((part) => (record(part) && typeof part.id === "string" ? [part.id] : []));
  return { name: select, ids };
}

/**
 * Every variable a body declares, by name, at the value it starts with: each
 * input's, the first input of a name winning; then each select no input
 * declares, starting with nothing selected ("").
 */
export function startingValues(elements: Record<string, Node | undefined> | undefined): Record<string, VariableValue> {
  const values: Record<string, VariableValue> = {};
  for (const node of Object.values(elements ?? {})) {
    const found = declaredVariable(node);
    if (found && !Object.hasOwn(values, found.name)) values[found.name] = found.value;
  }
  for (const node of Object.values(elements ?? {})) {
    const found = selectOf(node);
    if (found && !Object.hasOwn(values, found.name)) values[found.name] = "";
  }
  return values;
}

/** What an interactive figure may hold besides its inputs, and how many blocks of its own. */
export const CARD_PART_TYPES: ReadonlySet<string> = new Set<string>([...INPUT_TYPES, "Button", "Calc", "Diagram", "Markdown", "Metrics"]);
export const CARD_PARTS = 6;

/**
 * Whether a block is an interactive figure, one a summary may name as its
 * visual so the reader adjusts it on the card itself: a Group of 1 to
 * CARD_PARTS blocks of its own, each an input, a Button, a Calc, a Diagram,
 * a Markdown or Metrics, at least one of them an input.
 */
export function interactiveGroup(elements: Record<string, Node | undefined> | undefined, id: string): boolean {
  const node = elements && Object.hasOwn(elements, id) ? elements[id] : undefined;
  if (node?.type !== "Group" || !Array.isArray(node.children)) return false;
  const children = node.children.map((child) => (typeof child === "string" && elements && Object.hasOwn(elements, child) ? elements[child] : undefined));
  return children.length >= 1 && children.length <= CARD_PARTS
    && children.every((child) => !!child && CARD_PART_TYPES.has(String(child.type)))
    && children.some((child) => isInput(child?.type));
}

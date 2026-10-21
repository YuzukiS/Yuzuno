import {
  Facet,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  showTooltip,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from "@codemirror/view";
import { pathTail } from "./skill-refs";

/**
 * A command a Claude Agent can be sent, as Claude Code lists it
 * (core/src/claude_commands.rs): Claude Code's own, a Skill, or another
 * command from a user, project, plugin or MCP server.
 */
export type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  source: "builtin" | "skill" | "custom" | "control";
  /** A Codex skill's path on the Agent's machine and its scope (T-29). */
  path?: string;
  scope?: string;
};
export type CommandList =
  | {
      state: "ready";
      reason: string;
      /** The running session's list, or its folder's while none runs;
       * or Yuzuno's own controls for a Codex Agent, which lists none. */
      source: "session" | "folder" | "controls";
      sessionId: string | null;
      commands: SlashCommand[];
      total: number;
      truncated: boolean;
      skillsKnown: boolean;
      /** Codex: why its skills are not listed, beside the controls that are. */
      skillsNote?: string;
    }
  | { state: "unavailable" | "unsupported" | "failed"; reason: string };

/** `/model`: this Agent's model settings, never a prompt. */
const modelControl: SlashCommand = {
  name: "model",
  description: "Opens this Agent's model settings; a change applies from the next turn",
  argumentHint: "<model>",
  aliases: [],
  source: "control",
};

/**
 * What a Codex Agent offers: Codex's app-server lists no commands, so only
 * the controls Yuzuno runs through Codex itself (`thread/compact/start`)
 * or through this Agent's settings.
 */
export const codexControls: CommandList = {
  state: "ready",
  reason: "controls",
  source: "controls",
  sessionId: null,
  commands: [
    { name: "compact", description: "Compacts this conversation now with Codex's own compaction, not a prompt", argumentHint: "", aliases: [], source: "control" },
    modelControl,
  ],
  total: 2,
  truncated: false,
  skillsKnown: false,
};

const skillsNotes: Record<string, string> = {
  not_connected: "Skills are listed once this Agent is connected to Codex.",
  closed: "This Agent is closed.",
  old_protocol: "This Agent's Codex does not list skills.",
};

/**
 * A Codex Agent's list: Yuzuno's controls, then the skills its own Codex
 * lists for its folder (`/agents/{id}/codex/skills`). The controls stay
 * whatever the skills' answer is.
 */
export function withCodexSkills(skills: CommandList): CommandList {
  if (codexControls.state !== "ready") return codexControls;
  if (skills.state !== "ready") {
    return { ...codexControls, skillsNote: skillsNotes[skills.reason] ?? "Could not read this Agent's Codex skills." };
  }
  return {
    ...codexControls,
    source: "session",
    commands: [...codexControls.commands, ...skills.commands.map((c) => ({ ...c, source: "skill" as const }))],
    total: codexControls.total + skills.total,
    truncated: skills.truncated,
    skillsKnown: true,
  };
}

/** Claude Code's list, with `/model` as the settings control it is here. */
export function withModelControl(list: CommandList): CommandList {
  if (list.state !== "ready") return list;
  const others = list.commands.filter((c) => c.name !== "model");
  const replaced = list.commands.length - others.length;
  return { ...list, commands: [...others, modelControl], total: list.total - replaced + 1 };
}

/**
 * A draft that is exactly one of Yuzuno's controls, run on Send instead of
 * being sent as a prompt: `/model [name]` for any Agent, and `/compact` for
 * a Codex Agent (Claude Code runs its own `/compact` as a native command).
 * `args` is whatever follows the name.
 */
export function nativeControl(text: string, harness: string): { command: "compact" | "model"; args: string } | null {
  const match = /^\/(compact|model)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  if (match[1] === "compact" && harness !== "codex") return null;
  // An OpenCode Agent's model is OpenCode's own configuration: no control.
  if (harness === "opencode") return null;
  return { command: match[1] as "compact" | "model", args: (match[2] ?? "").trim() };
}

/**
 * The command a draft starts with: "/" as its very first character, then
 * the name typed so far, with the cursor in it. A slash anywhere else, a
 * path ("/usr/bin") or a "//" is not one; neither is the text after a space.
 */
export function slashToken(start: string, cursor: number) {
  const match = /^\/([^\s/\ufffc]*)/.exec(start);
  if (!match || start[match[0].length] === "/") return null;
  const to = match[0].length;
  return cursor >= 1 && cursor <= to ? { to, query: match[1] } : null;
}

/**
 * A Codex skill being typed: "$" at the start of a word, then its name so
 * far, with the cursor in it. "$" inside a word ("a$b") is not one.
 */
export function skillToken(text: string, cursor: number) {
  const before = text.slice(Math.max(0, cursor - 200), cursor);
  const match = /(^|\s)\$([A-Za-z0-9_.:-]*)$/.exec(before);
  if (!match) return null;
  const from = cursor - match[2].length - 1;
  const rest = /^[A-Za-z0-9_.:-]*/.exec(text.slice(cursor, cursor + 200))?.[0] ?? "";
  return { from, to: cursor + rest.length, query: match[2] };
}

/** Commands whose name (or alias) starts with what was typed first, then those containing it; Claude Code's order otherwise. */
export function matching(commands: readonly SlashCommand[], query: string) {
  const q = query.toLowerCase();
  const rank = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (c.aliases.some((a) => a.toLowerCase().startsWith(q))) return 1;
    if ((name.split(":").pop() ?? "").startsWith(q)) return 2;
    return name.includes(q) ? 3 : -1;
  };
  return commands
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

type Listing =
  | { status: "loading"; previous: CommandList | null }
  | { status: "loaded"; list: CommandList };
type Menu = {
  id: string;
  open: boolean;
  query: string | null;
  /** "/" at the start of the draft, or a Codex skill's "$". */
  kind: "slash" | "skill";
  active: number;
  listing: Listing | null;
};

const closeMenu = StateEffect.define<null>();
const moveTo = StateEffect.define<number>();
const setListing = StateEffect.define<Listing | null>();
let menus = 0;
/** What is being typed at the cursor, if it is a command or (Codex) a skill. */
function head(state: EditorState): { from: number; to: number; query: string; kind: "slash" | "skill" } | null {
  const cursor = state.selection.main.head;
  const slash = slashToken(state.sliceDoc(0, Math.min(state.doc.length, 200)), cursor);
  if (slash) return { from: 0, ...slash, kind: "slash" };
  if (state.facet(kindFacet) !== "codex") return null;
  const start = Math.max(0, cursor - 200);
  const skill = skillToken(state.sliceDoc(start, Math.min(state.doc.length, cursor + 200)), cursor - start);
  return skill ? { from: start + skill.from, to: start + skill.to, query: skill.query, kind: "skill" } : null;
}

const menuField = StateField.define<Menu>({
  create: () => ({ id: `slash-menu-${++menus}`, open: false, query: null, kind: "slash", active: 0, listing: null }),
  update(menu, tr) {
    let { open, active, listing } = menu;
    for (const effect of tr.effects) {
      if (effect.is(closeMenu)) open = false;
      if (effect.is(setListing)) listing = effect.value;
      if (effect.is(moveTo)) active = effect.value;
    }
    const token = head(tr.state);
    // Only typing (or deleting) in the command opens the list, so a draft
    // restored with the cursor in "/…" stays as it was.
    if (!token) open = false;
    else if (tr.docChanged && (tr.isUserEvent("input") || tr.isUserEvent("delete")) && !tr.isUserEvent("input.complete"))
      open = true;
    const query = open && token ? token.query : null;
    const kind = token?.kind ?? menu.kind;
    if (query !== menu.query || kind !== menu.kind) active = 0;
    return open === menu.open && query === menu.query && kind === menu.kind && active === menu.active && listing === menu.listing
      ? menu
      : { ...menu, open, query, kind, active, listing };
  },
  provide: (field) => [
    showTooltip.from(field, (menu): Tooltip | null =>
      menu.open ? { pos: 0, above: true, create: createMenuView } : null,
    ),
    EditorView.contentAttributes.from(field, (menu): Record<string, string> => {
      const items = shown(menu);
      return menu.open
        ? {
            "aria-autocomplete": "list",
            "aria-expanded": "true",
            "aria-controls": menu.id,
            ...(items.length ? { "aria-activedescendant": `${menu.id}-${activeOf(menu, items)}` } : {}),
          }
        : {};
    }),
  ],
});

/** How an Agent's commands are read; none means the composer has no list. */
const loadFacet = Facet.define<() => Promise<CommandList>, (() => Promise<CommandList>) | null>({
  combine: (values) => values[0] ?? null,
});
/** Whose list this composer shows, for the menu's own wording. */
const kindFacet = Facet.define<"claude" | "codex", "claude" | "codex">({
  combine: (values) => values[0] ?? "claude",
});
/** Where a chosen Codex skill goes: the draft's own list of chosen skills. */
const skillFacet = Facet.define<(skill: SlashCommand) => void, ((skill: SlashCommand) => void) | null>({
  combine: (values) => values[0] ?? null,
});

function list(menu: Menu) {
  if (!menu.listing) return null;
  return menu.listing.status === "loaded" ? menu.listing.list : menu.listing.previous;
}
function shown(menu: Menu) {
  const current = list(menu);
  if (!menu.open || current?.state !== "ready") return [];
  const commands = menu.kind === "skill" ? current.commands.filter((c) => c.source === "skill" && c.path) : current.commands;
  return matching(commands, menu.query ?? "");
}
const activeOf = (menu: Menu, items: readonly SlashCommand[]) => Math.min(menu.active, items.length - 1);

/**
 * Fill the chosen command into the draft: its name only, keeping what
 * follows. A Codex skill is written "$name", as Codex itself writes it, and
 * added to the draft's chosen skills, which is what Send invokes. Nothing is
 * sent.
 */
function choose(view: EditorView, command: SlashCommand) {
  const token = head(view.state);
  if (!token) return;
  const skill = view.state.facet(kindFacet) === "codex" && command.source === "skill" && !!command.path;
  const after = view.state.sliceDoc(token.to, token.to + 1);
  const insert = `${skill ? "$" : "/"}${command.name}${after === " " ? "" : " "}`;
  view.dispatch({
    changes: { from: token.from, to: token.to, insert },
    selection: { anchor: token.from + insert.length + (after === " " ? 1 : 0) },
    effects: closeMenu.of(null),
    userEvent: "input.complete",
  });
  if (skill) view.state.facet(skillFacet)?.(command);
}


const sourceLabel = (c: SlashCommand, skillsKnown: boolean) =>
  c.source === "control" ? "Yuzuno control" : c.source === "builtin" ? "Claude Code" : c.source === "skill" ? (c.path ? "Codex skill" : "Skill") : skillsKnown ? "Command" : "Custom";
const unavailable: Record<string, string> = {
  closed: "This Agent is closed.",
  remote: "Commands of a Claude on another machine are not listed here.",
  initializing: "Claude is starting; type / again in a moment.",
  changed: "Claude's session changed; type / again.",
  unsupported: "This Claude Code does not list its commands.",
};

function createMenuView(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "slash-menu";
  // Clicks choose without taking focus from the draft.
  dom.addEventListener("mousedown", (event) => event.preventDefault());
  // One list box for the menu's life, so its scroll position holds.
  const box = document.createElement("div");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Claude commands");
  box.className = "slash-menu-list";
  let rendered: Menu | null = null;
  const render = () => {
    const menu = view.state.field(menuField);
    if (menu === rendered) return;
    rendered = menu;
    const current = list(menu);
    const items = shown(menu);
    const active = activeOf(menu, items);
    dom.replaceChildren();
    box.replaceChildren();
    box.id = menu.id;
    const note = (text: string, kind = "") => {
      const p = document.createElement("p");
      p.className = `slash-menu-note${kind ? ` ${kind}` : ""}`;
      p.textContent = text;
      dom.append(p);
    };
    const codex = view.state.facet(kindFacet) === "codex";
    const skills = menu.kind === "skill";
    box.setAttribute("aria-label", skills ? "Codex skills" : codex ? "Codex controls and skills" : "Claude commands");
    if (!current) {
      note(skills ? "Reading this Agent's Codex skills…" : codex ? "Reading Codex controls and skills…" : "Reading Claude's commands…");
      return;
    }
    if (current.state !== "ready") {
      note(unavailable[current.reason] ?? "Could not read Claude's commands.", "is-failed");
      return;
    }
    if (!items.length) {
      note(skills
        ? `No skill matches “$${menu.query ?? ""}”. The text stays as typed and invokes no skill.`
        : `No command matches “/${menu.query ?? ""}”. Enter sends the text as it is.`);
    } else {
      items.forEach((command, index) => {
        const option = document.createElement("div");
        option.id = `${menu.id}-${index}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === active));
        option.className = `slash-menu-item${index === active ? " is-active" : ""}`;
        const name = document.createElement("span");
        name.className = "slash-menu-name";
        name.textContent = `${command.path ? "$" : "/"}${command.name}`;
        const hint = document.createElement("span");
        hint.className = "slash-menu-hint";
        // Two skills of one name are told apart by where they are.
        hint.textContent = command.path ? [command.scope, pathTail(command.path)].filter(Boolean).join(" · ") : command.argumentHint;
        const tag = document.createElement("span");
        tag.className = `slash-menu-source is-${command.source}`;
        tag.textContent = sourceLabel(command, current.skillsKnown);
        const description = document.createElement("span");
        description.className = "slash-menu-description";
        description.textContent = command.description;
        option.append(name, hint, tag, description);
        option.title = [command.path ? `$${command.name}\n${command.path}` : `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`, command.description, command.aliases.length ? `Also /${command.aliases.join(", /")}` : ""]
          .filter(Boolean)
          .join("\n");
        option.addEventListener("click", () => choose(view, command));
        box.append(option);
      });
      dom.append(box);
      // Keep the chosen row in view by scrolling the list only, never the page.
      view.requestMeasure({
        read: () => {
          const row = box.children[active] as HTMLElement | undefined;
          return row ? { top: row.offsetTop, bottom: row.offsetTop + row.offsetHeight, at: box.scrollTop, height: box.clientHeight } : null;
        },
        write: (row) => {
          if (!row) return;
          if (row.top < row.at) box.scrollTop = row.top;
          else if (row.bottom > row.at + row.height) box.scrollTop = row.bottom - row.height;
        },
      });
    }
    if (codex) {
      note(
        skills
          ? "Skills this Agent's Codex lists for its folder. Choosing one adds it to this message; Send invokes it."
          : "Yuzuno runs its controls itself, never as a prompt: choosing one fills it in, and Send runs it. A skill chosen here is added to this message; Send invokes it.",
        "is-source",
      );
      if (current.skillsNote) note(current.skillsNote, "is-failed");
      else if (current.truncated) note(`${current.total} in all; the first ${current.commands.length} shown.`, "is-source");
    } else {
      note(
        `${current.source === "session" ? "Listed by this conversation's Claude Code" : "Listed by Claude Code for this folder; the conversation may add more once it runs"}${current.truncated ? `; ${current.total} in all, the first ${current.commands.length} shown` : ""}. Choosing one only fills it in.`,
        "is-source",
      );
    }
    if (menu.listing?.status === "loading") note("Checking for changes…", "is-loading");
  };
  return {
    dom,
    mount: render,
    update: render,
  };
}

// Reads the Agent's commands each time the list opens, so what Claude Code
// added or dropped shows. An answer for a view that is gone (another Agent's
// composer) or overtaken by a newer read is dropped.
const loader = ViewPlugin.fromClass(
  class {
    request = 0;
    destroyed = false;
    constructor(readonly view: EditorView) {
      // A state brought back for this view may carry an old list: start clean.
      const menu = view.state.field(menuField, false);
      if (menu?.listing || menu?.open)
        queueMicrotask(() => {
          if (!this.destroyed) view.dispatch({ effects: [closeMenu.of(null), setListing.of(null)] });
        });
    }
    update(update: ViewUpdate) {
      const was = update.startState.field(menuField, false);
      const now = update.state.field(menuField, false);
      if (now?.open && !was?.open) this.read(now);
    }
    read(menu: Menu) {
      const load = this.view.state.facet(loadFacet);
      if (!load) return;
      const request = ++this.request;
      const previous = list(menu);
      queueMicrotask(() => {
        if (this.destroyed || request !== this.request) return;
        this.view.dispatch({ effects: setListing.of({ status: "loading", previous }) });
        load()
          .catch((): CommandList => ({ state: "failed", reason: "read_failed" }))
          .then((answer) => {
            if (this.destroyed || request !== this.request) return;
            this.view.dispatch({ effects: setListing.of({ status: "loaded", list: answer }) });
          });
      });
    }
    destroy() {
      this.destroyed = true;
    }
  },
);

const keys = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.isComposing || view.composing) return false;
      const menu = view.state.field(menuField, false);
      if (!menu?.open) return false;
      const items = shown(menu);
      const handled = () => {
        event.preventDefault();
        return true;
      };
      // Closes the list only: never the turn (App skips a handled Escape).
      if (event.key === "Escape") {
        view.dispatch({ effects: closeMenu.of(null) });
        return handled();
      }
      if (!items.length || event.altKey || event.ctrlKey || event.metaKey) return false;
      const active = activeOf(menu, items);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        view.dispatch({ effects: moveTo.of((active + step + items.length) % items.length) });
        return handled();
      }
      const chosen = items[active];
      if (event.key === "Tab" && !event.shiftKey) {
        choose(view, chosen);
        return handled();
      }
      // Enter fills in the chosen command; a name typed in full is sent as
      // typed. A skill is chosen either way: text alone invokes none.
      if (event.key === "Enter" && !event.shiftKey && (menu.kind === "skill" || chosen.name !== menu.query)) {
        choose(view, chosen);
        return handled();
      }
      return false;
    },
  }),
);

/**
 * The slash list for one Agent's composer: typing "/" at the very start of
 * the draft lists the commands `load` reads for that Agent, and for a Codex
 * Agent "$" at the start of a word lists its skills. Choosing one fills in
 * its name and keeps the rest of the draft; a Codex skill also goes to
 * `onSkill`. Nothing is sent or run.
 */
export function slashCommands(load: () => Promise<CommandList>, kind: "claude" | "codex" = "claude", onSkill?: (skill: SlashCommand) => void): Extension {
  return [menuField, loader, keys, loadFacet.of(load), kindFacet.of(kind), ...(onSkill ? [skillFacet.of(onSkill)] : [])];
}

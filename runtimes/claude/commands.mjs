// The slash commands and Skills of one live Claude session, as Claude Code
// itself lists them (`supportedCommands()`, which follows every native
// `commands_changed` push). Nothing here lists files on disk or adds a
// command Claude Code did not list. The session's latest `system/init` says
// which are Skills and which only work in a terminal; until one arrives
// (before the first turn), neither is known and the reply says so.
const MAX_COMMANDS = 512;
const MAX_ALIASES = 8;

function text(value, max) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '';
}
// A name as typed after "/": one token, no slash in front, nothing that could
// carry a URL or control characters.
function commandName(value) {
  const name = text(value, 128);
  return name && !/[\s/]/.test(name[0]) && !/\s/.test(name) && !name.includes('://') ? name : null;
}
function names(list) {
  return Array.isArray(list) ? [...new Set(list.map(commandName).filter(Boolean))] : null;
}

/** The latest init's lists, or null when this session has had none. */
export function initFacts(event) {
  if (event?.type !== 'system' || event.subtype !== 'init') return null;
  return {
    skills: names(event.skills),
    // Absent when no listed command is terminal-only, or on CLIs that predate it.
    terminal: names(event.terminal_slash_commands) ?? [],
  };
}

export function safeCommands(list, facts) {
  if (!Array.isArray(list)) return null;
  const skills = facts?.skills ? new Set(facts.skills) : null;
  const terminal = new Set(facts?.terminal ?? []);
  const commands = [];
  let hidden = 0;
  for (const command of list) {
    const name = commandName(command?.name);
    if (!name) continue;
    // Terminal-bound commands (exit, statusline, …) do nothing useful here.
    if (terminal.has(name)) { hidden++; continue; }
    const builtin = command.builtin === true;
    commands.push({
      name,
      description: text(command.description, 300),
      argumentHint: text(command.argumentHint, 120),
      aliases: (names(command.aliases) ?? []).slice(0, MAX_ALIASES),
      // Claude Code's own; else defined by a user, project, plugin or MCP
      // server, and a Skill when this session's init lists it as one.
      source: builtin ? 'builtin' : skills?.has(name) ? 'skill' : 'custom',
    });
  }
  return {
    commands: commands.slice(0, MAX_COMMANDS),
    total: commands.length,
    truncated: commands.length > MAX_COMMANDS,
    hidden,
    skillsKnown: !!skills,
  };
}

/** Shares concurrent reads of one live Query. Never starts or reconnects it. */
export function commandsReader(runtime) {
  let facts = null;
  let pending = null;
  return {
    observe(event) {
      const next = initFacts(event);
      if (next) facts = next;
    },
    read() {
      if (!runtime.ready || runtime.closed || !runtime.query) return { state: 'unavailable' };
      if (typeof runtime.query.supportedCommands !== 'function') return { state: 'unsupported' };
      if (pending) return pending;
      const query = runtime.query;
      const sessionId = runtime.sessionId;
      pending = Promise.resolve().then(async () => {
        try {
          const listed = safeCommands(await query.supportedCommands(), facts);
          if (runtime.closed || !runtime.ready || runtime.query !== query || runtime.sessionId !== sessionId) {
            return { state: 'changed' };
          }
          return listed ? { state: 'ready', sessionId, ...listed } : { state: 'failed' };
        } catch (error) {
          return { state: /unsupported|not supported|unknown (?:request|method)|method not found/i.test(error instanceof Error ? error.message : '')
            ? 'unsupported' : 'failed' };
        } finally { pending = null; }
      });
      return pending;
    },
  };
}

// Real bridge, scripted SDK for Claude Code's file checkpoints. No CLI or
// model is started. In the Agent's folder:
//   checkpoints.json  { "<native uuid>": { "<file>": "<content then>" | null } }
//                     (null: the file did not exist then)
//   not-enabled       when present, answers as a session without checkpointing
//   postcheck.json    {"after": "negative" | "missing" | "throw"}: how the dry
//                     run right after a real rewind answers (Claude Code says
//                     no, leaves out filesChanged, or the request fails)
//   partial.json      {"keep": ["<file>"], "skippedLinks": n}: a real rewind
//                     leaves these files as they are and reports n links
// It answers as CLI 2.1.280 does (acceptance/t32/probe): absolute paths and
// line counts on a preview; on a rewind only canRewind and skippedLinks. A
// rewind to a message puts back every file tracked then or later.
//
// A prompt of lines "write <file>: <text>" writes those files, as Write
// would, and keeps the checkpoint: the prompt's own, holding every tracked
// file as it is now, and the new file in earlier ones. A prompt that writes
// nothing gets no checkpoint (as a reply-only turn after a resume had none).
// A line "wait <ms>" first keeps the turn running that long.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';

const session = '5e55a0ee-0000-4000-8000-000000000032';

function query({ options, prompt }) {
  const output = new PromptQueue();
  const path = name => join(options.cwd, name);
  const read = name => (existsSync(path(name)) ? readFileSync(path(name), 'utf8') : null);
  const checkpoints = () => JSON.parse(read('checkpoints.json') ?? '{}');
  writeFileSync(path('options.json'), JSON.stringify({ enableFileCheckpointing: options.enableFileCheckpointing ?? null }));
  output.initializationResult = async () => ({});
  // A lab Core offers its Workspace MCP server; the fixture takes any it is given.
  output.setMcpServers = async servers => ({ added: Object.keys(servers ?? {}), removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  output.setModel = async () => {};
  output.setPermissionMode = async () => {};
  output.applyFlagSettings = async () => {};
  const control = name => JSON.parse(read(name) ?? 'null');
  let checkNext = false;
  output.rewindFiles = async (id, opts) => {
    appendFileSync(path('rewinds'), `${id} ${opts?.dryRun ? 'dry' : 'real'}\n`);
    if (!options.enableFileCheckpointing || existsSync(path('not-enabled'))) return { canRewind: false, error: 'File rewinding is not enabled.' };
    const checkpoint = checkpoints()[id];
    if (!checkpoint) return { canRewind: false, error: 'No file checkpoint found for this message.' };
    const post = opts?.dryRun && checkNext ? control('postcheck.json')?.after : null;
    if (opts?.dryRun) checkNext = false;
    if (post === 'throw') throw new Error('Claude Code exited while checking');
    if (post === 'negative') return { canRewind: false, error: 'Checkpoint state could not be read.' };
    if (post === 'missing') return { canRewind: true };
    const differing = Object.entries(checkpoint).filter(([file, then]) => read(file) !== then);
    if (opts?.dryRun) {
      return { canRewind: true, filesChanged: differing.map(([file]) => path(file)), insertions: differing.length, deletions: differing.length };
    }
    const partial = control('partial.json');
    for (const [file, then] of differing) {
      if (partial?.keep?.includes(file)) continue;
      then === null ? rmSync(path(file)) : writeFileSync(path(file), then);
    }
    checkNext = true;
    return { canRewind: true, skippedLinks: partial?.skippedLinks ?? 0 };
  };
  const push = frame => output.push({ session_id: session, parent_tool_use_id: null, ...frame });
  (async () => {
    for await (const message of prompt) {
      const uuid = message.uuid;
      const stamp = { user_message_uuid: uuid, user_message_uuids: [uuid] };
      const content = message.message.content;
      const text = typeof content === 'string' ? content : content.map(b => b.text ?? '').join('');
      push({ type: 'system', subtype: 'init', uuid: `init-${uuid}`, model: 'fixture' });
      const wait = Number(text.match(/^wait (\d+)$/m)?.[1] ?? 0);
      if (wait) await new Promise(resolve => setTimeout(resolve, Math.min(wait, 10000)));
      const writes = [...text.matchAll(/^write ([\w.-]+): (.*)$/gm)].map(([, file, body]) => [file, `${body}\n`]);
      if (writes.length) {
        const all = checkpoints();
        const tracked = new Set(Object.values(all).flatMap(Object.keys));
        all[uuid] = Object.fromEntries([...tracked].map(file => [file, read(file)]));
        for (const [file] of writes) for (const kept of Object.values(all)) if (!(file in kept)) kept[file] = read(file);
        writeFileSync(path('checkpoints.json'), JSON.stringify(all));
        for (const [file, body] of writes) writeFileSync(path(file), body);
      }
      const said = writes.length ? `Wrote ${writes.map(([file]) => file).join(', ')}.` : 'Nothing to write.';
      push({ type: 'assistant', uuid: `reply-${uuid}`, ...stamp, message: { id: `msg-${uuid}`, role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: said }] } });
      push({ type: 'result', subtype: 'success', uuid: `done-${uuid}`, is_error: false, duration_ms: 5, num_turns: 1, result: said, ...stamp });
    }
  })();
  return output;
}
const bridge = new ClaudeBridge({ query, emit: (_event, encoded) => process.stdout.write(`${encoded}\n`),
  resolveCli: () => '/fixture/claude', version: async () => '2.1.280' });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    void bridge.handle(command).then(() => { if (command?.op === 'close') process.exit(0); });
  }
});
process.stdin.on('end', () => { bridge.close(); process.exit(0); });

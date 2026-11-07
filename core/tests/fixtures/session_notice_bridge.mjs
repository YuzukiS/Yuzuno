// Real bridge, scripted SDK (YN-5). Each start appends the session it
// resumes and the system prompt append it was given to starts.jsonl in its
// cwd; the Workspace MCP server it is given is reported added. No CLI, model
// or MCP service is started.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeBridge, PromptQueue } from '../../../runtimes/claude/bridge.mjs';
function query({ options, prompt }) {
  const output = new PromptQueue();
  appendFileSync(join(options.cwd, 'starts.jsonl'), `${JSON.stringify({
    resume: options.resume ?? null, append: options.systemPrompt?.append ?? null })}\n`);
  output.initializationResult = async () => ({});
  output.setMcpServers = async servers => ({ added: Object.keys(servers), removed: [], errors: {} });
  output.interrupt = async () => {};
  output.supportedModels = async () => [];
  output.mcpServerStatus = async () => [];
  (async () => { for await (const _ of prompt) appendFileSync(join(options.cwd, 'prompts'), 'unexpected\n'); })();
  return output;
}
const bridge = new ClaudeBridge({ query, emit: (_event, encoded) => process.stdout.write(`${encoded}\n`),
  resolveCli: () => '/fixture/claude', version: async () => '2.1.318' });
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

#!/usr/bin/env node
// T-27 lab probe: one native Claude Code session as the SDK reads it, read
// only (getSessionInfo, getSessionMessages; nothing is written):
//
//   node probe.mjs <sdk.mjs> <session id> <folder>
//
// Prints one JSON line: whether it was found, its file size and last saved
// time, how many messages Claude saved, and each prompt's uuid and start.
const [sdk, id, dir] = process.argv.slice(2);
const { getSessionInfo, getSessionMessages } = await import(sdk);
const info = await getSessionInfo(id, { dir });
const messages = await getSessionMessages(id, { dir, includeSystemMessages: true });
const text = m => (typeof m.message?.content === 'string' ? m.message.content
  : (m.message?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n'));
const prompts = messages.filter(m => m.type === 'user' && !m.parent_tool_use_id && m.is_meta !== true
  && m.isCompactSummary !== true && m.isCompletedLocalCommand !== true
  && !(Array.isArray(m.message?.content) && m.message.content.some(b => b?.type === 'tool_result')));
console.log(JSON.stringify({
  found: Boolean(info), cwd: info?.cwd ?? null, fileSize: info?.fileSize ?? null, lastModified: info?.lastModified ?? null,
  messages: messages.length, prompts: prompts.map(m => ({ uuid: m.uuid, text: text(m).slice(0, 120) })),
}));

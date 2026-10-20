// Deliberately do not forward config, URLs, headers, tools or raw SDK errors.
const statuses = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);

function reason(error) {
  const text = typeof error === 'string' ? error : '';
  if (/401|403|unauthori[sz]ed|authentication|oauth|credential/i.test(text)) return 'authentication';
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/ENOENT|not found|executable|spawn/i.test(text)) return 'executable';
  if (/ECONN|ENOTFOUND|network|connection|socket|DNS/i.test(text)) return 'connection';
  if (/invalid.*config|configuration|missing.*(?:variable|setting)/i.test(text)) return 'configuration';
  return 'failed';
}

function name(value, index) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160
      || /[\x00-\x1f\x7f]|:\/\/|bearer\s|(?:token|password|secret|api[-_]?key)\s*[:=]/i.test(value)) {
    return `MCP service ${index + 1}`;
  }
  return value.trim();
}

export function safeMcpServers(value) {
  if (!Array.isArray(value)) return null;
  return {
    servers: value.slice(0, 256).map((server, index) => {
      const status = statuses.has(server?.status) ? server.status : 'unknown';
      return { name: name(server?.name, index), status,
        ...(status === 'failed' ? { reason: reason(server?.error) } : {}) };
    }),
    total: value.length,
    truncated: value.length > 256,
  };
}

/** Shares concurrent reads of one live Query. Never starts/reconnects it. */
export function mcpStatusReader(runtime) {
  let pending = null;
  return async () => {
    if (!runtime.ready || runtime.closed || !runtime.query) return { state: 'unavailable' };
    if (typeof runtime.query.mcpServerStatus !== 'function') return { state: 'unsupported' };
    if (pending) return pending;
    const query = runtime.query;
    const sessionId = runtime.sessionId;
    pending = Promise.resolve().then(async () => {
      try {
        const servers = safeMcpServers(await query.mcpServerStatus());
        if (runtime.closed || !runtime.ready || runtime.query !== query || runtime.sessionId !== sessionId) {
          return { state: 'changed' };
        }
        return servers ? { state: 'ready', sessionId, ...servers } : { state: 'failed' };
      } catch (error) {
        // Exceptions may echo arbitrary native configuration secrets. A
        // categorical failure must be returned before bridge.handle logs it.
        return { state: /unsupported|not supported|unknown (?:request|method)|method not found/i.test(error instanceof Error ? error.message : '')
          ? 'unsupported' : 'failed' };
      } finally { pending = null; }
    });
    return pending;
  };
}

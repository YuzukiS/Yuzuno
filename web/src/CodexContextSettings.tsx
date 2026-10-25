import { RefreshCw } from "lucide-react";
import type { CodexContextSettings as Context } from "./types";
import { strings, useStrings } from "./i18n";

/** Thrown in English and said in the language shown (T-189). */
export const TOKEN_INVALID = "Enter a positive whole number, or leave blank for automatic.";

export function tokenSetting(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new Error(TOKEN_INVALID);
  return Number(value);
}

const tokens = (n: number) => n.toLocaleString();

// The fieldset's own words (T-189); the numbers as Codex reports them.
export const contextText = strings({
  tokenInvalid: TOKEN_INVALID,
  blocked: "This execution machine has not reported support for these settings. Update its Codex runtime to configure them.",
  reconnect: "Reload has not finished. You can save corrected settings after a rejection, then reconnect to resume this same conversation.",
  firstTurn: "This new conversation must finish its first turn before reloading. Saved context changes apply when you click Apply then.",
  submitted: "Sent to Codex. Effective limits are only known from its native usage report.",
  ready: "Saved settings have not been submitted for reload. Save first, then apply while the conversation is idle.",
  legend: "Context window",
  available: "Available window",
  refresh: "Refresh context status",
  unknown: "Unknown",
  tokens: " tokens",
  lastKnown: "last known",
  notReported: "Codex has not reported it yet.",
  reported: "As Codex last reported it; the usage meter uses this.",
  differs: (n: string) => `Differs from the saved request (${n} tokens): model limits and the output reserve can lower it.`,
  window: "Window",
  windowLabel: "Context window tokens",
  automatic: "Automatic",
  unit: "tokens",
  blankConfig: (n: string | null) => `Blank uses Codex’s configuration${n !== null ? ` (${n})` : ""}.`,
  compactAt: "Compact at",
  compactLabel: "Auto-compaction threshold",
  ninety: "90% of window",
  blankNinety: "Blank uses 90% of the window.",
  how: "How these apply",
  howCustom: "A custom value applies only to this Agent. Codex may lower the window to the model’s limit and reserve space for output.",
  howCompact: "With a custom window, automatic compaction uses 90% of it and replaces any lower inherited threshold; Codex can clamp it further.",
  howApply: "Applying reloads this same conversation while it is idle: running turns and pending approvals finish first.",
  reset: "Reset to automatic",
  apply: "Apply now",
}, {
  tokenInvalid: "请输入正整数，或留空以使用自动值。",
  blocked: "此执行机器尚未报告支持这些设置。请更新其 Codex 运行环境后再配置。",
  reconnect: "重新载入尚未完成。如被拒绝，可以保存更正后的设置，再重新连接以继续同一会话。",
  firstTurn: "这个新会话必须先完成第一个 Turn 才能重新载入。届时点击“立即应用”，已保存的上下文更改才会生效。",
  submitted: "已发送给 Codex。实际生效的限制只能从它的原生用量报告中得知。",
  ready: "已保存的设置尚未提交重新载入。请先保存，再在会话空闲时应用。",
  legend: "上下文窗口",
  available: "可用窗口",
  refresh: "刷新上下文状态",
  unknown: "未知",
  tokens: " 个 token",
  lastKnown: "上次已知",
  notReported: "Codex 尚未报告。",
  reported: "以 Codex 最近一次报告为准；用量指示使用此值。",
  differs: (n) => `与保存的请求值（${n} 个 token）不同：模型限制和输出预留空间可能会降低它。`,
  window: "窗口",
  windowLabel: "上下文窗口 token 数",
  automatic: "自动",
  unit: "token",
  blankConfig: (n) => `留空则使用 Codex 的配置${n !== null ? `（${n}）` : ""}。`,
  compactAt: "压缩阈值",
  compactLabel: "自动压缩阈值",
  ninety: "窗口的 90%",
  blankNinety: "留空则使用窗口的 90%。",
  how: "这些设置如何生效",
  howCustom: "自定义值只对此 Agent 生效。Codex 可能会把窗口降到模型的上限，并为输出预留空间。",
  howCompact: "使用自定义窗口时，自动压缩会采用其 90%，并取代任何更低的继承阈值；Codex 还可能进一步收紧它。",
  howApply: "应用会在此会话空闲时重新载入同一会话：正在运行的 Turn 和待处理的审批会先完成。",
  reset: "恢复为自动",
  apply: "立即应用",
});
type ContextWords = ReturnType<typeof contextText>;

/** Where applying stands: one line, its tone, and whether Apply is the next step. */
function applyState(context: Context | undefined, t: ContextWords): { tone: "ready" | "done" | "wait" | "blocked"; text: string } {
  if (!context?.supported) return { tone: "blocked", text: t.blocked };
  if (context.needsReconnect) return { tone: "wait", text: t.reconnect };
  if (context.needsFirstTurn) return { tone: "wait", text: t.firstTurn };
  if (context.settingsSubmitted) return { tone: "done", text: t.submitted };
  return { tone: "ready", text: t.ready };
}

/**
 * Codex's context window for one Agent: what Codex reports now, the two
 * overrides, and applying them, which reloads this same conversation.
 */
export function CodexContextSettings({ context, window, compact, disabled, note, onWindow, onCompact, onApply, onRefresh, onReset }: {
  context?: Context; window: string; compact: string; disabled: boolean;
  /** The outcome of the user's last action here (save, apply, reset). */
  note?: string;
  onWindow: (value: string) => void; onCompact: (value: string) => void; onApply: () => void;
  onRefresh?: () => void;
  /** Present while overrides are saved: clears them. */
  onReset?: () => void;
}) {
  const supported = !!context?.supported;
  const observed = context?.observedWindowTokens ?? null;
  const requested = context?.requestedWindowTokens ?? null;
  const t = useStrings(contextText);
  const state = applyState(context, t);
  return <fieldset className="agent-setting codex-context-settings" disabled={disabled}>
    <legend>{t.legend}</legend>
    <div className="codex-context-reported">
      <div className="codex-context-reported-head">
        <span>{t.available}</span>
        {onRefresh && <button type="button" className="icon-button" aria-label={t.refresh} title={t.refresh} onClick={onRefresh}>
          <RefreshCw size={13} />
        </button>}
      </div>
      <p className="codex-context-figure">
        {observed == null ? <strong>{t.unknown}</strong> : <><strong>{tokens(observed)}</strong>{t.tokens}</>}
        {observed != null && context?.observedStale && <span className="codex-context-stale">{t.lastKnown}</span>}
      </p>
      <small>{observed == null ? t.notReported : t.reported}</small>
      {requested != null && observed != null && requested !== observed &&
        <small className="codex-context-differs">{t.differs(tokens(requested))}</small>}
    </div>
    <div className="codex-context-fields">
      <label>{t.window}
        <span className="codex-context-input">
          <input aria-label={t.windowLabel} inputMode="numeric" value={window}
            disabled={!supported} placeholder={t.automatic}
            onChange={(event) => onWindow(event.target.value)} />
          <span aria-hidden="true">{t.unit}</span>
        </span>
        <small>
          {t.blankConfig(context?.inheritedContextWindow != null ? tokens(context.inheritedContextWindow) : null)}
        </small>
      </label>
      <label>{t.compactAt}
        <span className="codex-context-input">
          <input aria-label={t.compactLabel} inputMode="numeric" value={compact}
            disabled={!supported} placeholder={window ? t.ninety : t.automatic}
            onChange={(event) => onCompact(event.target.value)} />
          <span aria-hidden="true">{t.unit}</span>
        </span>
        <small>
          {window
            ? t.blankNinety
            : t.blankConfig(context?.inheritedAutoCompactTokenLimit != null ? tokens(context.inheritedAutoCompactTokenLimit) : null)}
        </small>
      </label>
    </div>
    <details className="codex-context-more">
      <summary>{t.how}</summary>
      <p>{t.howCustom}</p>
      <p>{t.howCompact}</p>
      <p>{t.howApply}</p>
    </details>
    <div className="codex-context-apply" data-tone={state.tone}>
      {/* The last action's outcome stands in for a routine state; a state
          that blocks applying always shows. */}
      <p role="status">{note && state.tone !== "blocked" && state.tone !== "wait" ? note : state.text}</p>
      {note && (state.tone === "blocked" || state.tone === "wait") && <p className="codex-context-note">{note}</p>}
      <div className="codex-context-actions">
        {onReset && <button type="button" className="quiet-button" onClick={onReset}>{t.reset}</button>}
        <button type="button" className="secondary-button" disabled={!supported || !context?.canApply} onClick={onApply}>{t.apply}</button>
      </div>
    </div>
  </fieldset>;
}

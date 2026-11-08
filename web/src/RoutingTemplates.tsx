import { useEffect, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";
import { errorText } from "./api";
import { readExecutorTemplates, saveExecutorTemplates, type ExecutorTemplate, type ExecutorTemplatesView } from "./executor-templates";
import { strings, useLanguage } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";

/** A template as kept, with S3a's `routing`: "fixed", or unset to follow routing. */
type Routed = ExecutorTemplate & { routing?: "fixed"; [field: string]: unknown };
const harnessName: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

const text = strings({
  title: "Templates",
  help: "A template that follows routing starts its executors by the order above; a fixed one starts them with its own tool and model and the host's login, as before routing.",
  follow: "Follows routing",
  fixed: "Fixed",
  followSub: "By the order above",
  fixedSub: (what: string) => `Fixed: ${what}`,
  hostDefault: "the defaults for new Agents",
  general: "General executor (no template)",
  generalSub: "Always follows routing",
  modeOf: (label: string) => `${label}: follow routing or fixed`,
  none: "No template yet.",
  reading: "Reading templates…",
  conflict: "The templates were changed elsewhere since this page read them. Nothing was saved here.",
  reload: "Read them again",
}, {
  title: "模板",
  help: "跟随路由的模板按上面的顺序启动执行者；固定的模板用它自己的工具、模型和主机的登录启动，和有路由之前一样。",
  follow: "跟随路由",
  fixed: "固定",
  followSub: "按上面的顺序选",
  fixedSub: (what) => `固定：${what}`,
  hostDefault: "新 Agent 的默认",
  general: "通用执行者（不带模板）",
  generalSub: "总是跟随路由",
  modeOf: (label) => `${label}：跟随路由或固定`,
  none: "还没有模板。",
  reading: "正在读取模板…",
  conflict: "模板在别处被改过了，这里没有保存任何东西。",
  reload: "重新读取",
});

/** Settings → Executor routing → Templates (YN-49 S4b): each template follows
 * routing or is fixed (S3a's `routing: "fixed"`). Saved through the page's
 * save bar as the whole template list, as read but for `routing`, against its
 * version; a list changed elsewhere meanwhile is not overwritten. */
export function RoutingTemplates({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<ExecutorTemplatesView | null>(null);
  const [fixed, setFixed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const templates = (view?.workspace.templates ?? []) as Routed[];
  const adopt = (next: ExecutorTemplatesView) => {
    setView(next);
    setFixed(Object.fromEntries((next.workspace.templates as Routed[]).map((tp) => [tp.id, tp.routing === "fixed"])));
    setConflict(false);
    setError("");
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    readExecutorTemplates(controller.signal).then((next) => { if (!controller.signal.aborted) adopt(next); })
      .catch((e) => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [active, reload]);
  const changed = templates.some((tp) => (tp.routing === "fixed") !== !!fixed[tp.id]);
  async function save(): Promise<boolean> {
    if (!view) return false;
    // The list as read, each template whole, with only `routing` set or removed.
    const next = templates.map((tp) => {
      const { routing: _, ...rest } = tp;
      return (fixed[tp.id] ? { ...rest, routing: "fixed" } : rest) as ExecutorTemplate;
    });
    try {
      adopt(await saveExecutorTemplates(view.workspace.version, next));
      return true;
    } catch (e) {
      const words = errorText(e);
      if (words.startsWith("version_conflict")) setConflict(true); else setError(words);
      return false;
    }
  }
  useSaveBarPart("routing-templates", changed && view ? { ready: !conflict, save, discard: () => { if (view) adopt(view); } } : null);

  const fixedWhat = (tp: Routed) => [harnessName[tp.harness] ?? tp.harness, tp.model || t.hostDefault].join(" · ");
  return (
    <section className="routing-templates" aria-labelledby="routing-templates-title">
      <h4 id="routing-templates-title" className="settings-group-title">{t.title}</h4>
      <p className="settings-block-help">{t.help}</p>
      {active && !view && !error && <p className="settings-row-help" role="status">{t.reading}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {conflict && (
        <div className="routing-conflict" role="alert">
          <p>{t.conflict}</p>
          <div className="routing-form-actions">
            <button type="button" className="secondary-button" onClick={() => setReload((n) => n + 1)}><RefreshCw size={14} /> {t.reload}</button>
          </div>
        </div>
      )}
      {view && (
        <div className="settings-group">
          {templates.length === 0 && <div className="settings-row"><p className="settings-row-help">{t.none}</p></div>}
          {templates.map((tp) => (
            <div className="settings-row routing-template" key={tp.id} data-template={tp.id}>
              <Bot size={16} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main">
                <span className="settings-row-title">{tp.label}</span>
                <p className="settings-row-help">{fixed[tp.id] ? t.fixedSub(fixedWhat(tp)) : t.followSub}</p>
              </div>
              <div className="settings-row-action">
                <span className="routing-seg" role="group" aria-label={t.modeOf(tp.label)}>
                  <button type="button" aria-pressed={!fixed[tp.id]} onClick={() => setFixed((f) => ({ ...f, [tp.id]: false }))}>{t.follow}</button>
                  <button type="button" aria-pressed={!!fixed[tp.id]} onClick={() => setFixed((f) => ({ ...f, [tp.id]: true }))}>{t.fixed}</button>
                </span>
              </div>
            </div>
          ))}
          <div className="settings-row routing-template is-general">
            <Bot size={16} className="settings-row-icon" aria-hidden="true" />
            <div className="settings-row-main">
              <span className="settings-row-title">{t.general}</span>
              <p className="settings-row-help">{t.generalSub}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

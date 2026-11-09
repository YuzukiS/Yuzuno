import { useEffect, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";
import { errorText } from "./api";
import {
  keepsLevel, readExecutorTemplates, saveExecutorTemplates, type ExecutorHarness, type ExecutorTemplate, type ExecutorTemplatesView,
} from "./executor-templates";
import { strings, useLanguage } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";

/** A template as kept, with what a later Core added. */
type Kept = ExecutorTemplate & { [field: string]: unknown };
const harnessName: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const HARNESSES: ExecutorHarness[] = ["claude", "codex", "opencode"];

const text = strings({
  title: "Templates",
  help: "A template that follows routing starts its executors by the order above, with its permission level on whichever tool that gives. Turned off, a template is fixed: it starts with its own tool and model on the host's login, as before routing.",
  follow: "Routing by rules",
  fixed: "Fixed",
  followSub: "By the order above",
  fixedSub: (what: string) => `Fixed: ${what}`,
  hostDefault: "the defaults for new Agents",
  general: "General executor (no template)",
  generalSub: "Always follows routing",
  modeOf: (label: string) => `${label}: routing by rules`,
  fixedTo: (label: string) => `${label}: fixed to`,
  levelNotKept: (name: string) => `${name} doesn't keep this template's permission level: choose another tool, or change the level in the template.`,
  none: "No template yet.",
  reading: "Reading templates…",
  conflict: "The templates were changed elsewhere since this page read them. Nothing was saved here.",
  reload: "Read them again",
}, {
  title: "模板",
  help: "跟随路由的模板按上面的顺序启动执行者，在选中的运行环境上用它的权限等级。关掉开关，模板就固定：用它自己的工具、模型和主机的登录启动，和有路由之前一样。",
  follow: "按规则路由",
  fixed: "固定",
  followSub: "按上面的顺序选",
  fixedSub: (what) => `固定：${what}`,
  hostDefault: "新 Agent 的默认",
  general: "通用执行者（不带模板）",
  generalSub: "总是跟随路由",
  modeOf: (label) => `${label}：按规则路由`,
  fixedTo: (label) => `${label}：固定为`,
  levelNotKept: (name) => `${name} 不支持这个模板的权限等级：换一个运行环境，或者在模板里改权限等级。`,
  none: "还没有模板。",
  reading: "正在读取模板…",
  conflict: "模板在别处被改过了，这里没有保存任何东西。",
  reload: "重新读取",
});

/** Settings → Executor routing → Templates (YN-49 S4b, YN-56): each template
 * follows routing (the switch on) or is fixed (off) to a tool. Turning it off
 * offers the default tool for new Agents, the Workspace's, to change before
 * saving; a fixed template's tool and model are set in the template too.
 * Saved through the page's save bar as the whole template list, as read but
 * for its routing and tool, against its version; a list changed elsewhere
 * meanwhile is not overwritten. */
export function RoutingTemplates({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<ExecutorTemplatesView | null>(null);
  // Each template's tool when fixed; null when it follows routing.
  const [fixed, setFixed] = useState<Record<string, ExecutorHarness | null>>({});
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const templates = (view?.workspace.templates ?? []) as Kept[];
  const savedOf = (tp: Kept): ExecutorHarness | null => (tp.routing === "fixed" && tp.harness ? tp.harness : null);
  const adopt = (next: ExecutorTemplatesView) => {
    setView(next);
    setFixed(Object.fromEntries((next.workspace.templates as Kept[]).map((tp) => [tp.id, savedOf(tp)])));
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
  // The tool a template turned off is fixed to at first: the Workspace's default for new Agents.
  const general = view?.general?.harness;
  const firstTool: ExecutorHarness = general === "claude" || general === "codex" || (general === "opencode" && view?.opencodeEnabled) ? general : "codex";
  const levels = view?.levels ?? [];
  const refused = (tp: Kept) => {
    const tool = fixed[tp.id];
    return !!tool && !!tp.permissionLevel && !keepsLevel(levels, tp.permissionLevel, tool);
  };
  const changed = templates.some((tp) => (fixed[tp.id] ?? null) !== savedOf(tp));
  /** The template as read, following routing or fixed to its tool. Its model, effort and Codex
   * configuration stay only while it stays fixed to the tool it was saved with. */
  const templateOf = (tp: Kept): ExecutorTemplate => {
    const { routing: _routing, harness: _harness, model, reasoningEffort, permissionPreset, ...rest } = tp;
    const tool = fixed[tp.id];
    if (!tool) return rest as ExecutorTemplate;
    const same = tool === savedOf(tp);
    return {
      ...rest, harness: tool, routing: "fixed",
      ...(same && model ? { model } : {}),
      ...(same && reasoningEffort ? { reasoningEffort } : {}),
      ...(same && permissionPreset ? { permissionPreset } : {}),
    } as ExecutorTemplate;
  };
  async function save(): Promise<boolean> {
    if (!view) return false;
    try {
      adopt(await saveExecutorTemplates(view.workspace.version, templates.map(templateOf)));
      return true;
    } catch (e) {
      const words = errorText(e);
      if (words.startsWith("version_conflict")) setConflict(true); else setError(words);
      return false;
    }
  }
  useSaveBarPart("routing-templates", changed && view
    ? { ready: !conflict && !templates.some(refused), save, discard: () => { if (view) adopt(view); } } : null);

  const fixedWhat = (tp: Kept, tool: ExecutorHarness) =>
    [harnessName[tool] ?? tool, (tool === savedOf(tp) && tp.model) || t.hostDefault].join(" · ");
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
          {templates.map((tp) => {
            const tool = fixed[tp.id] ?? null;
            return (
              <div className="settings-row routing-template" key={tp.id} data-template={tp.id}>
                <Bot size={16} className="settings-row-icon" aria-hidden="true" />
                <div className="settings-row-main">
                  <span className="settings-row-title">{tp.label}</span>
                  <p className="settings-row-help">{tool ? t.fixedSub(fixedWhat(tp, tool)) : t.followSub}</p>
                  {refused(tp) && tool && <p className="inline-error">{t.levelNotKept(harnessName[tool])}</p>}
                </div>
                <div className="settings-row-action routing-template-action">
                  {tool && (
                    <select className="settings-select" aria-label={t.fixedTo(tp.label)} value={tool}
                      onChange={(e) => setFixed((f) => ({ ...f, [tp.id]: e.target.value as ExecutorHarness }))}>
                      {HARNESSES.filter((h) => h !== "opencode" || view.opencodeEnabled || tool === "opencode").map((h) => (
                        <option key={h} value={h}>{harnessName[h]}</option>
                      ))}
                    </select>
                  )}
                  <label className="routing-head-switch">
                    <input type="checkbox" role="switch" className="settings-toggle" aria-label={t.modeOf(tp.label)} checked={!tool}
                      onChange={(e) => setFixed((f) => ({ ...f, [tp.id]: e.target.checked ? null : savedOf(tp) ?? firstTool }))} />
                    {tool ? t.fixed : t.follow}
                  </label>
                </div>
              </div>
            );
          })}
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

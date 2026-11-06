import { useEffect, useState } from "react";
import { Crown, LoaderCircle } from "lucide-react";
import { api, errorText } from "./api";
import { strings, useStrings } from "./i18n";
import type { Agent } from "./types";
import "./project-leads.css";

/** A Project's leads as Core keeps them (`/api/projects/{id}/leads`, T-33). */
export interface ProjectLeadsValue {
  version: number;
  leadAgentIds: string[];
}

const text = strings({
  leads: "Leads",
  intro: "Leads answer for this Project's tasks. Later, a lead can have Core start an Agent for a task from a template; for now this only marks them. Only you set this.",
  loading: "Loading leads…",
  members: "Leads of this Project",
  none: "No lead. The Project works as before.",
  some: (n: number) => `${n} ${n === 1 ? "lead" : "leads"} selected.`,
  unavailable: "Unavailable member",
  save: "Save leads",
  unsaved: "Unsaved changes",
  reload: "Reload saved leads",
}, {
  leads: "负责人",
  intro: "负责人对此 Project 的任务负责。之后，负责人可以让 Core 按模板为任务启动 Agent；目前只作标记。只有你能设置。",
  loading: "正在读取负责人…",
  members: "此 Project 的负责人",
  none: "没有负责人。Project 照常工作。",
  some: (n) => `已选择 ${n} 位负责人。`,
  unavailable: "无法选择的成员",
  save: "保存负责人",
  unsaved: "有未保存的更改",
  reload: "重新读取已保存的负责人",
});

/** The answer as this component reads it: a list, even from an answer without one. */
const leadsOf = (value: Partial<ProjectLeadsValue>): ProjectLeadsValue => ({
  version: typeof value.version === "number" ? value.version : 0,
  leadAgentIds: Array.isArray(value.leadAgentIds) ? value.leadAgentIds : [],
});

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** The user's setting only: no Agent tool sets leads. Open members that are
 * not executors can be chosen; a saved lead that no longer can is shown so
 * it can be removed. */
export function ProjectLeads({ projectId, agents, disabled, onChanged }: {
  projectId: string;
  agents: Agent[];
  disabled: boolean;
  onChanged: () => void;
}) {
  const t = useStrings(text);
  const [saved, setSaved] = useState<ProjectLeadsValue | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const path = `/projects/${encodeURIComponent(projectId)}/leads`;
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    setError("");
    api<ProjectLeadsValue>(path, { signal: controller.signal }).then(answer => {
      const value = leadsOf(answer);
      if (!controller.signal.aborted) { setSaved(value); setIds(value.leadAgentIds); }
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [path, reload]);
  const members = agents.filter(a => a.projectId === projectId && !a.closedAt && a.kind !== "executor");
  const unavailable = ids.filter(id => !members.some(a => a.id === id));
  const changed = !!saved && !same(saved.leadAgentIds, ids);
  async function save() {
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      const next = leadsOf(await api<ProjectLeadsValue>(path, { method: "PUT", body: JSON.stringify({
        expectedVersion: saved.version, leadAgentIds: ids,
      }) }));
      setSaved(next);
      setIds(next.leadAgentIds);
      onChanged();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <section className="project-leads" aria-label={t.leads}>
    <h3><Crown size={15} /> {t.leads}</h3>
    <p>{t.intro}</p>
    {!saved ? <p role="status">{error || t.loading}</p> : <>
      <div className="project-leads-members" role="group" aria-label={t.members}>
        {members.map(agent => <label key={agent.id}>
          <input type="checkbox" checked={ids.includes(agent.id)} disabled={disabled || busy}
            onChange={e => setIds(e.target.checked ? [...ids, agent.id] : ids.filter(id => id !== agent.id))} />
          <span>{agent.name}</span>
        </label>)}
        {unavailable.map(id => <label key={id}>
          <input type="checkbox" checked disabled={disabled || busy} onChange={() => setIds(ids.filter(value => value !== id))} />
          <span>{t.unavailable} <small>{agents.find(a => a.id === id)?.name ?? id}</small></span>
        </label>)}
      </div>
      <p className="project-leads-hint">{ids.length === 0 ? t.none : t.some(ids.length)}</p>
      <div className="project-leads-actions">
        <button type="button" className="secondary-button" disabled={disabled || busy || !changed} onClick={() => void save()}>
          {busy && <LoaderCircle size={13} className="spin" />} {t.save}
        </button>
        {changed && <span className="project-leads-hint">{t.unsaved}</span>}
      </div>
    </>}
    {saved && error && <p className="inline-error" role="alert">{error}</p>}
    {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reload}</button>}
  </section>;
}

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { api, errorText, post } from "./api";
import { Avatar } from "./components";
import { strings, useStrings } from "./i18n";
import { projectName } from "./projects";
import { useSaveBarPart } from "./SettingsSaveBar";
import type { Agent, Project } from "./types";
import "./project-leads.css";

/** A Project's leads as Core keeps them (`/api/projects/{id}/leads`, T-33). */
export interface ProjectLeadsValue {
  version: number;
  leadAgentIds: string[];
}

const text = strings({
  members: "Agents",
  intro: "Leads answer for this Project's tasks: they dispatch executors, edit Home and write the handover. Other Agents can only ask. An Agent you create in this Project or add to it leads it; you never have to set one, and you can remove a lead here. Executors never lead.",
  loading: "Loading leads…",
  lead: "Lead",
  executor: "Executor",
  closed: " · closed",
  gone: "No longer in this Project",
  none: "No lead: every Agent here can only ask on Home.",
  some: (n: number) => `${n} ${n === 1 ? "lead" : "leads"} selected.`,
  save: "Save leads",
  reload: "Reload saved leads",
  noAgents: "No agents yet.",
  coreHost: "Core host",
  removeFrom: (agent: string, project: string) => `Remove ${agent} from ${project}`,
  removeTip: "Remove from project",
  agentToAdd: "Agent to add",
  addAgent: "Add an agent…",
  fromProject: (project: string) => ` · from ${project}`,
  add: "Add",
  moveNote: "Moving an agent changes only where it is listed. Its folder, conversation and read state stay the same.",
}, {
  members: "Agent",
  intro: "负责人为这个 Project 的任务负责：派发执行者、编辑 Home、写交接文档。其他 Agent 只能提问。你在这个 Project 里新建或加入的 Agent 就是负责人；你不必设置，也可以在这里移除负责人。执行者不会成为负责人。",
  loading: "正在读取负责人…",
  lead: "负责人",
  executor: "执行者",
  closed: " · 已关闭",
  gone: "已不在此 Project 中",
  none: "没有负责人：这里的每个 Agent 在 Home 上都只能提问。",
  some: (n) => `已选择 ${n} 位负责人。`,
  save: "保存负责人",
  reload: "重新读取已保存的负责人",
  noAgents: "还没有 Agent。",
  coreHost: "Core 主机",
  removeFrom: (agent, project) => `将 ${agent} 移出 ${project}`,
  removeTip: "移出项目",
  agentToAdd: "要添加的 Agent",
  addAgent: "添加 Agent…",
  fromProject: (project) => ` · 来自 ${project}`,
  add: "添加",
  moveNote: "移动 Agent 只改变它列在哪里。它的文件夹、会话和已读状态保持不变。",
});

/** The answer as this component reads it: a list, even from an answer without one. */
const leadsOf = (value: Partial<ProjectLeadsValue>): ProjectLeadsValue => ({
  version: typeof value.version === "number" ? value.version : 0,
  leadAgentIds: Array.isArray(value.leadAgentIds) ? value.leadAgentIds : [],
});

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** A Project's members and leads in one block (YN-8): each Agent here with a
 * Lead switch (T-33; executors are marked and never lead), Add and Remove.
 * Moving an Agent is done at once; the leads are the user's setting (no
 * Agent tool sets them) and are saved with the page's save bar, against the
 * version read. Core makes an Agent added here a lead, so the leads are read
 * again when the members change, a lead change not yet saved kept on top. A
 * saved lead that can no longer lead is shown so it can be removed. */
export function ProjectMembers({ project, agents, projects, disabled, onChanged }: {
  project: Project;
  agents: Agent[];
  projects: Project[];
  disabled: boolean;
  onChanged: () => void;
}) {
  const t = useStrings(text);
  const projectId = project.id;
  const [saved, setSaved] = useState<ProjectLeadsValue | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveError, setMoveError] = useState("");
  const [adding, setAdding] = useState("");
  const members = agents.filter((agent) => agent.projectId === projectId);
  const others = agents.filter((agent) => agent.projectId !== projectId);
  const roster = members.map((agent) => agent.id).sort().join("\n");
  // The lead changes not yet saved, to keep on a list read again.
  const pending = useRef({ add: [] as string[], drop: [] as string[] });
  pending.current = saved
    ? { add: ids.filter((id) => !saved.leadAgentIds.includes(id)), drop: saved.leadAgentIds.filter((id) => !ids.includes(id)) }
    : { add: [], drop: [] };
  const path = `/projects/${encodeURIComponent(projectId)}/leads`;
  useEffect(() => {
    const controller = new AbortController();
    api<ProjectLeadsValue>(path, { signal: controller.signal }).then((answer) => {
      if (controller.signal.aborted) return;
      const value = leadsOf(answer);
      const { add, drop } = pending.current;
      setError("");
      setSaved(value);
      setIds([...new Set([...value.leadAgentIds.filter((id) => !drop.includes(id)), ...add])]);
    }).catch((e) => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [path, reload, roster]);
  const gone = ids.filter((id) => !members.some((agent) => agent.id === id));
  const changed = !!saved && !same(saved.leadAgentIds, ids);
  async function save(): Promise<boolean> {
    if (!saved) return true;
    setSaving(true);
    setError("");
    try {
      const next = leadsOf(await api<ProjectLeadsValue>(path, { method: "PUT", body: JSON.stringify({
        expectedVersion: saved.version, leadAgentIds: ids,
      }) }));
      setSaved(next);
      setIds(next.leadAgentIds);
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  }
  // An archived project's leads don't change: a change left from before is not sent (#722 R1 note).
  const inBar = useSaveBarPart(`leads:${projectId}`, changed && saved && !disabled
    ? { save, discard: () => { setError(""); setIds(saved.leadAgentIds); } }
    : null);
  async function move(agent: Agent, to: string | null) {
    if (moving) return;
    setMoving(agent.id);
    setMoveError("");
    try {
      await post(`/agents/${encodeURIComponent(agent.id)}/project`, { projectId: to });
      onChanged();
      if (to) setAdding("");
    } catch (e) {
      setMoveError(errorText(e));
    } finally {
      setMoving(null);
    }
  }
  const locked = disabled || saving || !saved;
  const leadSwitch = (id: string, name: string, can: boolean) => {
    const on = ids.includes(id);
    return (
      <span className="project-member-lead">
        <span aria-hidden="true">{t.lead}</span>
        <button
          type="button"
          role="switch"
          className="settings-switch"
          aria-checked={on}
          aria-label={`${t.lead} · ${name}`}
          // One that can't lead can only be turned off.
          disabled={locked || (!can && !on)}
          onClick={() => setIds(on ? ids.filter((value) => value !== id) : [...ids, id])}
        />
      </span>
    );
  };
  return (
    <fieldset className="appearance-field project-form project-leads">
      <legend>
        {t.members} <span className="project-count">{members.length}</span>
      </legend>
      <p className="appearance-help">{t.intro}</p>
      {members.length || gone.length ? (
        <ul className="project-members project-leads-members">
          {members.map((agent) => {
            const executor = agent.kind === "executor";
            const can = !executor && !agent.closedAt;
            return (
              <li key={agent.id}>
                <Avatar agent={agent} small />
                <span className="project-member-text">
                  <strong>
                    {agent.name}
                    {agent.closedAt ? t.closed : ""}
                  </strong>
                  <small title={agent.cwd}>
                    {agent.remote?.machine.name || t.coreHost} · {agent.cwd}
                  </small>
                </span>
                {executor ? (
                  <span className="settings-tag">{t.executor}</span>
                ) : (can || ids.includes(agent.id)) && saved ? (
                  leadSwitch(agent.id, agent.name, can)
                ) : null}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t.removeFrom(agent.name, project.name)}
                  title={t.removeTip}
                  disabled={!!moving}
                  onClick={() => void move(agent, null)}
                >
                  {moving === agent.id ? <LoaderCircle size={14} className="spin" /> : <X size={14} />}
                </button>
              </li>
            );
          })}
          {gone.map((id) => {
            const name = agents.find((agent) => agent.id === id)?.name ?? id;
            return (
              <li key={id} className="is-gone">
                <span className="project-member-text">
                  <strong>{name}</strong>
                  <small>{t.gone}</small>
                </span>
                {leadSwitch(id, name, false)}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="project-note">{t.noAgents}</p>
      )}
      {!saved ? (
        <p className="project-leads-hint" role="status">{error || t.loading}</p>
      ) : (
        <p className="project-leads-hint">{ids.length === 0 ? t.none : t.some(ids.length)}</p>
      )}
      {saved && error && <p className="inline-error" role="alert">{error}</p>}
      {(error || (!inBar && changed)) && (
        <div className="project-leads-actions">
          {!inBar && changed && (
            <button type="button" className="secondary-button" disabled={locked} onClick={() => void save()}>
              {saving && <LoaderCircle size={13} className="spin" />} {t.save}
            </button>
          )}
          {error && (
            <button type="button" className="quiet-button" disabled={saving} onClick={() => setReload((n) => n + 1)}>
              {t.reload}
            </button>
          )}
        </div>
      )}
      {!disabled && others.length > 0 && (
        <form
          className="project-add-agent"
          onSubmit={(event) => {
            event.preventDefault();
            const agent = others.find((candidate) => candidate.id === adding);
            if (agent) void move(agent, projectId);
          }}
        >
          <select aria-label={t.agentToAdd} value={adding} onChange={(event) => setAdding(event.target.value)}>
            <option value="">{t.addAgent}</option>
            {others.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.projectId ? t.fromProject(projectName(agent.projectId, projects)) : ""}
                {agent.closedAt ? t.closed : ""}
              </option>
            ))}
          </select>
          <button className="secondary-button" disabled={!adding || !!moving}>
            {t.add}
          </button>
        </form>
      )}
      {moveError && <p className="inline-error" role="alert">{moveError}</p>}
      <p className="project-note">{t.moveNote}</p>
    </fieldset>
  );
}

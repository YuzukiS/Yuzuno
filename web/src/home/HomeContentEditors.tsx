import { useEffect, useState } from "react";
import { LoaderCircle, Users } from "lucide-react";
import { api, errorText } from "../api";
import { useStrings } from "../i18n";
import type { Agent } from "../types";
import { homeText } from "./home-text";
import type { ContentEditors } from "./types";
import "./home-editors.css";

/** User-owned project setting. Agent tools expose capabilities, never this setter. */
export function HomeContentEditors({ projectId, agents, disabled, onChanged }: {
  projectId: string;
  agents: Agent[];
  disabled: boolean;
  onChanged: () => void;
}) {
  const t = useStrings(homeText);
  const [saved, setSaved] = useState<ContentEditors | null>(null);
  const [ids, setIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const path = `/projects/${encodeURIComponent(projectId)}/home-editors`;
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    setError("");
    api<ContentEditors>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setSaved(value); setIds(value.editorAgentIds); }
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [path, reload]);
  const members = agents.filter(a => a.projectId === projectId && !a.closedAt);
  const unavailable = ids?.filter(id => !members.some(a => a.id === id)) ?? [];
  const changed = saved && JSON.stringify(saved.editorAgentIds) !== JSON.stringify(ids);
  async function save() {
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<ContentEditors>(path, { method: "PUT", body: JSON.stringify({
        expectedVersion: saved.version, editorAgentIds: ids,
      }) });
      setSaved(next);
      setIds(next.editorAgentIds);
      onChanged();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <section className="home-editor-settings" aria-label={t.editors}>
    <h3><Users size={15} /> {t.editors}</h3>
    <p>{t.editorsIntro}</p>
    {!saved ? <p role="status">{error || t.loadingEditors}</p> : <>
      <label className="home-editor-mode">
        <input type="checkbox" checked={ids === null} disabled={disabled || busy}
          onChange={e => setIds(e.target.checked ? null : members.map(a => a.id))} />
        <span>{t.allMembers}</span>
      </label>
      {ids !== null && <>
        <div className="home-editor-members" role="group" aria-label={t.selectedEditors}>
          {members.map(agent => <label key={agent.id}>
            <input type="checkbox" checked={ids.includes(agent.id)} disabled={disabled || busy}
              onChange={e => setIds(e.target.checked ? [...ids, agent.id] : ids.filter(id => id !== agent.id))} />
            <span>{agent.name}</span>
          </label>)}
          {unavailable.map(id => <label key={id}>
            <input type="checkbox" checked disabled={disabled || busy} onChange={() => setIds(ids.filter(value => value !== id))} />
            <span>{t.unavailableMember} <small>{id}</small></span>
          </label>)}
        </div>
        <p className="home-editor-hint">{ids.length === 0 ? t.noEditors : t.onlyEditors}</p>
      </>}
      <div className="home-editor-actions">
        <button type="button" className="secondary-button" disabled={disabled || busy || !changed} onClick={() => void save()}>
          {busy && <LoaderCircle size={13} className="spin" />} {t.saveEditors}
        </button>
        {changed && <span className="home-editor-hint">{t.unsavedChanges}</span>}
      </div>
    </>}
    {saved && error && <p className="inline-error" role="alert">{error}</p>}
    {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reloadEditors}</button>}
  </section>;
}

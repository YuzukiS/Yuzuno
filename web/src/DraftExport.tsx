import { useEffect, useRef, useState } from "react";
import { Download, Eye } from "lucide-react";
import { draftFileName, exportDraft, listDrafts, type DraftListing, type DraftRow } from "./draft-export";
import "./diagnostics.css";
import "./draft-export.css";

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type Shown = { agentId: string; name: string } & ({ text: string } | { error: string });

/**
 * Settings → Draft storage (T-193): the drafts this browser keeps for the
 * Agent IDs this Workspace lists (a draft records no Workspace). One is opened
 * only when chosen, shown whole, and saved as a text file only when asked.
 * Nothing here changes, sends or clears a draft.
 */
export function DraftExport({ active, agents }: { active: boolean; agents: { id: string; name: string; closedAt?: string | null }[] | null }) {
  const [listing, setListing] = useState<DraftListing | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [save, setSave] = useState<{ state: "saving"; name: string } | { state: "notSaved"; why: string } | null>(null);

  // Read again when shown and when the Workspace's Agents change, not on every
  // render: the list may be a new array each time. Shown again, it starts
  // afresh; when only the Agents change, an open draft stays while its Agent
  // is still listed.
  const latest = useRef(agents);
  latest.current = agents;
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const wasActive = useRef(false);
  const agentsKey = agents?.map((agent) => `${agent.id}\u0000${agent.name}\u0000${agent.closedAt ?? ""}`).join("\u0001") ?? null;
  useEffect(() => {
    const listed = latest.current;
    if (!active || !listed) {
      wasActive.current = active;
      return;
    }
    setListing(listDrafts(readStorage(), listed));
    const open = shownNow.current;
    if (!wasActive.current || !open || !listed.some((agent) => agent.id === open.agentId)) {
      setShown(null);
      setSave(null);
    }
    wasActive.current = true;
  }, [active, agentsKey]);

  function open(row: DraftRow) {
    const storage = readStorage();
    setSave(null);
    if (!storage) return setShown({ agentId: row.agentId, name: row.name, error: "this browser gives Yuzuno no storage here" });
    setShown({ agentId: row.agentId, name: row.name, ...exportDraft(storage, row.agentId, row.name) });
  }

  function download() {
    if (!shown || !("text" in shown)) return;
    const name = draftFileName(shown.name);
    try {
      const url = URL.createObjectURL(new Blob([shown.text], { type: "text/plain;charset=utf-8" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      // The page can ask for a download; whether the file was saved is the browser's to say.
      setSave({ state: "saving", name });
    } catch (error) {
      setSave({ state: "notSaved", why: error instanceof Error && error.message ? error.message : String(error) });
    }
  }

  return (
    <section id="settings-drafts" className="settings-section draft-export" aria-labelledby="settings-drafts-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-drafts-title">Drafts on this device</h3>
          <p>
            Drafts saved in this browser for this site, shown for the Agents this Workspace lists. A draft is saved under
            its Agent's ID only: which Workspace it was written in is not recorded, so a matching Agent doesn't prove it.
            Choose one to see it whole, then save it as a text file. These are the copies saved on this device: text typed
            in an open conversation since it was last saved is not in them. Nothing here sends, changes or clears a draft.
          </p>
        </div>
      </header>
      {!agents && <p className="diagnostics-note">Connect to your Workspace to see which of its Agents have drafts here.</p>}
      {listing && !listing.available && (
        <p className="updates-error" role="alert">
          Drafts can't be read: {listing.reason}.
        </p>
      )}
      {listing?.available && (
        <>
          {listing.rows.length === 0 && <p className="diagnostics-note">No saved draft on this device matches an Agent this Workspace lists.</p>}
          <ul className="draft-export-rows">
            {listing.rows.map((row) => (
              <li key={row.agentId} data-agent={row.agentId}>
                <span className="draft-export-name">
                  {row.name}
                  {row.closed ? " (closed)" : ""}
                </span>
                <span className="draft-export-detail">{describe(row)}</span>
                {row.summary.state !== "damaged" && (
                  <button type="button" className="secondary-button" onClick={() => open(row)} aria-label={`Show the draft for ${row.name}`}>
                    <Eye size={14} aria-hidden="true" /> Show
                  </button>
                )}
              </li>
            ))}
          </ul>
          {listing.otherAgents > 0 && (
            <p className="diagnostics-note">
              {listing.otherAgents} saved {listing.otherAgents === 1 ? "draft is" : "drafts are"} for Agent IDs this
              Workspace doesn't list, so {listing.otherAgents === 1 ? "it is" : "they are"} not shown here.
            </p>
          )}
        </>
      )}
      {shown && "error" in shown && (
        <p className="updates-error" role="alert">
          The draft for {shown.name} can't be read ({shown.error}). It is left as it is.
        </p>
      )}
      {shown && "text" in shown && (
        <div className="draft-export-shown">
          <p className="diagnostics-note" role="status">
            {save?.state === "saving"
              ? `Your browser was asked to save ${save.name}. If no file appears, select the text below and copy it.`
              : `The whole saved draft for ${shown.name}. Nothing has been saved, copied or sent.`}
          </p>
          {save?.state === "notSaved" && (
            <p className="updates-error" role="alert">
              The download could not start ({save.why}). Select the text below and copy it.
            </p>
          )}
          <textarea
            className="diagnostics-text"
            aria-label={`Saved draft for ${shown.name}`}
            readOnly
            rows={10}
            value={shown.text}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="secondary-button" onClick={download}>
            <Download size={14} aria-hidden="true" /> Download .txt
          </button>
        </div>
      )}
    </section>
  );
}

function describe(row: DraftRow): string {
  const summary = row.summary;
  if (summary.state === "damaged") return `Can't be read (${summary.reason}); left as it is.`;
  const parts = [`${summary.textChars} ${summary.textChars === 1 ? "character" : "characters"} of text`];
  if (summary.pastes) parts.push(`${summary.pastes} pasted ${summary.pastes === 1 ? "text" : "texts"}`);
  if (summary.images) parts.push(`${summary.images} ${summary.images === 1 ? "image" : "images"} (referenced; not saved in the file)`);
  if (summary.skills) parts.push(`${summary.skills} ${summary.skills === 1 ? "skill" : "skills"}`);
  return `${summary.state === "legacy" ? "Saved by an earlier version: " : ""}${parts.join(", ")}`;
}

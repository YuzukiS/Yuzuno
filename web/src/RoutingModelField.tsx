/** A routing candidate's model (YN-57 S2b): chosen from what its tool lists,
 * as the account or key beside it is, with 「Other (type it)」 for anything the
 * list lacks. Under it, where the list comes from, or why it couldn't be read
 * (then Yuzuno's short list stands in). */
import { useEffect, useRef, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { errorText } from "./api";
import { MODEL_HINTS, type Candidate } from "./executor-routing";
import { harnessName, type Text } from "./executor-routing-text";
import { keyNeeded, modelGroups, readModels, type Catalog, type GroupWords, type ModelGroup } from "./routing-models";

/** The select's value for 「Other (type it)」: none a model can have, since a model has no spaces. */
const OTHER = " other";

export function ModelField({ c, t, keyProvider, onChange }: {
  c: Candidate; t: Text;
  /** The provider of the candidate's API key, if it has one. */
  keyProvider: string | null;
  onChange: (model: string) => void;
}) {
  const [read, setRead] = useState<{ harness: Candidate["harness"]; catalog?: Catalog; error?: string } | null>(null);
  const [again, setAgain] = useState(0);
  const fresh = useRef(false);
  const [other, setOther] = useState(false);
  useEffect(() => {
    let live = true;
    const harness = c.harness;
    readModels(harness, fresh.current).then((catalog) => { if (live) setRead({ harness, catalog }); })
      .catch((error) => { if (live) setRead({ harness, error: errorText(error) }); });
    fresh.current = false;
    return () => { live = false; };
  }, [c.harness, again]);
  useEffect(() => setOther(false), [c.harness]);

  const tool = harnessName[c.harness];
  const now = read?.harness === c.harness ? read : null;
  const words: GroupWords = { aliases: t.groupAliases, pinned: t.groupPinned, codex: t.groupCodex, withKey: t.groupWithKey,
    needsKey: t.groupNeedsKey, env: t.groupEnv, ready: t.groupReady, loggedIn: t.groupLoggedIn };
  const groups: ModelGroup[] = now?.catalog ? modelGroups(c.harness, now.catalog, words, keyProvider)
    : now?.error ? [{ label: t.groupShortList, options: MODEL_HINTS[c.harness].map((value) => ({ value, label: value })) }] : [];
  const listed = new Set(groups.flatMap((g) => g.options.map((o) => o.value)));
  const model = c.model ?? "";
  // A saved model the list lacks stays chosen, and says so once the list is read.
  const kept = model && !listed.has(model) ? { value: model, label: now?.catalog ? t.modelNotListed(model) : model } : null;
  const needs = now?.catalog ? keyNeeded(now.catalog, model, keyProvider) : null;
  const reread = () => { fresh.current = true; setRead(null); setAgain((n) => n + 1); };
  const rereadButton = <button type="button" className="quiet-button routing-model-reread" onClick={reread}><RefreshCw size={12} aria-hidden="true" /> {t.modelReread}</button>;
  return (
    <div className="routing-field routing-field-wide routing-model">
      <span>{t.model}</span>
      <select className="settings-select" aria-label={t.model} value={other ? OTHER : model}
        onChange={(e) => { if (e.target.value === OTHER) setOther(true); else { setOther(false); onChange(e.target.value); } }}>
        <option value="">{t.modelPlaceholder}</option>
        {kept && <option value={kept.value}>{kept.label}</option>}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        ))}
        <option value={OTHER}>{t.modelOther}</option>
      </select>
      {other && (
        <input className="settings-input routing-model-other" value={model} spellCheck={false} aria-label={t.modelTyped} autoFocus
          placeholder={c.harness === "opencode" ? "provider/model" : t.modelPlaceholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {!now ? <p className="routing-model-note" role="status">{t.modelReading(tool)}</p>
        : now.error ? <p className="routing-model-note is-warn"><CircleAlert size={12} className="routing-icon" aria-hidden="true" /> {t.modelUnreadable(tool, now.error)} {rereadButton}</p>
          : <p className="routing-model-note">{c.harness === "claude" ? t.modelFromClaude : c.harness === "codex" ? t.modelFromCodex
            : t.modelFromOpencode(now.catalog?.opencode?.version ?? "")} {rereadButton}</p>}
      {needs && <p className="routing-model-note is-warn"><CircleAlert size={12} className="routing-icon" aria-hidden="true" /> {t.modelNeedsKey(needs)}</p>}
      {other && now?.catalog && model && !listed.has(model) && <p className="routing-model-note is-warn">{t.modelNotListedNote(tool)}</p>}
    </div>
  );
}

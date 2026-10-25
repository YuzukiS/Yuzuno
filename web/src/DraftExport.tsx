import { useEffect, useRef, useState } from "react";
import { Download, Eye } from "lucide-react";
import { draftFileName, draftsFileName, exportDraft, exportDrafts, listDrafts, type DraftListing, type DraftProblem, type DraftRow, type DraftsFailure } from "./draft-export";
import { strings, useStrings } from "./i18n";
import "./diagnostics.css";
import "./draft-export.css";

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type Shown = { agentId: string; name: string } & ({ text: string } | { why: DraftProblem });
type Many = { state: "saving"; name: string; count: number } | { state: "failed"; failed: DraftsFailure[]; of: number } | { state: "notSaved"; why: DraftProblem };

// Drafts, their names, the files saved and what they hold are as written;
// the browser's own words are too.
const words = strings({
  title: "Drafts on this device",
  intro:
    "Drafts saved in this browser for this site, shown for the Agents this Workspace lists. A draft is saved under its Agent's ID only: which Workspace it was written in is not recorded, so a matching Agent doesn't prove it. Choose one to see it whole, then save it as a text file, or tick several to save them together as one file. These are the copies saved on this device: text typed in an open conversation since it was last saved is not in them. Nothing here sends, changes or clears a draft.",
  connect: "Connect to your Workspace to see which of its Agents have drafts here.",
  unlisted: (why: string) => `Drafts can't be read: ${why}.`,
  noMatch: "No saved draft on this device matches an Agent this Workspace lists.",
  choose: (name: string) => `Choose the draft for ${name}`,
  closed: " (closed)",
  showDraft: (name: string) => `Show the draft for ${name}`,
  show: "Show",
  downloadSelected: "Download selected (.json)",
  savingMany: (name: string, count: number) => `Your browser was asked to save ${name} (${count} ${count === 1 ? "draft" : "drafts"}). If no file appears, show each draft and copy it.`,
  noneTicked: "Tick drafts to save them together as one file (JSON), each with its Agent's ID and name. Their pasted texts are read only then.",
  ticked: (count: number) => `${count} ${count === 1 ? "draft" : "drafts"} chosen. Their pasted texts are read only when you download.`,
  failedMany: (failed: number, of: number, which: string) =>
    `Nothing was downloaded: ${failed} of ${of} chosen ${of === 1 ? "draft" : "drafts"} can't be read (${which}). Untick ${failed === 1 ? "it" : "them"} to save the rest.`,
  failedOne: (name: string, why: string) => `${name}: ${why}`,
  failedJoin: "; ",
  notStartedMany: (why: string) => `The download could not start (${why}). Show each draft and copy it.`,
  others: (count: number) =>
    `${count} saved ${count === 1 ? "draft is" : "drafts are"} for Agent IDs this Workspace doesn't list, so ${count === 1 ? "it is" : "they are"} not shown here.`,
  unopened: (name: string, why: string) => `The draft for ${name} can't be read (${why}). It is left as it is.`,
  saving: (name: string) => `Your browser was asked to save ${name}. If no file appears, select the text below and copy it.`,
  whole: (name: string) => `The whole saved draft for ${name}. Nothing has been saved, copied or sent.`,
  notStarted: (why: string) => `The download could not start (${why}). Select the text below and copy it.`,
  saved: (name: string) => `Saved draft for ${name}`,
  downloadText: "Download .txt",
  noStorage: "this browser gives Yuzuno no storage here",
  refused: (error: string) => `this browser refused to read its storage (${error})`,
  gone: "it is no longer saved here",
  damaged: (why: string) => `Can't be read (${why}); left as it is.`,
  chars: (count: number) => `${count} ${count === 1 ? "character" : "characters"} of text`,
  pastes: (count: number) => `${count} pasted ${count === 1 ? "text" : "texts"}`,
  images: (count: number) => `${count} ${count === 1 ? "image" : "images"} (referenced; not saved in the file)`,
  skills: (count: number) => `${count} ${count === 1 ? "skill" : "skills"}`,
  join: ", ",
  legacy: "Saved by an earlier version: ",
  // What a draft's own check says (composer-draft.ts), where this language has it.
  checks: {} as Partial<Record<string, string>>,
}, {
  title: "此设备上的草稿",
  intro:
    "此浏览器为此站点保存的草稿，按此 Workspace 列出的 Agent 显示。草稿只按其 Agent 的 ID 保存：不记录它是在哪个 Workspace 中写的，所以 Agent 匹配并不能证明这一点。选择一份可查看全文，再把它保存为文本文件；也可以勾选几份，一起保存为一个文件。这些是此设备上保存的副本：在打开的会话中、上次保存之后输入的文字不在其中。此处不会发送、更改或清除任何草稿。",
  connect: "连接到你的 Workspace 后，才能看到它的哪些 Agent 在这里有草稿。",
  unlisted: (why) => `无法读取草稿：${why}。`,
  noMatch: "此设备上保存的草稿都不属于此 Workspace 列出的 Agent。",
  choose: (name) => `选择 ${name} 的草稿`,
  closed: "（已关闭）",
  showDraft: (name) => `显示 ${name} 的草稿`,
  show: "显示",
  downloadSelected: "下载所选（.json）",
  savingMany: (name, count) => `已请求浏览器保存 ${name}（${count} 份草稿）。如果没有出现文件，请逐份显示草稿并复制。`,
  noneTicked: "勾选草稿，可把它们一起保存为一个文件（JSON），每份都带有其 Agent 的 ID 和名称。只有到那时才会读取它们粘贴的文本。",
  ticked: (count) => `已选择 ${count} 份草稿。只有在下载时才会读取它们粘贴的文本。`,
  failedMany: (failed, of, which) => `没有下载任何内容：所选的 ${of} 份草稿中有 ${failed} 份无法读取（${which}）。取消勾选${failed === 1 ? "它" : "它们"}即可保存其余草稿。`,
  failedOne: (name, why) => `${name}：${why}`,
  failedJoin: "；",
  notStartedMany: (why) => `无法开始下载（${why}）。请逐份显示草稿并复制。`,
  others: (count) => `另有 ${count} 份已保存的草稿属于此 Workspace 未列出的 Agent ID，因此不在这里显示。`,
  unopened: (name, why) => `无法读取 ${name} 的草稿（${why}）。它保持原样。`,
  saving: (name) => `已请求浏览器保存 ${name}。如果没有出现文件，请选中下方文字并复制。`,
  whole: (name) => `${name} 已保存的完整草稿。尚未保存、复制或发送任何内容。`,
  notStarted: (why) => `无法开始下载（${why}）。请选中下方文字并复制。`,
  saved: (name) => `${name} 已保存的草稿`,
  downloadText: "下载 .txt",
  noStorage: "此浏览器在这里没有为 Yuzuno 提供存储",
  refused: (error) => `此浏览器拒绝读取其存储（${error}）`,
  gone: "它已不再保存在这里",
  damaged: (why) => `无法读取（${why}）；保持原样。`,
  chars: (count) => `文本 ${count} 个字符`,
  pastes: (count) => `粘贴的文本 ${count} 段`,
  images: (count) => `图片 ${count} 张（仅引用；不保存在文件中）`,
  skills: (count) => `技能 ${count} 个`,
  join: "，",
  legacy: "由早期版本保存：",
  checks: {
    "Invalid saved draft": "保存的草稿无效",
    "Invalid saved image references": "保存的图片引用无效",
    "Invalid saved skill references": "保存的技能引用无效",
    "Invalid pasted text reference": "粘贴文本的引用无效",
    "Saved pasted text is missing": "保存的粘贴文本已丢失",
    "Draft export only reads": "草稿导出只读取",
  },
});
type Text = ReturnType<typeof words>;
function problemText(why: DraftProblem, t: Text): string {
  if (why.kind === "noStorage") return t.noStorage;
  if (why.kind === "gone") return t.gone;
  if (why.kind === "refused") return t.refused(why.error);
  return (Object.hasOwn(t.checks, why.error) && t.checks[why.error]) || why.error;
}

/** Asks the browser to save `text` as `name`; the error that stopped it, or null. */
function saveFile(name: string, text: string, type: string): string | null {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
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
    return null;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : String(error);
  }
}

/**
 * Settings → Draft storage (T-193): the drafts this browser keeps for the
 * Agent IDs this Workspace lists (a draft records no Workspace). One is opened
 * only when chosen, shown whole, and saved as a text file only when asked;
 * several ticked are read only when saved together, as one file. Nothing
 * here changes, sends or clears a draft.
 */
export function DraftExport({ active, agents }: { active: boolean; agents: { id: string; name: string; closedAt?: string | null }[] | null }) {
  const t = useStrings(words);
  const [listing, setListing] = useState<DraftListing | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [save, setSave] = useState<{ state: "saving"; name: string } | { state: "notSaved"; why: DraftProblem } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [many, setMany] = useState<Many | null>(null);

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
    const next = listDrafts(readStorage(), listed);
    setListing(next);
    const open = shownNow.current;
    if (!wasActive.current || !open || !listed.some((agent) => agent.id === open.agentId)) {
      setShown(null);
      setSave(null);
    }
    // Shown again, nothing is ticked; otherwise only drafts still listed stay ticked.
    const again = !wasActive.current;
    const kept = new Set(next.available ? next.rows.filter((row) => row.summary.state !== "damaged").map((row) => row.agentId) : []);
    setSelected((was) => (again ? new Set() : new Set([...was].filter((id) => kept.has(id)))));
    if (again) setMany(null);
    wasActive.current = true;
  }, [active, agentsKey]);

  function open(row: DraftRow) {
    const storage = readStorage();
    setSave(null);
    if (!storage) return setShown({ agentId: row.agentId, name: row.name, why: { kind: "noStorage" } });
    setShown({ agentId: row.agentId, name: row.name, ...exportDraft(storage, row.agentId, row.name) });
  }

  function download() {
    if (!shown || !("text" in shown)) return;
    const name = draftFileName(shown.name);
    const why = saveFile(name, shown.text, "text/plain;charset=utf-8");
    // The page can ask for a download; whether the file was saved is the browser's to say.
    setSave(why === null ? { state: "saving", name } : { state: "notSaved", why: { kind: "error", error: why } });
  }

  function toggle(agentId: string) {
    setMany(null);
    setSelected((was) => {
      const next = new Set(was);
      if (!next.delete(agentId)) next.add(agentId);
      return next;
    });
  }

  /** The ticked drafts, read now, as one file; none if any can't be read. */
  function downloadSelected() {
    if (!listing?.available) return;
    const rows = listing.rows.filter((row) => selected.has(row.agentId));
    if (!rows.length) return;
    const storage = readStorage();
    if (!storage) return setMany({ state: "notSaved", why: { kind: "noStorage" } });
    const made = exportDrafts(storage, rows);
    if ("failed" in made) return setMany({ state: "failed", failed: made.failed, of: rows.length });
    const name = draftsFileName();
    const why = saveFile(name, made.text, "application/json;charset=utf-8");
    setMany(why === null ? { state: "saving", name, count: made.count } : { state: "notSaved", why: { kind: "error", error: why } });
  }

  return (
    <section id="settings-drafts" className="settings-section draft-export" aria-labelledby="settings-drafts-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-drafts-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      {!agents && <p className="diagnostics-note">{t.connect}</p>}
      {listing && !listing.available && (
        <p className="updates-error" role="alert">
          {t.unlisted(problemText(listing.why, t))}
        </p>
      )}
      {listing?.available && (
        <>
          {listing.rows.length === 0 && <p className="diagnostics-note">{t.noMatch}</p>}
          <ul className="draft-export-rows">
            {listing.rows.map((row) => (
              <li key={row.agentId} data-agent={row.agentId}>
                <span className="draft-export-name">
                  {row.summary.state !== "damaged" && (
                    <input
                      type="checkbox"
                      checked={selected.has(row.agentId)}
                      onChange={() => toggle(row.agentId)}
                      aria-label={t.choose(row.name)}
                    />
                  )}
                  {row.name}
                  {row.closed ? t.closed : ""}
                </span>
                <span className="draft-export-detail">{describe(row, t)}</span>
                {row.summary.state !== "damaged" && (
                  <button type="button" className="secondary-button" onClick={() => open(row)} aria-label={t.showDraft(row.name)}>
                    <Eye size={14} aria-hidden="true" /> {t.show}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {listing.rows.some((row) => row.summary.state !== "damaged") && (
            <div className="draft-export-many">
              <button type="button" className="secondary-button" disabled={selected.size === 0} onClick={downloadSelected}>
                <Download size={14} aria-hidden="true" /> {t.downloadSelected}
              </button>
              <p className="diagnostics-note" role="status">
                {many?.state === "saving" ? t.savingMany(many.name, many.count) : selected.size === 0 ? t.noneTicked : t.ticked(selected.size)}
              </p>
              {many?.state === "failed" && (
                <p className="updates-error" role="alert">
                  {t.failedMany(many.failed.length, many.of, many.failed.map((f) => t.failedOne(f.name, problemText(f.why, t))).join(t.failedJoin))}
                </p>
              )}
              {many?.state === "notSaved" && (
                <p className="updates-error" role="alert">
                  {t.notStartedMany(problemText(many.why, t))}
                </p>
              )}
            </div>
          )}
          {listing.otherAgents > 0 && (
            <p className="diagnostics-note">{t.others(listing.otherAgents)}</p>
          )}
        </>
      )}
      {shown && "why" in shown && (
        <p className="updates-error" role="alert">
          {t.unopened(shown.name, problemText(shown.why, t))}
        </p>
      )}
      {shown && "text" in shown && (
        <div className="draft-export-shown">
          <p className="diagnostics-note" role="status">
            {save?.state === "saving" ? t.saving(save.name) : t.whole(shown.name)}
          </p>
          {save?.state === "notSaved" && (
            <p className="updates-error" role="alert">
              {t.notStarted(problemText(save.why, t))}
            </p>
          )}
          <textarea
            className="diagnostics-text"
            aria-label={t.saved(shown.name)}
            readOnly
            rows={10}
            value={shown.text}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="secondary-button" onClick={download}>
            <Download size={14} aria-hidden="true" /> {t.downloadText}
          </button>
        </div>
      )}
    </section>
  );
}

function describe(row: DraftRow, t: Text): string {
  const summary = row.summary;
  if (summary.state === "damaged") return t.damaged(problemText({ kind: "error", error: summary.reason }, t));
  const parts = [t.chars(summary.textChars)];
  if (summary.pastes) parts.push(t.pastes(summary.pastes));
  if (summary.images) parts.push(t.images(summary.images));
  if (summary.skills) parts.push(t.skills(summary.skills));
  return `${summary.state === "legacy" ? t.legacy : ""}${parts.join(t.join)}`;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTimeDisplay } from "../../time-preferences";
import {
  ArrowUpRight,
  FileChartLine,
  FileText,
  Image as ImageIcon,
  Link,
  Paperclip,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { errorText } from "../../api";
import { ImagePreview } from "../../ImageAttachments";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { usePointFix, type PointFixSource } from "../../point-fix";
import { useStrings } from "../../i18n";
import { briefText } from "./brief-text";
import type { SectionAttachment } from "../types";
import { useBrief } from "./BriefContext";
import { useBriefDensity } from "../home-density";
import { attachmentUrl, formatTime, type AttachmentsProps } from "./brief-catalog";
import { OpenChoice } from "../../portal/OpenChoice";
import { htmlFile } from "../../portal/html-file";

/** Rows of a data file shown inline; the file itself opens in full. */
export const PREVIEW_ROWS = 20;
const PREVIEW_COLUMNS = 12;
/** Text and logs show their last lines, as the Brief limits promise. */
export const TAIL_LINES = 200;
/** Bytes read for a preview: the head of a data file, the tail of a log. */
const PREVIEW_BYTES = 256 * 1024;

const icons: Record<SectionAttachment["kind"], LucideIcon> = {
  image: ImageIcon,
  data: FileChartLine,
  pdf: FileText,
  text: ScrollText,
  link: Link,
};
const bytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

type Read = { text: string; truncated: boolean };
/**
 * At most PREVIEW_BYTES of a snapshot: its start, or its end (asked for
 * with a suffix Range, and kept bounded even when Core sends it whole).
 * A line cut by the bound is dropped.
 */
async function readPart(url: string, part: "head" | "tail", signal: AbortSignal): Promise<Read> {
  const response = await fetch(url, {
    signal,
    headers: part === "tail" ? { Range: `bytes=-${PREVIEW_BYTES}` } : undefined,
  });
  if (!response.ok) throw new Error(`Core answered ${response.status}.`);
  let text: string;
  let truncated = response.status === 206;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (part === "head" && size >= PREVIEW_BYTES) {
        truncated = true;
        await reader.cancel();
        break;
      }
      while (part === "tail" && chunks.length > 1 && size - chunks[0].length >= PREVIEW_BYTES) {
        size -= chunks.shift()!.length;
        truncated = true;
      }
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    text = new TextDecoder().decode(all);
  } else {
    text = await response.text();
  }
  if (text.length > PREVIEW_BYTES) {
    text = part === "head" ? text.slice(0, PREVIEW_BYTES) : text.slice(-PREVIEW_BYTES);
    truncated = true;
  }
  if (truncated)
    text = part === "head" ? text.slice(0, text.lastIndexOf("\n") + 1) : text.slice(text.indexOf("\n") + 1);
  return { text, truncated };
}

type Preview<T> = { state: "loading" } | { state: "error"; error: string } | ({ state: "ready" } & T);
/** A preview read once per snapshot (`key`); null reads nothing. */
function usePreview<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>): Preview<T> {
  const [preview, setPreview] = useState<{ key: string; value: Preview<T> } | null>(null);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    reader.current(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setPreview({ key, value: { state: "ready", ...value } });
      },
      (error) => {
        if (!controller.signal.aborted) setPreview({ key, value: { state: "error", error: errorText(error) } });
      },
    );
    return () => controller.abort();
  }, [key]);
  return preview?.key === key ? preview.value : { state: "loading" };
}
const snapshotKey = (url: string, attachment: SectionAttachment) => `${url}@${attachment.takenAt}`;

type Format = "csv" | "tsv" | "json" | "jsonl";
function formatOf(attachment: SectionAttachment): Format | null {
  const mime = attachment.mime.toLowerCase();
  const extension = /\.([a-z]+)$/i.exec(attachment.name)?.[1]?.toLowerCase();
  if (mime.includes("ndjson") || mime.includes("jsonl") || extension === "jsonl" || extension === "ndjson") return "jsonl";
  if (mime.includes("json") || extension === "json") return "json";
  if (mime.includes("tab-separated") || extension === "tsv") return "tsv";
  if (mime.includes("csv") || extension === "csv") return "csv";
  return null;
}
/** Records of delimited text, quotes and all (RFC 4180), up to `limit`. */
function delimited(text: string, separator: string, limit: number): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && records.length < limit; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === separator) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if ((field || record.length) && records.length < limit) records.push([...record, field]);
  return records;
}
const cell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};
type Rows = { columns: string[]; rows: string[][]; more: boolean };
/** The first rows of a JSON array, JSONL lines or a CSV/TSV, as a small table. */
export function previewRows(text: string, format: Format, truncated: boolean): Rows {
  if (format === "csv" || format === "tsv") {
    const records = delimited(text, format === "tsv" ? "\t" : ",", PREVIEW_ROWS + 2);
    const [header = [], ...rest] = records;
    return {
      columns: header.slice(0, PREVIEW_COLUMNS),
      rows: rest.slice(0, PREVIEW_ROWS).map((row) => row.slice(0, PREVIEW_COLUMNS).map(cell)),
      more: truncated || rest.length > PREVIEW_ROWS,
    };
  }
  let items: unknown[];
  let more = truncated;
  if (format === "jsonl") {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    items = lines.slice(0, PREVIEW_ROWS).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
    more ||= lines.length > PREVIEW_ROWS;
  } else {
    const value: unknown = JSON.parse(text);
    items = Array.isArray(value) ? value : [value];
    more ||= items.length > PREVIEW_ROWS;
    items = items.slice(0, PREVIEW_ROWS);
  }
  const objects = items.every((item) => item && typeof item === "object" && !Array.isArray(item));
  if (objects) {
    const columns: string[] = [];
    for (const item of items as Record<string, unknown>[])
      for (const key of Object.keys(item)) if (columns.length < PREVIEW_COLUMNS && !columns.includes(key)) columns.push(key);
    return { columns, rows: (items as Record<string, unknown>[]).map((item) => columns.map((key) => cell(item[key]))), more };
  }
  if (items.every(Array.isArray)) {
    const width = Math.min(PREVIEW_COLUMNS, Math.max(0, ...(items as unknown[][]).map((row) => row.length)));
    return {
      columns: Array.from({ length: width }, (_, i) => String(i + 1)),
      rows: (items as unknown[][]).map((row) => Array.from({ length: width }, (_, i) => cell(row[i]))),
      more,
    };
  }
  return { columns: ["value"], rows: items.map((item) => [cell(item)]), more };
}

/**
 * A preview's place: the same fixed frame and caption line whether it is
 * loading, failed or ready, so a preview arriving never moves what follows.
 */
function Placeholder({ text }: { text: string }) {
  return (
    <div className="brief-preview">
      <p className="brief-preview-frame brief-attachment-note" role="status">
        {text}
      </p>
      <small aria-hidden="true">&nbsp;</small>
    </div>
  );
}

function DataPreview({ url, attachment }: { url: string; attachment: SectionAttachment }) {
  const format = formatOf(attachment);
  // JSON has no readable prefix; a large file opens in full instead.
  const whole = format === "json" && attachment.size > PREVIEW_BYTES;
  const t = useStrings(briefText);
  const preview = usePreview(format && !whole ? snapshotKey(url, attachment) : null, async (signal) => {
    const { text, truncated } = await readPart(url, "head", signal);
    return previewRows(text, format!, truncated);
  });
  if (!format || whole)
    return <p className="brief-attachment-note">{whole ? t.tooLarge : t.noPreview}</p>;
  if (preview.state === "loading") return <Placeholder text={t.loadingPreview} />;
  if (preview.state === "error") return <Placeholder text={t.previewUnavailable(preview.error)} />;
  return (
    <div className="brief-preview">
      <div className="brief-preview-frame brief-preview-scroll" tabIndex={0} role="region" aria-label={t.previewOf(attachment.name)}>
        <table>
          <thead>
            <tr>
              {preview.columns.map((column, index) => (
                <th key={index} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index}>
                {row.map((value, column) => (
                  <td key={column}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small>
        {preview.more ? t.firstRows(preview.rows.length) : t.rows(preview.rows.length)}
      </small>
    </div>
  );
}

function TextTail({ url, attachment }: { url: string; attachment: SectionAttachment }) {
  const name = attachment.name;
  const t = useStrings(briefText);
  const preview = usePreview(snapshotKey(url, attachment), async (signal) => {
    const { text, truncated } = await readPart(url, "tail", signal);
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    return { lines: lines.slice(-TAIL_LINES), more: truncated || lines.length > TAIL_LINES };
  });
  const box = useRef<HTMLPreElement>(null);
  // The end of a log is what matters; start there.
  useLayoutEffect(() => {
    if (preview.state === "ready" && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [preview]);
  if (preview.state === "loading") return <Placeholder text={t.loadingPreview} />;
  if (preview.state === "error") return <Placeholder text={t.previewUnavailable(preview.error)} />;
  return (
    <div className="brief-preview">
      <pre ref={box} className="brief-preview-frame brief-tail" tabIndex={0} aria-label={t.lastLinesOf(name)}>
        {preview.lines.join("\n")}
      </pre>
      <small>{preview.more ? t.lastLines(preview.lines.length) : t.lines(preview.lines.length)}</small>
    </div>
  );
}

/**
 * Where a referenced file lives. Only the directory is cut short (by CSS,
 * at the width there is); the file name always shows whole.
 */
function Path({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return (
    <code className="brief-path" title={path}>
      {cut > 0 && <span className="brief-path-dir">{path.slice(0, cut)}</span>}
      <span className="brief-path-name">{path.slice(cut)}</span>
    </code>
  );
}

/** An image as it was when the preview opened: a later update of the card
 * never changes the image being looked at or marked (T-177). */
type Shown = { url: string; version: number; takenAt: string; title: string; ownerId: string };

function Attachment({ name, caption }: { name: string; caption?: string }) {
  const time = useTimeDisplay();
  const t = useStrings(briefText);
  const { projectId, section } = useBrief();
  const markUp = usePointFix();
  const [shown, setShown] = useState<Shown | null>(null);
  const attachment = section.attachments.find((item) => item.name === name);
  if (!attachment)
    return (
      <div className="brief-attachment">
        <header>
          <Paperclip size={14} aria-hidden="true" />
          <strong>{name}</strong>
        </header>
        <p className="brief-attachment-note">{t.attachmentGone}</p>
      </div>
    );
  const Icon = icons[attachment.kind] || Paperclip;
  const url = attachmentUrl(projectId, section.key, attachment.name, section.version);
  const link = attachment.kind === "link" && attachment.url ? sourceTarget(attachment.url) : null;
  const kept = attachment.snapshot && attachment.kind !== "link";
  const label = caption || attachment.caption;
  // A kept image opens whole in the app, as a conversation's images do,
  // rather than in a browser tab (T-177).
  const image = kept && attachment.kind === "image";
  // A kept HTML page opens working (T-5): its source only when asked for.
  const page = kept && attachment.kind !== "image" && htmlFile(attachment.name);
  const preview = () =>
    setShown({ url, version: section.version, takenAt: attachment.takenAt, title: section.title, ownerId: section.owner.agentId });
  // Point & Fix on the image as shown, its source named for the Agent told.
  // The card's author is offered first; without one, the user chooses.
  const source = (at: Shown): PointFixSource => ({
    name: attachment.name,
    ownerId: at.ownerId,
    chooseWithoutOwner: true,
    provenance: `the image “${attachment.name}” on the Home card “${at.title}” (project ${projectId}, section ${section.key}, version ${at.version}; snapshot taken ${at.takenAt})`,
    load: async (signal) => {
      const response = await fetch(at.url, { signal });
      if (!response.ok) throw new Error(`the snapshot cannot be read (HTTP ${response.status})`);
      return response.blob();
    },
  });
  return (
    <div className="brief-attachment" data-kind={attachment.kind}>
      <header>
        <Icon size={14} aria-hidden="true" />
        <strong title={attachment.name}>{attachment.name}</strong>
        {attachment.mayChange && (
          <span className="brief-chip" data-state="changed" title={t.mayChangeTitle}>
            {t.mayChange}
          </span>
        )}
        {!attachment.snapshot && attachment.path && (
          <Path path={attachment.path} />
        )}
        {image ? (
          <button type="button" className="brief-attachment-open" onClick={preview}>
            {t.openFile}
          </button>
        ) : page ? (
          <OpenChoice
            target={() => ({
              kind: "snapshot",
              source: { kind: "briefAttachment", projectId, section: section.key, name: attachment.name, version: section.version },
              name: attachment.name,
              from: `Home · ${section.title}`,
            })}
            onSource={() => window.open(url, "_blank", "noopener,noreferrer")}
          />
        ) : (
          kept && (
            <a className="brief-attachment-open" href={url} target="_blank" rel="noopener noreferrer">
              {attachment.kind === "pdf" ? t.openPdf : t.openFile}
              <ArrowUpRight size={11} aria-hidden="true" />
            </a>
          )
        )}
      </header>
      {label && <p className="brief-attachment-caption">{label}</p>}
      <small className="brief-attachment-meta">
        {attachment.kind !== "link" && <>{bytes(attachment.size)} · </>}
        {attachment.snapshot ? t.snapshot : t.referenced}{" "}
        <time dateTime={attachment.takenAt}>{formatTime(attachment.takenAt, time)}</time>
      </small>
      {attachment.kind === "link" ? (
        link?.kind === "web" ? (
          <a className="brief-attachment-link" href={link.path} target="_blank" rel="noopener noreferrer">
            {link.path}
            <ArrowUpRight size={11} aria-hidden="true" />
          </a>
        ) : (
          <p className="brief-attachment-note">{attachment.url || t.noAddress}</p>
        )
      ) : !attachment.snapshot ? (
        <p className="brief-attachment-note">{t.notKept}</p>
      ) : attachment.kind === "image" ? (
        <button type="button" className="brief-image" aria-label={t.openImage(attachment.name)} onClick={preview}>
          {/* A new snapshot under the same name loads again. */}
          <img key={attachment.takenAt} src={url} alt={label || attachment.name} loading="lazy" decoding="async" />
        </button>
      ) : attachment.kind === "data" ? (
        <DataPreview url={url} attachment={attachment} />
      ) : attachment.kind === "text" && !page ? (
        <TextTail url={url} attachment={attachment} />
      ) : null}
      {image && (
        <ImagePreview
          open={!!shown}
          src={shown?.url ?? ""}
          name={attachment.name}
          description={t.imageSnapshot(label ?? "", formatTime(shown?.takenAt ?? attachment.takenAt, time))}
          unavailable={t.imageUnavailable}
          onClose={() => setShown(null)}
          onAnnotate={markUp && shown ? () => {
            const at = shown;
            setShown(null);
            markUp(source(at));
          } : undefined}
        />
      )}
    </div>
  );
}

/**
 * Attachments shown before "Show all": a long row of screenshots is evidence
 * to open, not a page to scroll past, least of all on a phone (T-173). Up to
 * two more show at once, as a button would save nothing.
 */
export const FIRST_ATTACHMENTS = 4;

/** A short card (low density) leads with its first attachment, the deliverable to preview. */
export const FIRST_ATTACHMENTS_SHORT = 1;

export function BriefAttachments({ items }: AttachmentsProps) {
  const t = useStrings(briefText);
  const { section } = useBrief();
  const density = useBriefDensity();
  const [all, setAll] = useState(false);
  const first = density === "low" ? FIRST_ATTACHMENTS_SHORT : FIRST_ATTACHMENTS;
  const folds = density === "low" ? items.length > first : items.length > first + 2;
  // A short card never folds away what an attachment warns of: one gone
  // from the section, not kept, or that may change.
  const warns = (name: string) => {
    const attachment = section.attachments.find((item) => item.name === name);
    return !attachment || attachment.mayChange || (!attachment.snapshot && attachment.kind !== "link");
  };
  const shown =
    folds && !all ? items.filter((item, index) => index < first || (density === "low" && warns(item.name))) : items;
  return (
    <div className="brief-attachments-block" data-density={density}>
      <ul className="brief-attachments" aria-label={t.attachments}>
        {shown.map((item) => (
          <li key={item.name}>
            <Attachment name={item.name} caption={item.caption} />
          </li>
        ))}
      </ul>
      {folds && (
        <button type="button" className="quiet-button brief-attachments-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? (density === "low" ? t.showFewer : t.showFirst(first)) : t.showAll(items.length)}
        </button>
      )}
    </div>
  );
}

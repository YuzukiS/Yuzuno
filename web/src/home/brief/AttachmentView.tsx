import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import type { SectionAttachment } from "../types";
import { useBrief } from "./BriefContext";
import { attachmentUrl, formatTime, type AttachmentsProps } from "./brief-catalog";

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
  const preview = usePreview(format && !whole ? snapshotKey(url, attachment) : null, async (signal) => {
    const { text, truncated } = await readPart(url, "head", signal);
    return previewRows(text, format!, truncated);
  });
  if (!format || whole)
    return <p className="brief-attachment-note">{whole ? "Too large to preview here." : "No preview for this format."}</p>;
  if (preview.state === "loading") return <Placeholder text="Loading preview…" />;
  if (preview.state === "error") return <Placeholder text={`Preview unavailable. ${preview.error}`} />;
  return (
    <div className="brief-preview">
      <div className="brief-preview-frame brief-preview-scroll" tabIndex={0} role="region" aria-label={`${attachment.name} preview`}>
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
        {preview.more ? `First ${preview.rows.length} rows` : `${preview.rows.length} ${preview.rows.length === 1 ? "row" : "rows"}`}
      </small>
    </div>
  );
}

function TextTail({ url, attachment }: { url: string; attachment: SectionAttachment }) {
  const name = attachment.name;
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
  if (preview.state === "loading") return <Placeholder text="Loading preview…" />;
  if (preview.state === "error") return <Placeholder text={`Preview unavailable. ${preview.error}`} />;
  return (
    <div className="brief-preview">
      <pre ref={box} className="brief-preview-frame brief-tail" tabIndex={0} aria-label={`${name}, last lines`}>
        {preview.lines.join("\n")}
      </pre>
      <small>{preview.more ? `Last ${preview.lines.length} lines` : `${preview.lines.length} lines`}</small>
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

function Attachment({ name, caption }: { name: string; caption?: string }) {
  const { projectId, section } = useBrief();
  const attachment = section.attachments.find((item) => item.name === name);
  if (!attachment)
    return (
      <div className="brief-attachment">
        <header>
          <Paperclip size={14} aria-hidden="true" />
          <strong>{name}</strong>
        </header>
        <p className="brief-attachment-note">This attachment is no longer part of the section.</p>
      </div>
    );
  const Icon = icons[attachment.kind] || Paperclip;
  const url = attachmentUrl(projectId, section.key, attachment.name, section.version);
  const link = attachment.kind === "link" && attachment.url ? sourceTarget(attachment.url) : null;
  const kept = attachment.snapshot && attachment.kind !== "link";
  const label = caption || attachment.caption;
  return (
    <div className="brief-attachment" data-kind={attachment.kind}>
      <header>
        <Icon size={14} aria-hidden="true" />
        <strong title={attachment.name}>{attachment.name}</strong>
        {attachment.mayChange && (
          <span className="brief-chip" data-state="changed" title="Only referenced: the file may have changed since it was attached">
            May have changed
          </span>
        )}
        {!attachment.snapshot && attachment.path && (
          <Path path={attachment.path} />
        )}
        {kept && (
          <a className="brief-attachment-open" href={url} target="_blank" rel="noopener noreferrer">
            {attachment.kind === "pdf" ? "Open PDF" : "Open"}
            <ArrowUpRight size={11} aria-hidden="true" />
          </a>
        )}
      </header>
      {label && <p className="brief-attachment-caption">{label}</p>}
      <small className="brief-attachment-meta">
        {attachment.kind !== "link" && <>{bytes(attachment.size)} · </>}
        {attachment.snapshot ? "Snapshot" : "Referenced"}{" "}
        <time dateTime={attachment.takenAt}>{formatTime(attachment.takenAt)}</time>
      </small>
      {attachment.kind === "link" ? (
        link?.kind === "web" ? (
          <a className="brief-attachment-link" href={link.path} target="_blank" rel="noopener noreferrer">
            {link.path}
            <ArrowUpRight size={11} aria-hidden="true" />
          </a>
        ) : (
          <p className="brief-attachment-note">{attachment.url || "No address."}</p>
        )
      ) : !attachment.snapshot ? (
        <p className="brief-attachment-note">Not kept by Yuzuno, so there is nothing to preview.</p>
      ) : attachment.kind === "image" ? (
        <a className="brief-image" href={url} target="_blank" rel="noopener noreferrer">
          {/* A new snapshot under the same name loads again. */}
          <img key={attachment.takenAt} src={url} alt={label || attachment.name} loading="lazy" decoding="async" />
        </a>
      ) : attachment.kind === "data" ? (
        <DataPreview url={url} attachment={attachment} />
      ) : attachment.kind === "text" ? (
        <TextTail url={url} attachment={attachment} />
      ) : null}
    </div>
  );
}

export function BriefAttachments({ items }: AttachmentsProps) {
  return (
    <ul className="brief-attachments" aria-label="Attachments">
      {items.map((item) => (
        <li key={item.name}>
          <Attachment name={item.name} caption={item.caption} />
        </li>
      ))}
    </ul>
  );
}

import type { ReactNode } from "react";
import { Download, X } from "lucide-react";
import { API_BASE } from "./api";
import { fileSize } from "./file-input";
import { strings, useStrings } from "./i18n";
import { useFileDrag, type NativeFile } from "./native-file-drag";
import { Tip, TipText } from "./Tip";
import "./file-input.css";

/** A file to show: one in a draft, or one a message carried. */
export type PreviewFile = {
  id: string;
  name: string;
  bytes: number;
  /** The Agent whose files it belongs to; unset for one the caller places. */
  agentId?: string;
  /** Where its Agent reads it (a sent message only). */
  path?: string;
};

const text = strings({
  remove: (name: string) => `Remove ${name}`,
  download: (name: string) => `Download ${name}`,
  kind: "File",
}, {
  remove: (name) => `移除 ${name}`,
  download: (name) => `下载 ${name}`,
  kind: "文件",
});

/** Where a sent message's file is read from Core: an attachment download. */
export const fileUrl = (agentId: string, id: string, name: string) =>
  `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;

/** The extension in its small block: the first four letters, uppercase. */
function fileKind(name: string, fallback: string) {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  const kind = extension.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase();
  return kind || fallback;
}

/**
 * The files of a draft or a sent message (YN-145 §2.6): each one line, its
 * type, its name and its size, as the composer takes them. In a draft each
 * has a remove button; in a sent message each downloads from Core, and its
 * tip names the path the Agent reads. A sent one dragged out is that file
 * (YN-170): in the desktop app a real one, in Chromium a download.
 */
export function FileAttachments({
  files,
  agentId,
  href,
  projectId,
  onRemove,
}: {
  files: readonly PreviewFile[];
  /** The Agent whose files these are, for a sent message's download. */
  agentId?: string;
  /** Where a sent message's file downloads from, when not its Agent's own
   * route: Home keeps its files on the Project (home-files.ts). */
  href?: (file: PreviewFile) => string;
  /** The Project that keeps these files, when Home does (with `href`): the
   * desktop app fetches a dragged one from there. */
  projectId?: string;
  onRemove?: (file: PreviewFile) => void;
}) {
  const t = useStrings(text);
  if (!files.length) return null;
  return (
    <div className="input-files">
      {files.map((file) => {
        const name = file.name || t.kind;
        const content = (
          <>
            <span className="input-file-kind" aria-hidden="true">
              {fileKind(file.name, t.kind)}
            </span>
            <span className="input-file-name">{name}</span>
            <span className="input-file-size">{fileSize(file.bytes)}</span>
          </>
        );
        const key = `${file.agentId ?? ""}:${file.id}:${file.name}`;
        if (onRemove)
          return (
            <div className="input-file" key={key}>
              <div className="input-file-body">{content}</div>
              <button
                type="button"
                className="input-file-remove"
                aria-label={t.remove(name)}
                onClick={() => onRemove(file)}
              >
                <X size={12} />
              </button>
            </div>
          );
        const owner = file.agentId ?? agentId ?? "";
        const native: NativeFile | null = projectId
          ? { kind: "projectFile", projectId, fileId: file.id, name: file.name }
          : owner && !href
            ? { kind: "agentFile", agentId: owner, fileId: file.id, name: file.name }
            : null;
        return (
          <SentFile
            key={key}
            name={name}
            file={file}
            href={href?.(file) ?? fileUrl(owner, file.id, file.name)}
            native={native}
            label={t.download(name)}
          >
            {content}
          </SentFile>
        );
      })}
    </div>
  );
}

/** A sent file: a download to click, and the file itself to drag out. A
 * failed drag says why on a line of its own below the files. */
function SentFile({
  name,
  file,
  href,
  native,
  label,
  children,
}: {
  name: string;
  file: PreviewFile;
  href: string;
  native: NativeFile | null;
  label: string;
  children: ReactNode;
}) {
  const drag = useFileDrag(native && file.name ? { file: native, mime: "application/octet-stream", url: href } : null);
  return (
    <>
      <div className="input-file">
        <Tip side="top" align="start" describe={false} content={<TipText title={name} body={file.path} />}>
          <a className="input-file-body" href={href} download={file.name} aria-label={label} {...drag.props}>
            {children}
            <Download className="input-file-download" size={12} aria-hidden="true" />
          </a>
        </Tip>
      </div>
      {drag.error && (
        <p className="input-files-note" role="status">
          {drag.error}
        </p>
      )}
    </>
  );
}

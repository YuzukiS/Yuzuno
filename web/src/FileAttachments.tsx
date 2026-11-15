import { Download, X } from "lucide-react";
import { API_BASE } from "./api";
import { fileSize } from "./file-input";
import { strings, useStrings } from "./i18n";
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
 * tip names the path the Agent reads.
 */
export function FileAttachments({
  files,
  agentId,
  onRemove,
}: {
  files: readonly PreviewFile[];
  /** The Agent whose files these are, for a sent message's download. */
  agentId?: string;
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
        const owner = file.agentId ?? agentId ?? "";
        return (
          <div className="input-file" key={`${file.agentId ?? ""}:${file.id}:${file.name}`}>
            {onRemove ? (
              <div className="input-file-body">{content}</div>
            ) : (
              <Tip
                side="top"
                align="start"
                describe={false}
                content={<TipText title={name} body={file.path} />}
              >
                <a
                  className="input-file-body"
                  href={fileUrl(owner, file.id, file.name)}
                  download={file.name}
                  aria-label={t.download(name)}
                >
                  {content}
                  <Download className="input-file-download" size={12} aria-hidden="true" />
                </a>
              </Tip>
            )}
            {onRemove && (
              <button
                type="button"
                className="input-file-remove"
                aria-label={t.remove(name)}
                onClick={() => onRemove(file)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SquareDashedMousePointer, X } from "lucide-react";
import { Modal } from "./components";
import { API_BASE } from "./api";
import { langTag, strings, useLanguage, useStrings } from "./i18n";
import "./image-input.css";

export const inputImageUrl = (agent: string, id: string, thumb = false) =>
  `${API_BASE}/api/agents/${encodeURIComponent(agent)}/images/${encodeURIComponent(id)}${thumb ? "?thumb=true" : ""}`;
type PreviewImage = { id: string; agentId: string; name?: string };
// The attachments' own words (T-189); an image's name as it came.
const text = strings({
  open: (n: number, name: string) => `Open image ${n}: ${name}`,
  image: (n: number) => `Image ${n}`,
  attached: "Attached image",
  markUp: (n: number) => `Mark up image ${n}`,
  markUpTitle: "Point & Fix · mark areas on this image",
  remove: (n: number) => `Remove image ${n}`,
  original: "Original image attached to this message",
  unavailable: "This saved image is unavailable. The original file may have been removed from this Core.",
  markUpButton: "Mark up",
  closeDialog: "Close dialog",
}, {
  open: (n, name) => `打开图片 ${n}：${name}`,
  image: (n) => `图片 ${n}`,
  attached: "附加的图片",
  markUp: (n) => `标注图片 ${n}`,
  markUpTitle: "Point & Fix · 在这张图片上标出区域",
  remove: (n) => `移除图片 ${n}`,
  original: "此消息附带的原图",
  unavailable: "这张已保存的图片不可用，原文件可能已从此 Core 中移除。",
  markUpButton: "标注",
  closeDialog: "关闭对话框",
});
export function ImageAttachments({
  images,
  onRemove,
  onAnnotate,
  annotateThumbnails = false,
  description,
}: {
  images: readonly PreviewImage[];
  onRemove?: (id: string) => void;
  /** Point & Fix (T-167): mark areas on an opened image. */
  onAnnotate?: (image: PreviewImage) => void;
  /** Offer Mark up on each thumbnail too, as for images in a draft. */
  annotateThumbnails?: boolean;
  /** What the full preview shows, if not simply the original. */
  description?: string;
}) {
  const [opened, setOpened] = useState<PreviewImage | null>(null);
  const t = useStrings(text);
  if (!images.length) return null;
  return (
    <div className="input-images">
      {images.map((image, index) => (
        <div className="input-image" key={`${image.agentId}:${image.id}`}>
          <button
            type="button"
            className="input-image-open"
            aria-label={t.open(index + 1, image.name || t.attached)}
            onClick={() => setOpened(image)}
          >
            <img
              src={inputImageUrl(image.agentId, image.id, true)}
              alt={image.name || t.image(index + 1)}
              loading="lazy"
            />
            <span className="input-image-hover" aria-hidden="true">
              <img src={inputImageUrl(image.agentId, image.id, true)} alt="" />
              <span>{image.name || t.image(index + 1)}</span>
            </span>
          </button>
          {onAnnotate && annotateThumbnails && (
            <button
              type="button"
              className="input-image-markup"
              aria-label={t.markUp(index + 1)}
              title={t.markUpTitle}
              onClick={() => onAnnotate(image)}
            >
              <SquareDashedMousePointer size={11} />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="input-image-remove"
              aria-label={t.remove(index + 1)}
              onClick={() => {
                if (opened?.id === image.id) setOpened(null);
                onRemove(image.id);
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
      <ImagePreview
        open={!!opened}
        src={opened ? inputImageUrl(opened.agentId, opened.id) : ""}
        name={opened?.name || t.attached}
        description={description ?? t.original}
        unavailable={t.unavailable}
        onClose={() => setOpened(null)}
        onAnnotate={onAnnotate && opened ? () => {
          const image = opened;
          setOpened(null);
          onAnnotate(image);
        } : undefined}
      />
    </div>
  );
}

/**
 * An image shown whole in the app, with Point & Fix when it is offered: the
 * preview a conversation's images open (T-31), and Home's Brief images too
 * (T-177). Only the image is read; it loads when opened, and closing it
 * drops the read.
 */
export function ImagePreview({
  open,
  src,
  name,
  description,
  unavailable,
  onClose,
  onAnnotate,
}: {
  open: boolean;
  src: string;
  name: string;
  description?: string;
  /** What to say when the image cannot be read. */
  unavailable: string;
  onClose: () => void;
  onAnnotate?: () => void;
}) {
  const [failed, setFailed] = useState("");
  const language = useLanguage();
  const t = text(language);
  // Each opening reads the image again: one that failed may be back.
  useEffect(() => {
    if (open) setFailed("");
  }, [open, src]);
  // The preview has no trigger of its own, so closing it puts focus back on
  // what opened it: the thumbnail or Open (T-177). Taken before the dialog
  // moves focus into itself.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={name}
      description={description}
      lang={langTag(language)}
      closeLabel={t.closeDialog}
      wide
      onCloseAutoFocus={(event) => {
        const back = opener.current;
        if (back?.isConnected) {
          event.preventDefault();
          back.focus();
        }
      }}
    >
      {open && (
        <div className="input-image-dialog">
          <img src={src} alt={name} onError={() => setFailed(src)} />
          {failed === src && <p role="alert">{unavailable}</p>}
          {onAnnotate && failed !== src && (
            <button type="button" className="secondary-button input-image-annotate" onClick={onAnnotate}>
              <SquareDashedMousePointer size={14} />
              {t.markUpButton}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

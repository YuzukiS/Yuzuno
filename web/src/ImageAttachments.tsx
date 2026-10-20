import { useState } from "react";
import { X } from "lucide-react";
import { Modal } from "./components";
import { API_BASE } from "./api";
import "./image-input.css";

export const inputImageUrl = (agent: string, id: string, thumb = false) =>
  `${API_BASE}/api/agents/${encodeURIComponent(agent)}/images/${encodeURIComponent(id)}${thumb ? "?thumb=true" : ""}`;
type PreviewImage = { id: string; agentId: string; name?: string };
export function ImageAttachments({
  images,
  onRemove,
  description = "Original image attached to this message",
}: {
  images: readonly PreviewImage[];
  onRemove?: (id: string) => void;
  /** What the full preview shows, if not simply the original. */
  description?: string;
}) {
  const [opened, setOpened] = useState<PreviewImage | null>(null);
  const [failed, setFailed] = useState(false);
  if (!images.length) return null;
  return (
    <div className="input-images">
      {images.map((image, index) => (
        <div className="input-image" key={`${image.agentId}:${image.id}`}>
          <button
            type="button"
            className="input-image-open"
            aria-label={`Open image ${index + 1}: ${image.name || "Attached image"}`}
            onClick={() => {
              setFailed(false);
              setOpened(image);
            }}
          >
            <img
              src={inputImageUrl(image.agentId, image.id, true)}
              alt={image.name || `Image ${index + 1}`}
              loading="lazy"
            />
            <span className="input-image-hover" aria-hidden="true">
              <img src={inputImageUrl(image.agentId, image.id, true)} alt="" />
              <span>{image.name || `Image ${index + 1}`}</span>
            </span>
          </button>
          {onRemove && (
            <button
              type="button"
              className="input-image-remove"
              aria-label={`Remove image ${index + 1}`}
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
      <Modal
        open={!!opened}
        onOpenChange={(open) => {
          if (!open) setOpened(null);
        }}
        title={opened?.name || "Attached image"}
        description={description}
        wide
      >
        {opened && (
          <div className="input-image-dialog">
            <img
              src={inputImageUrl(opened.agentId, opened.id)}
              alt={opened.name || "Attached image"}
              onError={() => setFailed(true)}
            />
            {failed && (
              <p role="alert">
                This saved image is unavailable. The original file may have been
                removed from this Core.
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

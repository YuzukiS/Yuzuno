import { useState } from "react";
import { useStateBinding } from "@json-render/react";
import { useStrings } from "../../i18n";
import { attachmentUrl, type FigureProps } from "./brief-catalog";
import { useBrief } from "./BriefContext";
import { briefText } from "./brief-text";

/**
 * An image of this section with numbered hotspots (YN-16 S4). The picture is
 * the section's own attachment, read from this Core at the section's
 * version; an SVG is shown as an image, so nothing in it runs. Each hotspot
 * is a numbered marker over the picture and a button in the list under it:
 * the list is what the keyboard and a screen reader use, the markers what a
 * pointer or a finger does. Selecting one shows its detail; with select, its
 * id is also the value of that variable of the section.
 */
export function BriefFigure({ image, alt, caption, select, hotspots }: FigureProps) {
  const t = useStrings(briefText);
  const { projectId, section } = useBrief();
  const file = section.attachments.find((item) => item.name === image);
  const [failed, setFailed] = useState("");
  const [chosen, choose] = useStateBinding<string>(select ? `/${select}` : "/");
  const [own, setOwn] = useState("");
  const selected = select ? (typeof chosen === "string" ? chosen : "") : own;
  const pick = (value: string) => (select ? choose(value) : setOwn(value));
  const current = hotspots.find((spot) => spot.id === selected);
  const src = attachmentUrl(projectId, section.key, image, section.version);
  const kept = file?.kind === "image" && file.snapshot;
  return (
    <figure className="brief-figure">
      <div className="brief-figure-frame">
        {kept && failed !== src ? (
          <div
            className="brief-figure-picture"
            style={file.width && file.height ? { aspectRatio: `${file.width} / ${file.height}` } : undefined}
          >
            <img src={src} alt={alt} width={file.width} height={file.height} decoding="async" onError={() => setFailed(src)} />
            {hotspots.map((spot, index) => (
              <button
                key={spot.id}
                type="button"
                className="brief-hotspot"
                data-hotspot={spot.id}
                data-selected={spot.id === selected || undefined}
                style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
                // The list under the picture is the keyboard's and the screen reader's way to the same hotspots.
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => pick(spot.id)}
              >
                {index + 1}
              </button>
            ))}
          </div>
        ) : (
          <p className="brief-figure-missing" role="status">
            {kept ? t.imageNotLoaded : t.figureNotKept(image)}
          </p>
        )}
      </div>
      <ol className="brief-figure-key" aria-label={t.figureKey(alt)}>
        {hotspots.map((spot, index) => (
          <li key={spot.id}>
            <button type="button" className="brief-figure-key-item" aria-pressed={spot.id === selected} data-hotspot={spot.id} onClick={() => pick(spot.id)}>
              <span className="brief-figure-number" aria-hidden="true">
                {index + 1}
              </span>
              {spot.label}
            </button>
          </li>
        ))}
      </ol>
      <div className="brief-figure-detail" aria-live="polite">
        {current ? (
          <>
            <strong>{current.label}</strong>
            {current.detail && <p>{current.detail}</p>}
          </>
        ) : (
          <p className="brief-diagram-hint">{t.figureHint}</p>
        )}
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

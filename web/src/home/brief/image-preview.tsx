import { useState, type ReactNode } from "react";
import { ImagePreview } from "../../ImageAttachments";
import { useStrings } from "../../i18n";
import { usePointFix, type PointFixSource } from "../../point-fix";
import { useTimeDisplay } from "../../time-preferences";
import type { Section, SectionAttachment } from "../types";
import { attachmentUrl, formatTime } from "./brief-catalog";
import { briefText } from "./brief-text";

/** An image as it was when the preview opened: a later update of the card
 * never changes the image being looked at or marked (T-177). */
type Shown = { url: string; version: number; takenAt: string; title: string; ownerId: string };

/**
 * A section's kept image, opened whole in the app to zoom into (T-20), as a
 * conversation's images open (T-177): from its report page, and from its
 * card on Home (YN-3). `open` takes the image as the card shows it now;
 * `dialog` is the preview, to be drawn beside what opened it, which gets
 * focus back when it closes. Point & Fix, when offered, names the image's
 * source for the Agent told; the card's author is offered first.
 * Without an attachment it opens nothing.
 */
export function useKeptImagePreview(
  projectId: string,
  section: Section,
  attachment: SectionAttachment | undefined,
  caption: string | undefined,
): { open: () => void; dialog: ReactNode } {
  const time = useTimeDisplay();
  const t = useStrings(briefText);
  const markUp = usePointFix();
  const [shown, setShown] = useState<Shown | null>(null);
  if (!attachment) return { open: () => {}, dialog: null };
  const url = attachmentUrl(projectId, section.key, attachment.name, section.version);
  const open = () =>
    setShown({ url, version: section.version, takenAt: attachment.takenAt, title: section.title, ownerId: section.owner.agentId });
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
  const dialog = (
    <ImagePreview
      open={!!shown}
      src={shown?.url ?? ""}
      name={attachment.name}
      // Its caption is the title; the file, its size and when it was taken follow (T-20).
      caption={caption || undefined}
      description={t.imageSnapshot("", formatTime(shown?.takenAt ?? attachment.takenAt, time))}
      unavailable={t.imageUnavailable}
      onClose={() => setShown(null)}
      onAnnotate={markUp && shown ? () => {
        const at = shown;
        setShown(null);
        markUp(source(at));
      } : undefined}
    />
  );
  return { open, dialog };
}

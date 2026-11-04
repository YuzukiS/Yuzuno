import { useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { useSurfaceIn } from "../../surface";

/** Snapshots this window has shown, decoded, so one shown again (Show all,
 * Home opened again, its card after its report page) is there at once rather
 * than coming in a second time. */
const shownHere = new Set<string>();

/** The snapshot of a kept image (T-19 HM:B14, Lead 3619): this Workspace,
 * project, section (its key, and its id where Core gives one, so a section
 * written again under the same key is another), and the file kept (its name,
 * when it was taken, its size and type). A newer version of the card that
 * keeps it (a caption changed) is the same snapshot. */
export function keptSnapshot(parts: {
  workspaceId: string;
  projectId: string;
  sectionKey: string;
  sectionId: number | string | null | undefined;
  name: string;
  takenAt: string | null | undefined;
  size: number | null | undefined;
  mime: string | null | undefined;
}) {
  return [parts.workspaceId, parts.projectId, parts.sectionKey, parts.sectionId ?? "", parts.name, parts.takenAt,
    parts.size, parts.mime].join("\n");
}

/**
 * A kept image's arrival (T-19 HM:B14), for its report page and its card
 * alike. `read` is the snapshot, the card's version and the address read:
 * what a load or a decode says is taken only for the read it was started
 * for, and one that settles after the card has moved on changes nothing.
 *
 * Only a decode that succeeds shows the picture and marks the snapshot shown
 * here; the first time this window shows a snapshot, it fades in over small
 * (under reduced motion it is there at once). One that fails says so: the
 * caller shows its failed box. A picture already complete when drawn is
 * shown at once only for a snapshot this window has shown decoded; any other
 * waits for its decode the same way.
 */
export function useKeptImage(snapshot: string, read: string) {
  const current = useRef(read);
  current.current = read;
  // The snapshot whose picture is shown: a newer version of the card with
  // the same snapshot keeps it shown while that version's address loads.
  const [shown, setShown] = useState<string | null>(null);
  // The read that could not be loaded or decoded, so a newer one tries again.
  const [failed, setFailed] = useState<string | null>(null);
  const [arrivals, setArrivals] = useState(0);
  const picture = useRef<HTMLImageElement>(null);
  useSurfaceIn(picture, arrivals, "small", arrivals > 0);
  /** Shows the picture once `from`'s decode succeeds, or says it failed. */
  const settle = (from: string, img: HTMLImageElement) => {
    const decoded = img.decode ? img.decode() : Promise.resolve();
    decoded.then(
      () => {
        if (current.current !== from || !img.isConnected) return;
        setShown(snapshot);
        if (shownHere.has(snapshot)) return;
        shownHere.add(snapshot);
        setArrivals((n) => n + 1);
      },
      () => {
        if (current.current === from && img.isConnected) setFailed(from);
      },
    );
  };
  // One this window has shown decoded is there before the first paint; any
  // other already complete waits for its decode as a load does.
  useLayoutEffect(() => {
    const img = picture.current;
    if (!img?.complete || !img.naturalWidth) return;
    if (shownHere.has(snapshot)) setShown(snapshot);
    else settle(read, img);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  return {
    picture,
    /** Not yet decoded for this snapshot: kept unseen (`data-loading`). */
    loading: shown !== snapshot,
    /** This read could not be loaded or decoded. */
    failed: failed === read,
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => settle(read, event.currentTarget),
    onError: () => {
      const from = read;
      if (current.current === from) setFailed(from);
    },
  };
}

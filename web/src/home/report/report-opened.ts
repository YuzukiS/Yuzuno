import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api";
import { useDocumentVisible } from "../../document-visible";
import { readVersion } from "../brief-layout";
import type { Section } from "../types";

/** A live report the page has drawn whole, as it is on screen, and whose Home it is on. */
export type ShownReport = { workspaceId: string; projectId: string; section: Section };

/**
 * Sends the receipt that the report page showed a live report whole
 * (YN-86), once for each Workspace, project, section and version the page
 * shows: only while the page is visible, for a report the user has not read
 * at that version, with an id Core gave it. The caller passes it only once
 * the version is live on its own Workspace's Home and its body has drawn;
 * nothing is sent on the press that opened it. A send that fails is not
 * tried again by this page, however often it draws: it says why, the card
 * stays marked as changed, and opening the report again tries again.
 * Returns that reason while this version is on screen.
 */
export function useOpenedReceipt(
  shown: ShownReport | null,
  send: ((projectId: string, section: Section) => Promise<void>) | undefined,
): string | null {
  const visible = useDocumentVisible();
  const target = useRef(shown);
  target.current = shown;
  const tried = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [failure, setFailure] = useState<{ key: string; reason: string } | null>(null);
  const section = shown?.section;
  const key =
    shown && section && typeof section.id === "number"
      ? JSON.stringify([shown.workspaceId, shown.projectId, section.id, section.key, section.version])
      : null;
  useEffect(() => {
    const now = target.current;
    if (!now || !key || !send || !visible) return;
    const { section } = now;
    if (section.kind !== "report" || section.history || (readVersion(section) ?? 0) >= section.version) return;
    if (tried.current.has(key)) return;
    tried.current.add(key);
    send(now.projectId, section).catch((error) => {
      if (alive.current) setFailure({ key, reason: errorText(error).replace(/^[a-z_]+:\s*/, "") });
    });
  }, [key, send, visible]);
  return failure && failure.key === key ? failure.reason : null;
}

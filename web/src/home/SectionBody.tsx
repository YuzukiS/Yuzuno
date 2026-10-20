import { useCallback } from "react";
import { BriefSectionBody } from "./brief/BriefSectionBody";
import type { BlockChanges } from "./brief/block-changes";
import { useHomeNavigation } from "./home-navigation";
import type { Section } from "./types";

/** A section's body (worker 4a's renderer), with Home's way to open what it references. */
export function SectionBody({
  section,
  projectId,
  changes,
}: {
  section: Section;
  projectId: string;
  changes?: BlockChanges | null;
}) {
  const navigate = useHomeNavigation();
  const openAgent = useCallback((agentId: string) => navigate({ kind: "agent", agentId }), [navigate]);
  const openMachine = useCallback(
    (machineId: string) => navigate({ kind: "machine", machineId }),
    [navigate],
  );
  return (
    <BriefSectionBody
      section={section}
      projectId={projectId}
      changes={changes}
      onOpenAgent={openAgent}
      onOpenMachine={openMachine}
    />
  );
}

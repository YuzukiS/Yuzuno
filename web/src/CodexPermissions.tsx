import type { AgentSettings, PermissionCatalog } from "./types";
import { ChoiceChips } from "./ChoiceChips";

const modes = [
  {
    id: "config",
    label: "Follow Codex config",
    description:
      "Uses this execution machine’s Codex configuration for each new turn. This does not edit your shared config file.",
  },
  {
    id: "ask",
    label: "Ask for approval",
    description:
      "Works inside the workspace and asks you to review actions that need additional permission.",
  },
  {
    id: "auto",
    label: "Approve for me",
    description:
      "Codex automatically reviews permission requests while keeping the workspace sandbox. It can deny actions; questions can still need your answer.",
  },
  {
    id: "full",
    label: "Full access",
    description:
      "Tools can access files and networks outside this workspace without permission prompts.",
  },
] as const;

export const permissionLabel = (id?: string | null) =>
  modes.find((mode) => mode.id === id)?.label;

export function CodexPermissions({
  settings,
  catalog,
  disabled,
  onChange,
}: {
  settings: AgentSettings;
  catalog?: PermissionCatalog;
  disabled: boolean;
  onChange: (settings: AgentSettings) => void;
}) {
  const mode =
    settings.permissionPreset ||
    (settings.approvalPolicy === "on-request" &&
    settings.sandbox === "workspace-write"
      ? "ask"
      : settings.approvalPolicy === "never" &&
          settings.sandbox === "danger-full-access"
        ? "full"
        : "legacy");
  const option = catalog?.presets.find((p) => p.id === mode);
  const resolved = option?.permissions;
  const reviewer =
    resolved?.approvalPolicy === "never"
      ? "No approval prompts"
      : ["auto_review", "guardian_subagent"].includes(
            resolved?.approvalsReviewer || "",
          )
        ? "Automatic review"
        : "You review requests";
  const access =
    resolved?.profile ||
    (
      {
        "workspace-write": "Workspace files",
        "read-only": "Read only",
        "danger-full-access": "Full filesystem and network access",
      } as Record<string, string>
    )[resolved?.sandbox || ""];
  return (
    <div className="codex-permissions">
      <ChoiceChips
        label="Permissions"
        name="codex-permissions"
        value={mode}
        disabled={disabled}
        onChange={(value) => {
          const preset = value as NonNullable<AgentSettings["permissionPreset"]>;
          onChange({
            ...settings,
            permissionPreset: preset,
            ...(preset === "config"
              ? {}
              : {
                  approvalPolicy: preset === "full" ? "never" : "on-request",
                  sandbox:
                    preset === "full"
                      ? "danger-full-access"
                      : "workspace-write",
                }),
          });
        }}
        choices={[
          ...(mode === "legacy"
            ? [
                {
                  value: "legacy",
                  label: "Custom",
                  note: "existing settings",
                  disabled: true,
                },
              ]
            : []),
          ...modes.map(({ id, label }) => {
            const choice = catalog?.presets.find((p) => p.id === id);
            return {
              value: id,
              label,
              disabled: !choice?.available,
              note: choice && !choice.available ? "unavailable" : undefined,
            };
          }),
        ]}
      />
      <small>
        {modes.find((m) => m.id === mode)?.description ||
          "Existing custom permissions are preserved. Choose a mode to replace them."}
      </small>
      {resolved && (
        <small className="permission-preview">
          Next turn: {reviewer} · {access}
        </small>
      )}
      {option && !option.available && (
        <small role="status">{option.reason}</small>
      )}
      {!disabled && !catalog && (
        <small role="status">
          Permission options could not be loaded. Reopen settings to retry.
        </small>
      )}
    </div>
  );
}

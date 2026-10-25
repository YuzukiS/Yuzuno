import type { AgentSettings, PermissionCatalog } from "./types";
import { ChoiceChips } from "./ChoiceChips";
import { strings, type Language } from "./i18n";

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

// The control's own words (T-189), for a caller that translates it; the
// labels above stay the English ones `permissionLabel` names.
const text = strings({
  modes: Object.fromEntries(modes.map(({ id, label, description }) => [id, { label, description }])) as Record<
    (typeof modes)[number]["id"], { label: string; description: string }
  >,
  noPrompts: "No approval prompts",
  autoReview: "Automatic review",
  youReview: "You review requests",
  access: { "workspace-write": "Workspace files", "read-only": "Read only", "danger-full-access": "Full filesystem and network access" } as Record<string, string>,
  permissions: "Permissions",
  custom: "Custom",
  existing: "existing settings",
  unavailable: "unavailable",
  preserved: "Existing custom permissions are preserved. Choose a mode to replace them.",
  nextTurn: (reviewer: string, access: string | undefined) => `Next turn: ${reviewer} · ${access ?? ""}`,
  notLoaded: "Permission options could not be loaded. Reopen settings to retry.",
}, {
  modes: {
    config: { label: "遵循 Codex 配置", description: "每个新 Turn 都使用此执行机器上的 Codex 配置。这不会修改你的共享配置文件。" },
    ask: { label: "请求审批", description: "在工作区内工作，需要额外权限的操作会请你审查。" },
    auto: { label: "替我审批", description: "Codex 会在保持工作区沙箱的同时自动审查权限请求。它可能拒绝操作；问题仍可能需要你回答。" },
    full: { label: "完全访问", description: "工具无需权限提示即可访问此工作区之外的文件和网络。" },
  },
  noPrompts: "无审批提示",
  autoReview: "自动审查",
  youReview: "由你审查请求",
  access: { "workspace-write": "工作区文件", "read-only": "只读", "danger-full-access": "完全的文件系统与网络访问" },
  permissions: "权限",
  custom: "自定义",
  existing: "现有设置",
  unavailable: "不可用",
  preserved: "现有的自定义权限会保留。选择一种模式即可替换。",
  nextTurn: (reviewer, access) => `下一个 Turn：${reviewer} · ${access ?? ""}`,
  notLoaded: "无法载入权限选项。请重新打开设置以重试。",
});

export function CodexPermissions({
  settings,
  catalog,
  disabled,
  onChange,
  language = "en",
}: {
  settings: AgentSettings;
  catalog?: PermissionCatalog;
  disabled: boolean;
  onChange: (settings: AgentSettings) => void;
  /** The language of its own words; English where the dialog around it is. */
  language?: Language;
}) {
  const t = text(language);
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
      ? t.noPrompts
      : ["auto_review", "guardian_subagent"].includes(
            resolved?.approvalsReviewer || "",
          )
        ? t.autoReview
        : t.youReview;
  const access = resolved?.profile || t.access[resolved?.sandbox || ""];
  return (
    <div className="codex-permissions">
      <ChoiceChips
        label={t.permissions}
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
                  label: t.custom,
                  note: t.existing,
                  disabled: true,
                },
              ]
            : []),
          ...modes.map(({ id }) => {
            const choice = catalog?.presets.find((p) => p.id === id);
            return {
              value: id,
              label: t.modes[id].label,
              disabled: !choice?.available,
              note: choice && !choice.available ? t.unavailable : undefined,
            };
          }),
        ]}
      />
      <small>
        {(mode in t.modes && t.modes[mode as keyof typeof t.modes].description) || t.preserved}
      </small>
      {resolved && (
        <small className="permission-preview">
          {t.nextTurn(reviewer, access)}
        </small>
      )}
      {option && !option.available && (
        <small role="status">{option.reason}</small>
      )}
      {!disabled && !catalog && (
        <small role="status">{t.notLoaded}</small>
      )}
    </div>
  );
}

import { useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  CircleMinus,
  Clock3,
  Inbox,
  LoaderCircle,
  MessageSquare,
  XCircle,
} from "lucide-react";
import { api, errorText } from "./api";
import { openJobs } from "./Jobs";
import { langTag, strings, useLanguage } from "./i18n";

export interface MailboxGroup {
  kind: "peer" | "job" | "ci" | "review" | "pr" | "system" | "workspace";
  status: string;
  name?: string | null;
  count: number;
}
export interface MailboxSnapshot {
  version: number;
  priority?: "normal" | "urgent" | null;
  recipientId?: string;
  afterSeq?: number;
  throughSeq?: number;
  messageCount?: number;
  count?: number;
  groups?: MailboxGroup[];
  remainingCount?: number;
  /** The delivery's own messages (the first fifty); older notices lack it. */
  memberSeqs?: number[];
}

const jobResults: Record<string, string> = {
  waiting_analysis: "awaiting analysis",
  succeeded: "passed",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed out",
  oom: "out of memory",
  interrupted: "interrupted",
  rejected: "rejected",
  unknown: "result unknown",
};
const ciResults: Record<string, string> = {
  passed: "passed",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  pending: "pending",
  unknown: "result unknown",
};
// The PR flow (mailbox_notice.rs): a review is told by its conclusion, a
// PR operation by what it did.
const reviewResults: Record<string, string> = {
  no_findings: "no findings",
  approved_with_notes: "passed with suggestions",
  changes_requested: "changes requested",
  failed: "failed",
  cancelled: "cancelled",
  unknown: "no conclusion",
};
const prResults: Record<string, string> = {
  created: "created",
  updated: "updated",
  completed: "done",
  failed: "failed",
  needs_selection: "needs a choice",
  unknown: "result unknown",
};
/** A group's line in English, as Core's doorbell words it. */
function labelEn(group: MailboxGroup) {
  const count = group.count > 1 ? `${group.count} ` : "";
  if (group.kind === "peer")
    return `${count}Peer message${group.count > 1 ? "s" : ""}`;
  if (group.kind === "job")
    return `${count}Job${group.count > 1 ? "s" : ""} ${jobResults[group.status] ?? "result unknown"}`;
  if (group.kind === "ci")
    return `${count}CI ${ciResults[group.status] ?? "result unknown"}`;
  if (group.kind === "review")
    return `${count}Code review${group.count > 1 ? "s" : ""}: ${reviewResults[group.status] ?? "no conclusion"}`;
  if (group.kind === "pr") {
    const result = prResults[group.status] ?? "result unknown";
    if (group.count > 1) return `${count}PR operations ${result}`;
    return ["created", "updated"].includes(group.status) ? `PR ${result}` : `PR operation ${result}`;
  }
  return `${count}${group.kind === "system" ? "System" : "Workspace mail"}`;
}
// In Chinese (T-189); a status Core sends that isn't listed is "结果未知".
const jobResultsZh: Record<string, string> = {
  waiting_analysis: "等待分析", succeeded: "通过", failed: "失败", cancelled: "已取消", timed_out: "超时",
  oom: "内存不足", interrupted: "已中断", rejected: "已拒绝", unknown: "结果未知",
};
const ciResultsZh: Record<string, string> = {
  passed: "通过", failed: "失败", cancelled: "已取消", skipped: "已跳过", pending: "等待中", unknown: "结果未知",
};
const reviewResultsZh: Record<string, string> = {
  no_findings: "无发现", approved_with_notes: "通过，有建议", changes_requested: "要求修改",
  failed: "失败", cancelled: "已取消", unknown: "无结论",
};
const prResultsZh: Record<string, string> = {
  created: "已创建", updated: "已更新", completed: "已完成", failed: "失败", needs_selection: "需要选择", unknown: "结果未知",
};
function labelZh(group: MailboxGroup) {
  const many = group.count > 1;
  if (group.kind === "peer") return `${many ? `${group.count} 条` : ""}协作消息`;
  if (group.kind === "job") return `${many ? `${group.count} 个 ` : ""}Job ${jobResultsZh[group.status] ?? "结果未知"}`;
  if (group.kind === "ci") return `${many ? `${group.count} 个 ` : ""}CI ${ciResultsZh[group.status] ?? "结果未知"}`;
  if (group.kind === "review") return `${many ? `${group.count} 次` : ""}代码审查：${reviewResultsZh[group.status] ?? "无结论"}`;
  if (group.kind === "pr") {
    const result = prResultsZh[group.status] ?? "结果未知";
    if (many) return `${group.count} 个 PR 操作${result}`;
    return ["created", "updated"].includes(group.status) ? `PR ${result}` : `PR 操作${result}`;
  }
  return `${many ? `${group.count} 封` : ""}${group.kind === "system" ? "系统邮件" : "工作区邮件"}`;
}

// The notice's own words (T-189). Names, task IDs, message bodies and the
// note Core wrote to the Agent are shown as they came.
const noticeText = strings({
  label: labelEn,
  you: "You",
  urgent: "Urgent",
  moreCount: (count: number) => `+${count} more`,
  moreResults: (count: number) => `${count} more results`,
  older: "Older deliveries do not record which messages they carried; Tasks & messages has the full mailbox.",
  loading: "Loading these messages…",
  couldNotLoad: (error: string) => `Could not load these messages: ${error}`,
  tryAgain: "Try again",
  openReview: "Open review",
  gone: "These messages are no longer in the mailbox.",
  more: "More messages from this delivery are in Tasks & messages.",
  note: "Delivery note sent to the Agent",
  range: (count: number | "", after: number | undefined, through: number | undefined, grouped: boolean) =>
    `${count} message${count === 1 ? "" : "s"} · sequences after ${after ?? ""} through ${through ?? ""}${grouped ? " · repeated results grouped" : ""}`,
}, {
  label: labelZh,
  you: "你",
  urgent: "紧急",
  moreCount: (count) => `+${count} 项`,
  moreResults: (count) => `另有 ${count} 个结果`,
  older: "较早的投递没有记录它们携带了哪些消息；完整的邮箱见“任务与消息”。",
  loading: "正在载入这些消息…",
  couldNotLoad: (error) => `无法载入这些消息：${error}`,
  tryAgain: "重试",
  openReview: "打开审查",
  gone: "这些消息已不在邮箱中。",
  more: "此次投递的更多消息在“任务与消息”中。",
  note: "发给 Agent 的投递说明",
  range: (count, after, through, grouped) =>
    `${count} 条消息 · 序号 ${after ?? ""} 之后至 ${through ?? ""}${grouped ? " · 重复的结果已合并" : ""}`,
});
/** A message as peer_read returns it; only what a reader needs. */
interface MailMessage {
  id: string;
  seq: number;
  sender?: { kind?: string; name?: string | null } | null;
  body?: string;
  taskId?: string | null;
  createdAt?: string;
  /** Set by Core on its own review notifications. */
  reviewId?: string | null;
  metadata?: {
    kind?: string;
    status?: string;
    name?: string | null;
    systemdResult?: string | null;
    conclusion?: string | null;
    action?: string | null;
    reviewId?: string | null;
  } | null;
}
type Mail =
  | { state: "idle" | "loading" }
  | { state: "error"; error: string }
  | { state: "loaded"; messages: MailMessage[]; more: boolean };

/** A Job, CI, review or PR result Core sent, read as the doorbell reads it
 * (mailbox_notice.rs). */
function messageResult(message: MailMessage): MailboxGroup | null {
  const meta = message.metadata;
  const kind = meta?.kind;
  if (
    message.sender?.kind !== "system" ||
    !meta ||
    (kind !== "job" && kind !== "ci" && kind !== "review" && kind !== "pr")
  )
    return null;
  let status = meta.status || "unknown";
  if (kind === "job" && status === "failed" && meta.systemdResult === "oom-kill") status = "oom";
  else if (kind === "job" && status === "failed" && meta.systemdResult === "timeout") status = "timed_out";
  else if (kind === "review" && status === "completed")
    status = ["no_findings", "approved_with_notes", "changes_requested"].includes(meta.conclusion || "") ? meta.conclusion! : "unknown";
  else if (kind === "pr" && status === "completed")
    status = meta.action === "create" ? "created" : meta.action === "update" ? "updated" : "completed";
  return { kind, status, name: meta.name, count: 1 };
}

/** The review a Core review result names: Core's own field, else the copy in
 * its metadata. */
const reviewOf = (message: MailMessage) =>
  message.reviewId || message.metadata?.reviewId || null;

function sender(message: MailMessage, you: string) {
  const from = message.sender;
  return (
    from?.name ||
    (from?.kind === "user" ? you : from?.kind === "system" ? "Yuzuno Core" : "Agent")
  );
}

function sentAt(createdAt?: string) {
  const date = createdAt ? new Date(createdAt) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
}

function resultStyle(group: MailboxGroup) {
  if (group.kind === "review" || group.kind === "pr") {
    if (["no_findings", "approved_with_notes", "created", "updated", "completed"].includes(group.status))
      return { tone: "success", Icon: CheckCircle2 };
    if (["changes_requested", "failed"].includes(group.status))
      return { tone: "failure", Icon: XCircle };
    if (group.status === "cancelled") return { tone: "neutral", Icon: CircleMinus };
    return { tone: "unknown", Icon: CircleHelp };
  }
  if (group.kind !== "job" && group.kind !== "ci")
    return {
      tone: "neutral",
      Icon: group.kind === "peer" ? MessageSquare : Inbox,
    };
  if (["passed", "succeeded"].includes(group.status))
    return { tone: "success", Icon: CheckCircle2 };
  if (["failed", "timed_out", "oom", "rejected"].includes(group.status))
    return { tone: "failure", Icon: XCircle };
  if (["cancelled", "skipped"].includes(group.status))
    return { tone: "neutral", Icon: CircleMinus };
  if (group.status === "pending") return { tone: "neutral", Icon: Clock3 };
  return { tone: "unknown", Icon: CircleHelp };
}

/** Core's immutable reservation projection. Closed, it never inspects prose
 * or fetches anything. Opened, it reads the messages the delivery carried
 * (by its recipient and sequence range, as you, which does not mark them read
 * for the Agent); the note Core wrote to the Agent stays one fold deeper. */
export function MailboxNotice({
  snapshot,
  text,
  time,
}: {
  snapshot?: MailboxSnapshot;
  text: string;
  time?: ReactNode;
}) {
  const groups =
    snapshot?.version === 1 && snapshot.groups?.length
      ? snapshot.groups.slice(0, 2)
      : [{ kind: "workspace", count: 1, status: "" } satisfies MailboxGroup];
  const language = useLanguage();
  const t = noticeText(language);
  // Normal is the usual case and says nothing; only urgency is shown.
  const urgent = snapshot?.priority === "urgent";
  const range =
    snapshot?.version === 1 &&
    snapshot.recipientId &&
    Number.isFinite(snapshot.afterSeq) &&
    Number.isFinite(snapshot.throughSeq)
      ? {
          agentId: snapshot.recipientId,
          afterSeq: snapshot.afterSeq as number,
          throughSeq: snapshot.throughSeq as number,
          priority: snapshot.priority ?? undefined,
        }
      : null;
  const [mail, setMail] = useState<Mail>({ state: "idle" });
  // The messages this delivery reserved, when Core named them. The sequence
  // range alone can also hold older mail that was delivered but never read.
  const members = (snapshot?.memberSeqs || []).filter((seq) => Number.isInteger(seq));
  const read = (afterSeq: number) =>
    api<{ messages: MailMessage[]; hasMore: boolean; nextAfterSeq?: number }>(
      "/collaboration/peer_read",
      {
        method: "POST",
        body: JSON.stringify({
          agentId: range!.agentId,
          afterSeq,
          limit: 50,
          ...(range!.priority ? { priority: range!.priority } : {}),
        }),
      },
    );
  async function load() {
    if (!range) return;
    setMail({ state: "loading" });
    try {
      if (members.length) {
        // Read from the first member to the last, keeping only members; a
        // few pages at most, since other mail can sit between them.
        const wanted = new Set(members);
        const last = Math.max(...members);
        const found: MailMessage[] = [];
        let after = Math.min(...members) - 1;
        for (let pages = 0; pages < 5; pages++) {
          const page = await read(after);
          found.push(...page.messages.filter((m) => wanted.has(m.seq)));
          const end = page.nextAfterSeq ?? page.messages.at(-1)?.seq;
          if (!page.hasMore || end === undefined || end >= last || found.length >= wanted.size) break;
          after = end;
        }
        setMail({
          state: "loaded",
          messages: found,
          more: found.length < (snapshot?.messageCount ?? members.length),
        });
        return;
      }
      const page = await read(range.afterSeq);
      const messages = page.messages.filter((m) => m.seq <= range.throughSeq);
      setMail({
        state: "loaded",
        messages,
        more: page.hasMore && messages.length === page.messages.length,
      });
    } catch (error) {
      setMail({ state: "error", error: errorText(error) });
    }
  }
  const remaining =
    snapshot?.version === 1 ? Math.max(0, snapshot.remainingCount ?? 0) : 0;
  const description = [
    ...groups.map((group) =>
      [group.name, t.label(group)].filter(Boolean).join(" · "),
    ),
    remaining ? t.moreCount(remaining) : null,
    urgent ? t.urgent : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <details
      className="mailbox-notice"
      lang={langTag(language)}
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open && mail.state === "idle")
          void load();
      }}
    >
      <summary aria-label={description}>
        <span className="mailbox-groups">
          {groups.map((group, i) => {
            const { tone, Icon } = resultStyle(group);
            return (
              <span className={`mailbox-group mailbox-${tone}`} key={i}>
                <Icon size={14} aria-hidden="true" />
                {group.name && (
                  <span className="mailbox-name" title={group.name}>
                    {group.name}
                  </span>
                )}
                <span className="mailbox-result">
                  {group.name && <span aria-hidden="true"> · </span>}
                  {t.label(group)}
                </span>
              </span>
            );
          })}
        </span>
        {remaining > 0 && (
          <span className="mailbox-more" title={t.moreResults(remaining)}>
            +{remaining}
          </span>
        )}
        {urgent && (
          <span className="mailbox-priority urgent">
            {t.urgent}
          </span>
        )}
        <span className="mailbox-time">{time}</span>
        <ChevronRight
          size={13}
          aria-hidden="true"
          className="mailbox-chevron"
        />
      </summary>
      <div className="mailbox-expanded">
        {/* The messages name themselves; without them, the full line
            stands in for names the summary had to cut. */}
        {!range && <div className="mailbox-full-summary">{description}</div>}
        {!range ? (
          <p className="mailbox-status">{t.older}</p>
        ) : mail.state === "loading" ? (
          <p className="mailbox-status">
            <LoaderCircle size={12} className="spin" aria-hidden="true" />
            {t.loading}
          </p>
        ) : mail.state === "error" ? (
          <p className="mailbox-status" role="alert">
            {t.couldNotLoad(mail.error)}
            <button type="button" className="inline-link" onClick={() => void load()}>
              {t.tryAgain}
            </button>
          </p>
        ) : mail.state === "loaded" ? (
          mail.messages.length ? (
            <ol className="mailbox-messages">
              {mail.messages.map((message) => {
                const result = messageResult(message);
                const look = result && resultStyle(result);
                const time = sentAt(message.createdAt);
                return (
                  <li className="mailbox-message" key={message.id}>
                    <div className="mailbox-message-head">
                      <strong lang="">{sender(message, t.you)}</strong>
                      {message.taskId && (
                        <span className="mailbox-message-task">{message.taskId}</span>
                      )}
                      {time && <time dateTime={message.createdAt}>{time}</time>}
                    </div>
                    {result && look ? (
                      <div className={`mailbox-message-result mailbox-${look.tone}`}>
                        <look.Icon size={14} aria-hidden="true" />
                        {[result.name, t.label(result)].filter(Boolean).join(" · ")}
                        {/* Core's own review result names its review: open it
                            in Jobs. Older or peer mail is never guessed at. */}
                        {result.kind === "review" && reviewOf(message) && message.taskId && (
                          <button
                            type="button"
                            className="quiet-button mailbox-open-review"
                            onClick={() =>
                              openJobs({
                                source: "reviews",
                                taskId: message.taskId!,
                                reviewId: reviewOf(message)!,
                              })
                            }
                          >
                            {t.openReview}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="mailbox-message-body" lang="">{message.body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="mailbox-status">{t.gone}</p>
          )
        ) : null}
        {mail.state === "loaded" && mail.more && (
          <p className="mailbox-status">{t.more}</p>
        )}
        <details className="mailbox-prompt">
          <summary>
            <ChevronRight size={12} aria-hidden="true" className="mailbox-prompt-chevron" />
            {t.note}
          </summary>
          {snapshot?.version === 1 && (
            <div className="mailbox-range">
              {t.range(snapshot.messageCount ?? "", snapshot.afterSeq, snapshot.throughSeq,
                (snapshot.messageCount ?? 0) > (snapshot.count ?? 0))}
            </div>
          )}
          <div className="user-text" lang="">{text}</div>
        </details>
      </div>
    </details>
  );
}

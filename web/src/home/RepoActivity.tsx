/**
 * Recent activity of a Project's linked GitHub repositories: default-branch
 * commits, open PRs and Actions runs. Core reads GitHub with its own gh and
 * caches each repository (GET /api/projects/{id}/repo-activity); Home asks
 * only while this block is on screen, apart from /api/home. A repository
 * whose read failed shows its last known data with a muted line saying so.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { api, errorText } from "../api";
import { sourceTarget } from "../intelligent-ui/contract.ts";
import { absolute, relative } from "./format";
import { useTimeDisplay } from "../time-preferences";
import { useLanguage, type Language } from "../i18n";
import { homeText } from "./home-text";
import "./repo-activity.css";

export type RepoCommit = {
  sha: string;
  title: string;
  author: string | null;
  at: string | null;
  url: string;
};
export type RepoPull = {
  number: number;
  title: string;
  author: string | null;
  url: string;
  draft: boolean;
  /** GitHub's check rollup for the PR's current head; absent when unknown. */
  ci?: { state: "success" | "failure" | "pending" };
};
export type RepoRun = {
  id: number;
  name: string;
  branch: string | null;
  /** GitHub's own words, e.g. completed / in_progress, success / failure. */
  status: string;
  conclusion: string | null;
  at: string | null;
  url: string;
};
export type RepoActivityRepository = {
  id: number;
  fullName: string;
  url: string;
  defaultBranch?: string;
  /** When Core read the data shown; null when it never could. */
  observedAt: string | null;
  commits: RepoCommit[];
  pulls: RepoPull[];
  /** All open PRs, of which `pulls` shows the most recently updated. */
  pullsTotal?: number | null;
  runs: RepoRun[];
  error?: string;
  /** The data is not from a fresh read: the last good answer is kept. */
  stale: boolean;
};
export type RepoActivityPage = { observedAt: string; repositories: RepoActivityRepository[] };

/** Core answered without the activity list: worded when shown. */
const NO_ACTIVITY = Symbol("no repository activity");

/** Core answers from its cache; this only decides how often Home asks. */
export const REFRESH_MS = 120_000;

export const readRepoActivity = (projectId: string, signal?: AbortSignal) =>
  api<RepoActivityPage>(`/projects/${encodeURIComponent(projectId)}/repo-activity`, { signal });

/** A GitHub page, by the same rule as result sources; anything else is not a link. */
function githubPage(href: string): string | undefined {
  const target = sourceTarget(href);
  if (target?.kind !== "web") return undefined;
  const url = new URL(target.path);
  return url.protocol === "https:" && url.hostname === "github.com" ? url.href : undefined;
}

/** On screen in a visible page. Without IntersectionObserver it counts as on screen. */
function useOnScreen(ref: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let inView = typeof IntersectionObserver === "undefined";
    const update = () => setVisible(inView && document.visibilityState !== "hidden");
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            inView = entries[entries.length - 1].isIntersecting;
            update();
          });
    observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref]);
  return visible;
}

type Tone = "ok" | "active" | "attention" | "neutral";
const pullCi: Record<string, { tone: Tone; icon: LucideIcon }> = {
  success: { tone: "ok", icon: CircleCheck },
  failure: { tone: "attention", icon: CircleX },
  pending: { tone: "active", icon: CircleDot },
};
type RunWord = keyof ReturnType<typeof homeText>["run"];
/** GitHub's status and conclusion as one word; unknown words stay unknown. */
function runState(run: RepoRun): { word: RunWord; tone: Tone; icon: LucideIcon } {
  if (run.status !== "completed") {
    if (run.status === "in_progress") return { word: "running", tone: "active", icon: LoaderCircle };
    if (["queued", "waiting", "pending", "requested"].includes(run.status))
      return { word: "queued", tone: "active", icon: CircleDashed };
    return { word: "unknown", tone: "neutral", icon: CircleDashed };
  }
  switch (run.conclusion) {
    case "success":
      return { word: "passed", tone: "ok", icon: CircleCheck };
    case "failure":
    case "timed_out":
    case "startup_failure":
      return { word: "failed", tone: "attention", icon: CircleX };
    case "action_required":
      return { word: "action", tone: "attention", icon: CircleAlert };
    case "cancelled":
      return { word: "cancelled", tone: "neutral", icon: CircleMinus };
    case "skipped":
    case "neutral":
      return { word: "skipped", tone: "neutral", icon: CircleMinus };
    default:
      return { word: "unknown", tone: "neutral", icon: CircleDashed };
  }
}

/** One line; the whole line opens GitHub when its link is safe. */
function Row({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  const safe = githubPage(href);
  return safe ? (
    <a className="repo-row" href={safe} target="_blank" rel="noopener noreferrer" title={label}>
      {children}
    </a>
  ) : (
    <span className="repo-row" title={label}>
      {children}
    </span>
  );
}

const when = (at: string | null, language: Language) => relative(at, language) || homeText(language).timeUnknown;

function Lists({ repo }: { repo: RepoActivityRepository }) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  const branch = repo.defaultBranch ? t.onBranch(repo.defaultBranch) : "";
  const open = repo.pullsTotal ?? repo.pulls.length;
  return (
    <div className="repo-activity-lists">
      <section aria-label={`${t.commits}${branch}`}>
        <h5>
          <GitCommitHorizontal size={12} aria-hidden /> {t.commits}
        </h5>
        <ul>
          {repo.commits.length === 0 && <li className="repo-empty">{t.noCommits}</li>}
          {repo.commits.map((commit) => (
            <li key={commit.sha}>
              <Row
                href={commit.url}
                label={`${commit.sha.slice(0, 7)} ${commit.title} · ${commit.author || t.unknownAuthor} · ${absolute(commit.at, time)}`}
              >
                <code>{commit.sha.slice(0, 7)}</code>
                <span className="repo-row-title">{commit.title}</span>
                <small>
                  {commit.author || t.unknown} · {when(commit.at, language)}
                </small>
              </Row>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={t.openPulls}>
        <h5>
          <GitPullRequest size={12} aria-hidden /> {t.pulls}
          {open > 0 && <span className="repo-count">{t.openCount(open)}</span>}
        </h5>
        <ul>
          {repo.pulls.length === 0 && <li className="repo-empty">{t.noPulls}</li>}
          {repo.pulls.map((pull) => {
            const ci = pull.ci && pullCi[pull.ci.state] ? { ...pullCi[pull.ci.state], label: t.checks[pull.ci.state] } : undefined;
            const CiIcon = ci?.icon;
            return (
              <li key={pull.number}>
                <Row
                  href={pull.url}
                  label={`#${pull.number} ${pull.title} · ${pull.author || t.unknownAuthor}${pull.draft ? ` · ${t.draft}` : ""} · ${ci?.label || t.checksUnknown}`}
                >
                  <code>#{pull.number}</code>
                  {pull.draft && <span className="repo-draft">{t.draft}</span>}
                  <span className="repo-row-title">{pull.title}</span>
                  <small>{pull.author || t.unknown}</small>
                  {ci && CiIcon && (
                    <span className={`repo-state is-${ci.tone}`} role="img" aria-label={ci.label}>
                      <CiIcon size={11} aria-hidden />
                    </span>
                  )}
                </Row>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label={t.actionsRuns}>
        <h5>
          <Workflow size={12} aria-hidden /> Actions
        </h5>
        <ul>
          {repo.runs.length === 0 && <li className="repo-empty">{t.noRuns}</li>}
          {repo.runs.map((run) => {
            const found = runState(run);
            const state = { ...found, label: t.run[found.word] };
            const Icon = state.icon;
            return (
              <li key={run.id}>
                <Row
                  href={run.url}
                  label={`${run.name} · ${run.branch || t.noBranch} · ${state.label} · ${absolute(run.at, time)}`}
                >
                  <span className={`repo-state is-${state.tone}`}>
                    <Icon size={11} aria-hidden /> {state.label}
                  </span>
                  <span className="repo-row-title">{run.name}</span>
                  <small>
                    {run.branch ? `${run.branch} · ` : ""}
                    {when(run.at, language)}
                  </small>
                </Row>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** While nothing is known yet: the same frame, so arriving data does not move anything. */
function Placeholder() {
  const t = homeText(useLanguage());
  return (
    <div className="repo-activity-lists" aria-hidden>
      {[t.commits, t.pulls, "Actions"].map((name) => (
        <section key={name}>
          <h5>{name}</h5>
          <ul>
            {[0, 1, 2].map((i) => (
              <li key={i} className="repo-skeleton">
                <span />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Head({ name, url, branch, observedAt }: { name: string; url: string; branch?: string; observedAt?: string | null }) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  const href = githubPage(url);
  return (
    <header>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="repo-name">
          {name}
          <ArrowUpRight size={11} aria-hidden />
        </a>
      ) : (
        <span className="repo-name">{name}</span>
      )}
      {branch && <code className="repo-branch">{branch}</code>}
      {observedAt !== undefined && (
        <small className="repo-asof" title={absolute(observedAt, time)}>
          {observedAt ? t.asOf(relative(observedAt, language)) : t.notRead}
        </small>
      )}
    </header>
  );
}

/** The muted line under a repository that is not freshly read. */
function Problem({ lead, text }: { lead: string; text: string }) {
  return (
    <p className="repo-activity-problem" title={`${lead} · ${text}`}>
      <CircleAlert size={11} aria-hidden /> {lead} · {text}
    </p>
  );
}

export function RepoActivity({
  projectId,
  linked,
}: {
  projectId: string;
  /** The linked repositories as already known, to hold their place while loading. */
  linked?: { id: number; fullName: string; url: string }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useOnScreen(ref);
  const t = homeText(useLanguage());
  const [page, setPage] = useState<RepoActivityPage | null>(null);
  // Core's reason, or null; NO_ACTIVITY is worded when shown (T-189).
  const [failed, setFailed] = useState<string | typeof NO_ACTIVITY>("");
  const readAt = useRef(0);
  useEffect(() => {
    setPage(null);
    setFailed("");
    readAt.current = 0;
  }, [projectId]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer = 0;
    let reading = false;
    const load = () => {
      reading = true;
      readAt.current = Date.now();
      readRepoActivity(projectId, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          if (!Array.isArray(value?.repositories)) {
            setFailed(NO_ACTIVITY);
            return;
          }
          setPage(value);
          setFailed("");
        })
        .catch((error) => {
          if (!controller.signal.aborted) setFailed(errorText(error));
        })
        .finally(() => {
          reading = false;
          if (!controller.signal.aborted) timer = window.setTimeout(load, REFRESH_MS);
        });
    };
    // Back on screen: ask again only when the last answer is due.
    timer = window.setTimeout(load, Math.max(0, readAt.current + REFRESH_MS - Date.now()));
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      // An answer cut off by leaving the screen is asked again on return.
      if (reading) readAt.current = 0;
    };
  }, [visible, projectId]);

  if (page && page.repositories.length === 0) return null;
  const failure = failed === NO_ACTIVITY ? t.noActivity : failed;
  return (
    <div ref={ref} className="repo-activity" aria-busy={!page && !failed}>
      {page
        ? page.repositories.map((repo) => {
            const problem = (repo.stale && (repo.error || t.notRefreshed)) || failure;
            return (
              <article key={repo.id} className="repo-activity-repo" data-repo={repo.fullName}>
                <Head name={repo.fullName} url={repo.url} branch={repo.defaultBranch} observedAt={repo.observedAt} />
                {problem && <Problem lead={t.lastKnown} text={problem} />}
                <Lists repo={repo} />
              </article>
            );
          })
        : (linked?.length ? linked : [{ id: 0, fullName: t.repository, url: "" }]).map((repo) => (
            <article key={repo.id} className={`repo-activity-repo${failure ? "" : " is-loading"}`}>
              <Head name={repo.fullName} url={repo.url} />
              {failure && <Problem lead={t.activityUnavailable} text={failure} />}
              <Placeholder />
            </article>
          ))}
    </div>
  );
}

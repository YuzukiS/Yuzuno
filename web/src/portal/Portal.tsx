import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, ChevronLeft, FileCode2, Globe, LoaderCircle, RotateCw, Shield, X } from "lucide-react";
import { api, errorText, post } from "../api";
import { langTag, strings, useLanguage } from "../i18n";
import { openJobs } from "../Jobs";
import type { ProjectService } from "../ProjectServices";
import { savedPortalWidth, savePortalWidth } from "./portal-preference";
import {
  closePortal,
  loopbackPage,
  mintPreview,
  onPortalMount,
  openOutside,
  reaches,
  usePortal,
  type Minted,
  type PortalTarget,
} from "./portal-state";
import "./portal.css";

// The Portal's own words (T-189); names, paths and addresses as they are.
const text = strings({
  close: "Close preview",
  back: "Back to the conversation",
  inBrowser: "Open in browser",
  reload: "Reload",
  resize: "Drag to resize",
  isolated: "Isolated preview: this file's scripts can't read Yuzuno or its data. It isn't cut off from the network: like any web page, it can still go to another address.",
  snapshotAt: (from: string, at: string) => `${from} · snapshot ${at}`,
  preparing: "Preparing the preview…",
  unreachableHere: "This computer doesn't reach Core's preview port. It opens on the Core host itself, or on a computer whose tunnel to Core forwards Core's service ports too.",
  unreachableRemote: "Isolated previews don't open through this connection: Core's preview port isn't reachable from here. They open on the Core host, or on a computer with a tunnel to Core.",
  failed: (reason: string) => `This file can't be previewed: ${reason}`,
  movedOn: "The page loaded something else, so it is no longer shown here.",
  backToSnapshot: "Back to the snapshot",
  blocked: "This service doesn't allow being shown inside Yuzuno",
  blockedNote: "It asks to be opened only as its own page; Yuzuno doesn't remove that.",
  maybeBlank: "If this stays blank, the service may not allow being shown here: open it in the browser.",
  service: "Project service",
  job: "Job",
  external: "External service",
  externalTag: "Not started by Yuzuno",
  neverStops: "Yuzuno doesn't stop this service",
  process: "Process",
  page: "Page",
  health: "Health check",
  notSet: "Not set",
  linked: "Linked to this Job",
  otherProcess: "Another program answers on its port",
  notListening: "This Job doesn't listen on the port yet",
  reachable: "Reachable",
  notReachable: "Not reachable",
  disconnect: "Disconnect",
  disconnected: "Disconnected. The service itself keeps running.",
  logs: "Logs",
  inJobs: "Open in Jobs",
  stop: "Stop Job…",
  stopConfirm: "Stop the Job",
  stopCancel: "Keep it",
  stopNote: "Stopping ends this Job's process; the preview closes its page.",
  jobStates: {
    queued: "Queued", waiting: "Waiting", running: "Running", succeeded: "Ended", failed: "Failed",
    cancelled: "Stopped", interrupted: "Interrupted", unknown: "Unknown",
  } as Record<string, string>,
  healthStates: { ok: "Healthy", failing: "Failing", unknown: "Unknown" } as Record<string, string>,
}, {
  close: "关闭预览",
  back: "返回会话",
  inBrowser: "在浏览器打开",
  reload: "重新载入",
  resize: "拖动调整宽度",
  isolated: "隔离预览：文件里的脚本读不到 Yuzuno 及其数据。但它没有断网：和普通网页一样，仍可以跳到别的地址。",
  snapshotAt: (from, at) => `${from} · 快照 ${at}`,
  preparing: "正在准备预览…",
  unreachableHere: "这台电脑访问不到 Core 的预览端口。在 Core 主机上可以直接打开；从另一台电脑打开时，它通往 Core 的隧道也要转发 Core 的服务端口。",
  unreachableRemote: "通过此连接无法打开隔离预览：从这里访问不到 Core 的预览端口。请在 Core 主机上，或在有通往 Core 隧道的电脑上打开。",
  failed: (reason) => `这个文件无法预览：${reason}`,
  movedOn: "页面加载了别的内容，这里不再显示。",
  backToSnapshot: "回到快照",
  blocked: "这个服务不允许在 Yuzuno 内显示",
  blockedNote: "它要求只在自己的页面里打开，Yuzuno 不会去掉这个限制。",
  maybeBlank: "如果一直空白，可能是这个服务不允许在这里显示：请在浏览器打开。",
  service: "项目服务",
  job: "Job",
  external: "外部服务",
  externalTag: "不是 Yuzuno 启动的",
  neverStops: "Yuzuno 不会停止这个服务",
  process: "进程",
  page: "页面",
  health: "健康检查",
  notSet: "未设置",
  linked: "关联此 Job",
  otherProcess: "端口上是别的程序",
  notListening: "此 Job 还没有在端口上监听",
  reachable: "可访问",
  notReachable: "无法访问",
  disconnect: "断开连接",
  disconnected: "已断开连接。服务本身继续运行。",
  logs: "日志",
  inJobs: "在 Job 中查看",
  stop: "停止 Job…",
  stopConfirm: "停止这个 Job",
  stopCancel: "保留",
  stopNote: "停止会结束这个 Job 的进程；预览里的页面也会断开。",
  jobStates: {
    queued: "排队中", waiting: "等待中", running: "运行中", succeeded: "已结束", failed: "失败",
    cancelled: "已停止", interrupted: "已中断", unknown: "未知",
  },
  healthStates: { ok: "正常", failing: "异常", unknown: "未知" },
});

/** The chat keeps at least this much beside the Portal; the Portal at least this. */
const MIN_CHAT = 320;
const MIN_PORTAL = 360;
/** The app's toolbar and status bar (styles.css), which the side panel leaves. */
const TOOLBAR = 57;
const STATUS_BAR = 27;

let root: ReturnType<typeof createRoot> | null = null;
onPortalMount(() => {
  if (root) return;
  const element = document.createElement("div");
  element.id = "yuzuno-portal";
  document.body.append(element);
  root = createRoot(element);
  root.render(<PortalHost />);
});

type Layout = { mode: "side"; width: number; rail: number } | { mode: "full" };
/** Side by side when the window leaves the chat its minimum; else full screen. */
function layout(dragged: number | null): Layout {
  const app = document.querySelector<HTMLElement>(".app");
  const phone = !app || app.classList.contains("phone") || window.innerWidth <= 720;
  const rail = app && !app.classList.contains("rail-hidden") ? app.querySelector<HTMLElement>(":scope > .rail")?.getBoundingClientRect().width ?? 0 : 0;
  const content = window.innerWidth - rail;
  if (phone || content - MIN_CHAT < MIN_PORTAL) return { mode: "full" };
  const width = Math.round(Math.min(content - MIN_CHAT, Math.max(MIN_PORTAL, dragged ?? (content * 2) / 3)));
  return { mode: "side", width, rail: Math.round(rail) };
}

/** The app's grid gives the Portal its column; nothing else of the app moves. */
function apply(shape: Layout | null) {
  const html = document.documentElement;
  if (!shape) {
    delete html.dataset.portal;
    html.style.removeProperty("--portal-width");
    html.style.removeProperty("--portal-columns");
    return;
  }
  html.dataset.portal = shape.mode;
  if (shape.mode === "side") {
    html.style.setProperty("--portal-width", `${shape.width}px`);
    html.style.setProperty("--portal-columns", `${shape.rail ? `${shape.rail}px ` : ""}minmax(0, 1fr) ${shape.width}px`);
  }
}

function PortalHost() {
  const shown = usePortal();
  const language = useLanguage();
  const t = text(language);
  const [dragged, setDragged] = useState<number | null>(() => savedPortalWidth());
  // The width keys last set, before React draws it: held keys repeat faster than that.
  const latest = useRef<number | null>(dragged);
  latest.current = dragged;
  const [shape, setShape] = useState<Layout | null>(null);
  const panel = useRef<HTMLElement>(null);
  const relayout = useCallback(() => setShape(shown ? layout(dragged) : null), [shown, dragged]);
  useLayoutEffect(() => {
    relayout();
  }, [relayout]);
  useLayoutEffect(() => {
    apply(shape);
  }, [shape]);
  useEffect(() => () => apply(null), []);
  useEffect(() => {
    if (!shown) return;
    window.addEventListener("resize", relayout);
    // The rail shown, hidden or resized, or the phone layout entered.
    const app = document.querySelector(".app");
    const watch = new MutationObserver(relayout);
    if (app) watch.observe(app, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      window.removeEventListener("resize", relayout);
      watch.disconnect();
    };
  }, [shown, relayout]);
  // A new page takes focus; Escape closes (unless a menu inside has it).
  useEffect(() => {
    if (shown) panel.current?.querySelector<HTMLElement>(".portal-title")?.focus({ preventScroll: true });
  }, [shown?.key]);
  if (!shown || !shape) return null;
  const full = shape.mode === "full";
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (shape.mode !== "side") return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = window.innerWidth;
    const move = (e: PointerEvent) => setDragged(right - e.clientX);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      setDragged((width) => {
        if (width !== null) savePortalWidth(width);
        return width;
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };
  return (
    <aside
      ref={panel}
      className={`portal-panel${full ? " is-full" : ""}`}
      role={full ? "dialog" : "complementary"}
      aria-modal={full || undefined}
      aria-label={shown.target.kind === "snapshot" ? shown.target.name : shown.target.service.name}
      lang={langTag(language)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          closePortal();
        }
      }}
      style={{ "--top": `${TOOLBAR}px`, "--bottom": `${STATUS_BAR}px` } as CSSProperties}
    >
      {!full && (
        <div
          className="portal-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label={t.resize}
          title={t.resize}
          tabIndex={0}
          aria-valuenow={shape.mode === "side" ? shape.width : undefined}
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setDragged(null);
            savePortalWidth(null);
          }}
          onKeyDown={(event) => {
            if (shape.mode !== "side" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
            event.preventDefault();
            // Within what the window allows: the chat keeps its minimum.
            const most = window.innerWidth - shape.rail - MIN_CHAT;
            const width = Math.min(most, Math.max(MIN_PORTAL, Math.min(latest.current ?? shape.width, most) + (event.key === "ArrowLeft" ? 32 : -32)));
            latest.current = width;
            setDragged(width);
            savePortalWidth(width);
          }}
        >
          <span />
        </div>
      )}
      <PortalBody key={shown.key} target={shown.target} full={full} />
    </aside>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function PortalBody({ target, full }: { target: PortalTarget; full: boolean }) {
  const t = text(useLanguage());
  const [reloads, setReloads] = useState(0);
  const [loads, setLoads] = useState(0);
  const [minted, setMinted] = useState<
    { state: "preparing" } | { state: "ready"; at: Minted } | { state: "unreachable" } | { state: "failed"; reason: string }
  >({ state: "preparing" });
  const [service, setService] = useState<ProjectService | null>(target.kind === "service" ? target.service : null);
  const [disconnected, setDisconnected] = useState(false);
  // A snapshot: Core keeps the file as it is now, then this browser proves
  // it reaches the previews' port before the page is shown.
  useEffect(() => {
    if (target.kind !== "snapshot") return;
    let current = true;
    setMinted({ state: "preparing" });
    (async () => {
      try {
        const at = await mintPreview(target.source);
        const proven = await reaches(at.proof.url, at.proof.answer);
        if (current) setMinted(proven ? { state: "ready", at } : { state: "unreachable" });
      } catch (error) {
        if (current) setMinted({ state: "failed", reason: errorText(error) });
      }
    })();
    return () => {
      current = false;
    };
  }, [target]);
  // A service: its Job and health as the services list has them now.
  useEffect(() => {
    if (target.kind !== "service") return;
    const path = `/projects/${encodeURIComponent(target.service.projectId)}/services`;
    let current = true;
    const read = () =>
      api<{ services?: ProjectService[] }>(path).then(
        (page) => {
          // A list without this service means it is gone; an odd answer changes nothing.
          if (current && Array.isArray(page.services)) setService(page.services.find((s) => s.id === target.service.id) ?? null);
        },
        () => {},
      );
    const timer = window.setInterval(() => document.visibilityState !== "hidden" && void read(), 5000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [target]);
  const browserUrl =
    target.kind === "service" ? target.url : minted.state === "ready" ? minted.at.url : null;
  const title = target.kind === "snapshot" ? target.name : target.service.name;
  const subtitle =
    target.kind === "snapshot"
      ? minted.state === "ready"
        ? t.snapshotAt(target.from, timeOf(minted.at.takenAt))
        : target.from
      : `${t.service} · ${target.where} · ${target.url.replace(/^http:\/\//, "").replace(/\/.*$/, "")}`;
  const framing = service?.connection.framing;
  const frameKey = `${reloads}`;
  return (
    <>
      <header className="portal-head">
        {full && (
          <button type="button" className="icon-button" aria-label={t.back} title={t.back} onClick={closePortal}>
            <ChevronLeft size={18} />
          </button>
        )}
        {!full && (
          <span className="portal-kind" aria-hidden="true">
            {target.kind === "snapshot" ? <FileCode2 size={16} /> : <Globe size={16} />}
          </span>
        )}
        <span className="portal-title" tabIndex={-1}>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        {browserUrl && (
          full ? (
            <button type="button" className="icon-button portal-box" aria-label={t.inBrowser} title={t.inBrowser} onClick={() => openOutside(browserUrl)}>
              <ArrowUpRight size={16} />
            </button>
          ) : (
            <button type="button" className="secondary-button portal-outside" onClick={() => openOutside(browserUrl)}>
              {t.inBrowser}
              <ArrowUpRight size={14} />
            </button>
          )
        )}
        {!full && (minted.state === "ready" || target.kind === "service") && (
          <button type="button" className="icon-button" aria-label={t.reload} title={t.reload} onClick={() => { setLoads(0); setReloads((n) => n + 1); }}>
            <RotateCw size={15} />
          </button>
        )}
        <button type="button" className="icon-button portal-box" aria-label={t.close} title={t.close} onClick={closePortal}>
          <X size={16} />
        </button>
      </header>
      {target.kind === "snapshot" && (
        <p className="portal-note">
          <Shield size={14} aria-hidden="true" />
          {t.isolated}
        </p>
      )}
      <div className="portal-stage">
        {target.kind === "snapshot" ? (
          minted.state === "ready" && loads > 1 ? (
            // Its first load is the snapshot; any later one is a page it went
            // to (or reloaded), which this frame no longer shows. A page can
            // leave before its first load ends, so this is not a guarantee.
            <div className="portal-state portal-moved" role="status">
              <p>{t.movedOn}</p>
              <button type="button" className="secondary-button" onClick={() => { setLoads(0); setReloads((n) => n + 1); }}>
                {t.backToSnapshot}
              </button>
            </div>
          ) : minted.state === "ready" ? (
            <iframe
              key={frameKey}
              className="portal-frame"
              title={target.name}
              src={minted.at.url}
              // Scripts only: no same-origin, forms, popups or top navigation.
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              allow=""
              onLoad={() => setLoads((n) => n + 1)}
            />
          ) : minted.state === "preparing" ? (
            <p className="portal-state" role="status"><LoaderCircle size={16} className="spin" /> {t.preparing}</p>
          ) : minted.state === "unreachable" ? (
            <p className="portal-state" role="alert">{loopbackPage() ? t.unreachableHere : t.unreachableRemote}</p>
          ) : (
            <p className="portal-state" role="alert">{t.failed(minted.reason)}</p>
          )
        ) : disconnected ? (
          <p className="portal-state" role="status">{t.disconnected}</p>
        ) : framing === "blocked" ? (
          <div className="portal-state portal-blocked">
            <strong>{t.blocked}</strong>
            <p>{t.blockedNote}</p>
            <button type="button" className="primary-button" onClick={() => openOutside(target.url)}>
              {t.inBrowser} <ArrowUpRight size={14} />
            </button>
          </div>
        ) : (
          <>
            {(framing === "restricted" || framing === "unknown") && <p className="portal-hint">{t.maybeBlank}</p>}
            <iframe
              key={frameKey}
              className="portal-frame"
              title={target.service.name}
              src={target.url}
              // Its own origin keeps its storage and sockets; it never moves this window.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
              referrerPolicy="no-referrer"
            />
          </>
        )}
      </div>
      {target.kind === "service" && service && (
        <ServiceJob service={service} disconnected={disconnected} onDisconnect={async () => {
          await post(`/services/${encodeURIComponent(service.id)}/close`);
          setDisconnected(true);
        }} />
      )}
    </>
  );
}

type JobLog = { text: string };

/** The service's way and, when a Yuzuno Job serves it, that Job: running,
 * reachable and healthy are three facts, never one guessed from another. */
function ServiceJob({ service, disconnected, onDisconnect }: { service: ProjectService; disconnected: boolean; onDisconnect: () => Promise<void> }) {
  const t = text(useLanguage());
  const [drawer, setDrawer] = useState<"logs" | null>(null);
  const [log, setLog] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const job = service.job;
  const c = service.connection;
  const reachable = c.state === "available";
  useEffect(() => {
    if (drawer !== "logs" || !job) return;
    let current = true;
    api<JobLog>(`/jobs/${encodeURIComponent(job.jobId)}/logs`).then(
      (read) => current && setLog(read.text.split("\n").slice(-12).join("\n")),
      (e) => current && setError(errorText(e)),
    );
    return () => {
      current = false;
    };
  }, [drawer, job?.jobId]);
  const act = (action: () => Promise<unknown>) => () => {
    setError("");
    action().catch((e) => setError(errorText(e)));
  };
  const health = service.health;
  return (
    <section className="portal-job" aria-label={job ? t.job : t.external}>
      <header>
        <strong>{job ? t.job : t.external}</strong>
        {!job && job !== undefined && <span className="portal-tag">{t.externalTag}</span>}
        {job && <span className="portal-tag">{t.jobStates[job.status] ?? job.status}</span>}
        {!disconnected && (
          <button type="button" className="quiet-button portal-disconnect" onClick={act(onDisconnect)}>
            {t.disconnect}
          </button>
        )}
      </header>
      <div className="portal-states">
        {job && (
          <div className="portal-fact" data-state={job.status}>
            <small>{t.process}</small>
            <b><span className="portal-dot" />{t.jobStates[job.status] ?? job.status}</b>
          </div>
        )}
        <div className="portal-fact" data-state={reachable ? "running" : "unknown"}>
          <small>{t.page}</small>
          <b><span className="portal-dot" />{reachable ? t.reachable : t.notReachable}</b>
          <em>
            {c.httpStatus ? `HTTP ${c.httpStatus}` : ""}
            {job ? ` · ${job.owner === "otherProcess" ? t.otherProcess : job.owner === "notListening" ? t.notListening : t.linked}` : ""}
          </em>
        </div>
        {job && (
          <div className="portal-fact" data-state={health?.declared ? health.state : "unset"}>
            <small>{t.health}</small>
            <b>{health?.declared ? t.healthStates[health.state] ?? health.state : t.notSet}</b>
          </div>
        )}
      </div>
      <div className="portal-actions">
        {job && (
          <>
            <button type="button" className="quiet-button" aria-expanded={drawer === "logs"} onClick={() => setDrawer(drawer === "logs" ? null : "logs")}>
              {t.logs}
            </button>
            <button type="button" className="quiet-button" onClick={() => openJobs({ jobId: job.jobId })}>{t.inJobs}</button>
            {job.canStop && !confirming && (
              <button type="button" className="danger-button portal-stop" onClick={() => setConfirming(true)}>{t.stop}</button>
            )}
          </>
        )}
        {!job && job !== undefined && <span className="portal-muted">{t.neverStops}</span>}
      </div>
      {confirming && job && (
        <div className="portal-confirm" role="alertdialog" aria-label={t.stopConfirm}>
          <p>{t.stopNote}</p>
          <button type="button" className="danger-button" onClick={act(async () => {
            await post(`/jobs/${encodeURIComponent(job.jobId)}/cancel`);
            setConfirming(false);
          })}>{t.stopConfirm}</button>
          <button type="button" className="quiet-button" onClick={() => setConfirming(false)}>{t.stopCancel}</button>
        </div>
      )}
      {drawer === "logs" && <pre className="portal-logs">{log}</pre>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}

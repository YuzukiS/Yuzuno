import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, ChevronLeft, FileCode2, Globe, LoaderCircle, RotateCw, Shield, X } from "lucide-react";
import { api, errorText, post } from "../api";
import { langTag, strings, useLanguage, useStrings } from "../i18n";
import { openJobs } from "../Jobs";
import type { OpenedService, ProjectService } from "../ProjectServices";
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
import { serviceIdle } from "./service-lifecycle";
import { ServiceLifecycle } from "./ServiceLifecycle";
import { currentBrowserReach, type ServiceBrowserReach } from "./service-observation";
import { serviceText } from "./service-text";
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
  notListening: "This Job isn't listening on the port",
  ownerUnknown: "Can't confirm whose program answers on the port",
  pageChecked: "Page (last check)",
  notConnected: "Not connected",
  checkingPage: "Checking",
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
  stopChanged: "This service now refers to another Job. Choose Keep it, then look at the current Job before stopping.",
  jobStates: {
    queued: "Queued", waiting: "Waiting", starting: "Starting", running: "Running", cancelling: "Stopping",
    succeeded: "Ended", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted", rejected: "Not started",
    unknown: "Unknown",
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
  notListening: "此 Job 没有在端口上监听",
  ownerUnknown: "无法确认端口上是谁在应答",
  pageChecked: "页面（上次检查）",
  notConnected: "未连接",
  checkingPage: "正在检查",
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
  stopChanged: "这个服务现在关联的是另一个 Job。请先选择保留，查看当前的 Job 后再决定是否停止。",
  jobStates: {
    queued: "排队中", waiting: "等待中", starting: "启动中", running: "运行中", cancelling: "正在停止",
    succeeded: "已结束", failed: "失败", cancelled: "已停止", interrupted: "已中断", rejected: "未启动",
    unknown: "未知",
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

/** Only the latest layout change holds the reading; an older one stops. */
let holding = 0;

/**
 * Runs a change that resizes the chat (the Portal opening, closing or
 * widening beside it), keeping what the reader is at where they saw it in
 * the conversation: the card the page was opened from while it shows, else
 * the paragraph on the line a quarter down inside its message, else the
 * first message in view, as the conversation picks its own reading anchor
 * (ConversationWindow's ReadingAnchor). Rows measured after the width
 * change move it again, so the remaining drift is corrected for a few frames
 * more, until the reader scrolls or a newer change takes over; nothing else
 * scrolls the conversation.
 */
function keepInPlace(opener: HTMLElement | null, change: () => void) {
  const token = ++holding;
  const pane = (opener?.isConnected ? opener.closest<HTMLElement>(".conversation-scroll") : null)
    ?? document.querySelector<HTMLElement>(".conversation-scroll");
  if (!pane?.clientHeight) return change();
  const box = pane.getBoundingClientRect();
  const shows = (rect: DOMRect) => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
  let anchor: HTMLElement | undefined;
  if (opener?.isConnected && pane.contains(opener) && shows(opener.getBoundingClientRect())) anchor = opener;
  else {
    // The block on the line a quarter down, inside the message there: a long
    // message reflows within itself, so its top alone would not hold the
    // paragraph being read.
    const line = typeof document.elementFromPoint === "function"
      ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 4) : null;
    const item = line?.closest<HTMLElement>("[data-item-id]");
    if (line && item && pane.contains(item)) {
      const block = line.closest<HTMLElement>("p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, tr");
      anchor = block && item.contains(block) ? block : item;
    } else {
      const visible = Array.from(pane.querySelectorAll<HTMLElement>("[data-item-id]"))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => shows(rect));
      anchor = (visible.find(({ rect }) => rect.top >= box.top) || visible[0])?.element;
    }
  }
  if (!anchor) return change();
  const at = anchor;
  const offset = () => at.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  const before = offset();
  change();
  let stopped = false;
  const stop = () => { stopped = true; };
  const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  for (const name of events) pane.addEventListener(name, stop, { capture: true, passive: true });
  window.addEventListener("keydown", stop, { capture: true });
  const done = () => {
    for (const name of events) pane.removeEventListener(name, stop, { capture: true });
    window.removeEventListener("keydown", stop, { capture: true });
  };
  const settle = () => {
    if (stopped || token !== holding || !at.isConnected || !pane.isConnected) return false;
    const drift = offset() - before;
    if (Math.abs(drift) > 1) pane.scrollTop += drift;
    return true;
  };
  settle();
  let frames = 0;
  const again = () => {
    if (settle() && ++frames < 10) requestAnimationFrame(again);
    else done();
  };
  requestAnimationFrame(again);
}

/** Whether going from one shape to the next changes the chat's width. */
const resizesChat = (from: Layout | null, to: Layout | null) =>
  (from?.mode === "side" || to?.mode === "side")
  && !(from?.mode === "side" && to?.mode === "side" && from.width === to.width && from.rail === to.rail);

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
  // What the page was opened from, kept past closing: the reading stays there.
  const anchor = useRef<HTMLElement | null>(null);
  if (shown?.opener) anchor.current = shown.opener;
  const relayout = useCallback(() => setShape(shown ? layout(dragged) : null), [shown, dragged]);
  useLayoutEffect(() => {
    relayout();
  }, [relayout]);
  // The shape last applied: a full-screen Portal leaves the chat as it was.
  const applied = useRef<Layout | null>(null);
  useLayoutEffect(() => {
    const was = applied.current;
    applied.current = shape;
    if (resizesChat(was, shape)) keepInPlace(anchor.current, () => apply(shape));
    else apply(shape);
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
  const lt = useStrings(serviceText);
  const [reloads, setReloads] = useState(0);
  const [loads, setLoads] = useState(0);
  const [minted, setMinted] = useState<
    { state: "preparing" } | { state: "ready"; at: Minted } | { state: "unreachable" } | { state: "failed"; reason: string }
  >({ state: "preparing" });
  const [service, setService] = useState<ProjectService | null>(target.kind === "service" ? target.service : null);
  const [disconnected, setDisconnected] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  // The page's address and this browser's proof of reaching it, for the run
  // it was checked with: a new run, or another port, needs a new check.
  const [url, setUrl] = useState(target.kind === "service" ? target.url : "");
  const [reach, setReach] = useState<ServiceBrowserReach | undefined>(() => target.kind !== "service" ? undefined
    : { state: "proven", url: target.url, checkedAt: target.browserCheckedAt,
      jobId: target.browserJobId !== undefined ? target.browserJobId : target.service.job?.jobId ?? null });
  const [checkError, setCheckError] = useState("");
  const alive = useRef(true);
  const reads = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
  // A service: its Job and health as the services list has them now. Only
  // the newest read answers; a failed one says so and keeps the last facts.
  const readService = useCallback(async () => {
    if (target.kind !== "service") return;
    const sequence = ++reads.current;
    try {
      const page = await api<{ services?: ProjectService[] }>(`/projects/${encodeURIComponent(target.service.projectId)}/services`);
      if (!alive.current || sequence !== reads.current) return;
      setReadFailed(false);
      // A list without this service means it is gone; an odd answer changes nothing.
      if (Array.isArray(page.services)) setService(page.services.find((s) => s.id === target.service.id) ?? null);
    } catch (error) {
      if (alive.current && sequence === reads.current) setReadFailed(true);
      throw error;
    }
  }, [target]);
  useEffect(() => {
    if (target.kind !== "service") return;
    void readService().catch(() => {});
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void readService().catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [target, readService]);
  const disconnect = async () => {
    if (target.kind !== "service") return;
    await post(`/services/${encodeURIComponent(target.service.id)}/close`);
    if (alive.current) setDisconnected(true);
  };
  // Opens the service's way again and checks it from this browser, as the
  // services list does; it never starts anything.
  const checkPreview = async () => {
    if (target.kind !== "service") return;
    setCheckError("");
    // The run this check is of: the one shown when it was asked for. If
    // another runs by the next read, that read drops the proof.
    const jobId = service?.job?.jobId ?? null;
    const opened = await post<OpenedService>(`/services/${encodeURIComponent(target.service.id)}/open`);
    if (!alive.current) return;
    const { proof } = opened;
    // Only the way is new; the service keeps its Job, lifecycle and health.
    setService((current) => (current ? { ...current, connection: opened.connection } : current));
    setDisconnected(false);
    const port = opened.connection.localPort;
    if (port === undefined || !proof) {
      setReach({ state: "unproven", checkedAt: new Date().toISOString(), jobId });
      return;
    }
    const next = `http://127.0.0.1:${port}${opened.path}`;
    setReach({ state: "checking", url: next, jobId });
    const proven = await reaches(`http://127.0.0.1:${port}/.well-known/yuzuno-service/${encodeURIComponent(proof.challenge)}`, proof.answer);
    if (!alive.current) return;
    setReach({ state: proven ? "proven" : "unproven", url: next, checkedAt: new Date().toISOString(), jobId });
    if (proven) {
      setUrl(next);
      setLoads(0);
      setReloads((n) => n + 1);
    }
  };
  // A service its Job runs, on a Core that says its lifecycle: its page shows
  // only while that run is running, no stop is recorded for it, and this
  // browser's proof is of that run and port.
  const managed = target.kind === "service" && service?.job && service.lifecycle ? service : null;
  const idle = managed ? serviceIdle(managed) : null;
  const connectionUrl = managed && managed.connection.localPort !== undefined ? `http://127.0.0.1:${managed.connection.localPort}${managed.path}` : null;
  const proof = managed ? currentBrowserReach(reach, managed.job!.jobId, connectionUrl) : undefined;
  const unchecked = !!managed && !idle && proof?.state !== "proven";
  const pageUrl = target.kind === "service" ? (managed ? url : target.url) : "";
  const browserUrl =
    target.kind === "service" ? (idle || unchecked ? null : pageUrl) : minted.state === "ready" ? minted.at.url : null;
  const title = target.kind === "snapshot" ? target.name : target.service.name;
  const subtitle =
    target.kind === "snapshot"
      ? minted.state === "ready"
        ? t.snapshotAt(target.from, timeOf(minted.at.takenAt))
        : target.from
      : `${t.service} · ${target.where} · ${pageUrl.replace(/^http:\/\//, "").replace(/\/.*$/, "")}`;
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
        {!full && (minted.state === "ready" || (target.kind === "service" && !idle && !unchecked)) && (
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
        ) : idle ? (
          <ServiceIdle kind={idle} />
        ) : disconnected || unchecked ? (
          <div className="portal-state portal-idle" role="status" data-idle={disconnected ? "disconnected" : "check"}>
            {disconnected ? <p>{t.disconnected}</p> : <ServiceIdle kind="check" />}
            {managed && (
              <button type="button" className="primary-button" disabled={proof?.state === "checking"} onClick={() => {
                void checkPreview().catch((error) => alive.current && setCheckError(errorText(error)));
              }}>
                {proof?.state === "checking" ? <LoaderCircle size={14} className="spin" /> : <Globe size={14} />} {lt.previewCheck}
              </button>
            )}
            {managed && proof?.state === "unproven" && <p>{lt.unreachable}</p>}
            {checkError && <p className="inline-error" role="alert">{checkError}</p>}
          </div>
        ) : framing === "blocked" ? (
          <div className="portal-state portal-blocked">
            <strong>{t.blocked}</strong>
            <p>{t.blockedNote}</p>
            <button type="button" className="primary-button" onClick={() => openOutside(pageUrl)}>
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
              src={pageUrl}
              // Its own origin keeps its storage and sockets; it never moves this window.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
              referrerPolicy="no-referrer"
            />
          </>
        )}
      </div>
      {managed ? (
        <ServiceLifecycle service={managed} browserReach={reach} previewUrl={connectionUrl} disconnected={disconnected}
          readFailed={readFailed} onRefresh={readService} onDisconnect={disconnect} onCheckPreview={checkPreview} />
      ) : target.kind === "service" && service && (
        // An older Core, or a service no Yuzuno Job runs.
        <ServiceJob service={service} disconnected={disconnected} onDisconnect={disconnect} />
      )}
    </>
  );
}

/** What stands in the page's place while its run isn't live. */
function ServiceIdle({ kind }: { kind: NonNullable<ReturnType<typeof serviceIdle>> | "check" }) {
  const t = useStrings(serviceText);
  const [title, note] = {
    stopped: [t.idleStopped, t.idleStoppedNote], expired: [t.idleExpired, t.idleExpiredNote], ended: [t.idleEnded, t.idleEndedNote],
    stopping: [t.idleStopping, t.idleStoppingNote], queued: [t.idleQueued, t.idleQueuedNote], unknown: [t.idleUnknown, t.idleUnknownNote],
    check: [t.idleCheck, t.idleCheckNote],
  }[kind];
  const body = <><strong>{title}</strong><p>{note}</p></>;
  return kind === "check" ? body : <div className="portal-state portal-idle" role="status" data-idle={kind}>{body}</div>;
}

type JobLog = { text: string };

/** The service's way and, when a Yuzuno Job serves it, that Job: running,
 * reachable and healthy are three facts, never one guessed from another. */
function ServiceJob({ service, disconnected, onDisconnect }: { service: ProjectService; disconnected: boolean; onDisconnect: () => Promise<void> }) {
  const t = text(useLanguage());
  const [drawer, setDrawer] = useState<"logs" | null>(null);
  const [log, setLog] = useState("");
  // The Job the confirmation was opened for: a newer one read meanwhile is
  // never stopped by it.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const job = service.job;
  const c = service.connection;
  const reachable = c.state === "available";
  const checked = reachable || c.state === "notRunning" || c.state === "notReady";
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
            {/* Whose listener answers, as the list says now; only a verified one is the Job's. */}
            <em>{({ verified: t.linked, otherProcess: t.otherProcess, notListening: t.notListening } as Record<string, string>)[job.owner] ?? t.ownerUnknown}</em>
          </div>
        )}
        {/* The page as its last check found it (on opening or checking again):
            nothing re-checks it while it is shown, so it says when. Other
            states are not a check of the page. */}
        {checked ? (
          <div className="portal-fact" data-state={reachable ? "running" : "unknown"}>
            <small>{t.pageChecked}</small>
            <b><span className="portal-dot" />{reachable ? t.reachable : t.notReachable}</b>
            <em>{[Number.isNaN(Date.parse(c.since)) ? "" : timeOf(c.since), c.httpStatus ? `HTTP ${c.httpStatus}` : ""].filter(Boolean).join(" · ")}</em>
          </div>
        ) : (
          <div className="portal-fact" data-state="unknown">
            <small>{t.page}</small>
            <b><span className="portal-dot" />{c.state === "opening" ? t.checkingPage : t.notConnected}</b>
          </div>
        )}
        {job && (
          <div className="portal-fact" data-state={health?.declared ? health.state : "unset"}>
            <small>{t.health}</small>
            <b>{health?.declared ? t.healthStates[health.state] ?? health.state : t.notSet}</b>
            {health?.declared && health.state !== "ok" && health.reason && <em>{health.reason}</em>}
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
            {job.canStop && confirming === null && (
              <button type="button" className="danger-button portal-stop" onClick={() => setConfirming(job.jobId)}>{t.stop}</button>
            )}
          </>
        )}
        {!job && job !== undefined && <span className="portal-muted">{t.neverStops}</span>}
      </div>
      {confirming !== null && job && (
        <div className="portal-confirm" role="alertdialog" aria-label={t.stopConfirm}>
          <p>{job.jobId === confirming ? t.stopNote : t.stopChanged}</p>
          <button type="button" className="danger-button" disabled={job.jobId !== confirming} onClick={act(async () => {
            await post(`/jobs/${encodeURIComponent(confirming)}/cancel`);
            setConfirming(null);
          })}>{t.stopConfirm}</button>
          <button type="button" className="quiet-button" onClick={() => setConfirming(null)}>{t.stopCancel}</button>
        </div>
      )}
      {drawer === "logs" && <pre className="portal-logs">{log}</pre>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}

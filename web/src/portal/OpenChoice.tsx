import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, LoaderCircle, PanelRight } from "lucide-react";
import { errorText } from "../api";
import { strings, useStrings } from "../i18n";
import { useOpenWith, type OpenWith } from "./portal-preference";
import { mintPreview, openInPortal, openOutside, phonePreviewsOff, provesPreview, type PortalTarget } from "./index";
import "./portal.css";
import { Tip, TipText } from "../Tip";

// The entry's own words (T-189).
const text = strings({
  beside: (service: boolean): string => (service ? "Open beside" : "Preview beside"),
  full: (service: boolean): string => (service ? "Open full screen" : "Preview full screen"),
  browser: "Open in browser",
  once: "This time only",
  isDefault: "This device's default",
  source: "View source",
  sourceNote: "Shown as text, not run",
  more: "Other ways to open",
  opening: "Opening…",
  notOpened: "No new tab? Open it here",
}, {
  beside: (service) => (service ? "在旁边打开" : "在旁边预览"),
  full: (service) => (service ? "全屏打开" : "全屏预览"),
  browser: "在浏览器打开",
  once: "仅这一次",
  isDefault: "本设备默认",
  source: "看源码",
  sourceNote: "以文本显示，不运行",
  more: "其他打开方式",
  opening: "正在打开…",
  notOpened: "没有出现新标签页？点这里打开",
});

const narrow = () => window.innerWidth <= 720;
/** The menu's way out: --motion-exit-small. */
const MENU_OUT_MS = 130;

/**
 * How to open a page or prototype (T-5): the device's default way as the
 * main button, the other one (and the source, for a file) behind ▾, for
 * this once. A file opened in the browser is kept as a snapshot first and
 * its address proven, as in the Portal; one that can't be reached from this
 * computer opens the Portal, which says why, rather than a broken tab.
 */
export function OpenChoice({
  target,
  onSource,
  onOpened,
}: {
  /** What to open: built when chosen, so it carries what is shown then. */
  target: () => PortalTarget;
  onSource?: () => void;
  /** Called once the page is opened and nothing more is needed here, e.g. to
   * close a dialog: in the Portal, or a service outside. Not after a file
   * opened in the browser, whose fallback link has to stay. */
  onOpened?: () => void;
}) {
  const t = useStrings(text);
  const preferred = useOpenWith();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  // The menu pops in from its ▾ and sinks back into it, as the scope menu
  // does (T-19 SV-05). It stays on screen, inert, for its short way out;
  // reduced motion closes it at once. Set in the same render that closes it,
  // so the menu is never taken off the screen and put back for its way out.
  const [leaving, setLeaving] = useState(false);
  const [shownMenu, setShownMenu] = useState(menu);
  if (menu !== shownMenu) {
    setShownMenu(menu);
    setLeaving(!menu && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), MENU_OUT_MS + 100);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const service = target().kind === "service";
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menu]);
  const open = async (how: OpenWith, from: Element | null) => {
    setMenu(false);
    setError("");
    setFallback(null);
    const chosen = target();
    if (how === "inside") {
      openInPortal(chosen, from);
      onOpened?.();
      return;
    }
    if (chosen.kind === "service") {
      openOutside(chosen.url);
      onOpened?.();
      return;
    }
    setBusy(true);
    try {
      const at = await mintPreview(chosen.source);
      if (!(await provesPreview(at.proof))) {
        openInPortal(chosen, from);
        onOpened?.();
      } else {
        openOutside(at.url);
        // A browser may block a tab opened after a wait, and doesn't say so;
        // the link opens it with a click, so whatever holds it stays open.
        setFallback(at.url);
      }
    } catch (e) {
      // Off on the phone: the Portal says so, and where to turn them on.
      if (phonePreviewsOff(e)) {
        openInPortal(chosen, from);
        onOpened?.();
      } else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const label = (how: OpenWith) => (how === "browser" ? t.browser : narrow() ? t.full(service) : t.beside(service));
  const other: OpenWith = preferred === "inside" ? "browser" : "inside";
  return (
    <div
      className="open-choice"
      ref={box}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu) {
          event.preventDefault();
          setMenu(false);
          more.current?.focus();
        }
      }}
    >
      <span className="open-choice-split">
        <button type="button" className="primary-button" disabled={busy} onClick={(event) => void open(preferred, event.currentTarget)}>
          {busy ? <LoaderCircle size={14} className="spin" /> : preferred === "browser" ? <ArrowUpRight size={14} /> : <PanelRight size={14} />}
          {busy ? t.opening : label(preferred)}
        </button>
        <Tip content={menu ? null : <TipText title={t.more} />} describe={false}>
          <button
            ref={more}
            type="button"
            className="primary-button open-choice-more"
            aria-label={t.more}
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={busy}
            onClick={() => setMenu(!menu)}
          >
            <ChevronDown size={14} />
          </button>
        </Tip>
      </span>
      {(menu || leaving) && (
        <div
          className={`open-choice-menu${menu ? "" : " is-leaving"}`}
          role="menu"
          aria-hidden={menu ? undefined : true}
          inert={!menu}
          onAnimationEnd={(event) => {
            if (!menu && event.animationName === "open-choice-menu-out") setLeaving(false);
          }}
        >
          <button type="button" role="menuitem" onClick={(event) => void open(preferred, event.currentTarget)}>
            {label(preferred)}
            <small>{t.isDefault}</small>
          </button>
          <button type="button" role="menuitem" autoFocus onClick={(event) => void open(other, event.currentTarget)}>
            {label(other)}
            <small>{t.once}</small>
          </button>
          {onSource && (
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onSource(); }}>
              {t.source}
              <small>{t.sourceNote}</small>
            </button>
          )}
        </div>
      )}
      {fallback && (
        <p className="open-choice-note">
          <a href={fallback} target="_blank" rel="noopener noreferrer">{t.notOpened}</a>
        </p>
      )}
      {error && <p className="inline-error open-choice-note" role="alert">{error}</p>}
    </div>
  );
}

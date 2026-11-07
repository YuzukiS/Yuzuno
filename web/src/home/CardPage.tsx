import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Maximize2 } from "lucide-react";
import { post } from "../api";
import { useStrings } from "../i18n";
import { formatBytes } from "../item-payload";
import { openInPortal, phonePreviewsOff, provesPreview, type PortalTarget } from "../portal";
import { OpenChoice } from "../portal/OpenChoice";
import type { Minted } from "../portal/portal-state";
import type { CardFigure } from "./card-preview";
import { cardText } from "./card-text";
import type { Section } from "./types";

type PageFigure = Extract<CardFigure, { kind: "page" }>;

/**
 * Core's answer to a card's preview (YN-3 with YN-10, the interface on both
 * tasks): the Portal's, with where it was kept for (`place`), whether a live
 * snapshot was given again (`reused`) and the section version it is of.
 */
export type CardMinted = Minted & { place?: string; reused?: boolean; version?: number };

/** How many cards ask for their page at once, at most. */
export const CARD_MINTS = 2;
let asking = 0;
const queued: (() => void)[] = [];
async function oneOfFew<T>(ask: () => Promise<T>): Promise<T> {
  if (asking >= CARD_MINTS) await new Promise<void>((go) => queued.push(go));
  asking++;
  try {
    return await ask();
  } finally {
    asking--;
    queued.shift()?.();
  }
}

/** Pages already proven in this window, by card and version, until shortly before Core lets them go. */
const proven = new Map<string, { at: CardMinted; until: number }>();
/** Forgets what this window was given (tests). */
export function forgetCardPages() {
  proven.clear();
}

type State =
  | { state: "waiting" }
  | { state: "preparing" }
  | { state: "ready"; at: CardMinted }
  | { state: "static"; why: "here" | "phoneOff" };

/**
 * A single-file HTML page on its card, working (YN-3, the user's decision of
 * 03:09Z): asked for only once the card is in view, kept by Core for cards
 * apart from the Portal's (`place: "card"`), proven reachable from this
 * browser, and shown in the Portal's own sandbox (scripts only), with the
 * Portal's guard: once the page loads anything else, this card stops showing
 * it. Where it can't be shown here (another machine's browser, phone access
 * without previews, a Core that keeps no card previews, any refusal, another
 * version) the card names the file and offers its Preview, as before.
 */
export function CardPage({ projectId, section, figure, title }: { projectId: string; section: Section; figure: PageFigure; title: string }) {
  const t = useStrings(cardText);
  const box = useRef<HTMLDivElement>(null);
  const large = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState<State>({ state: "waiting" });
  const [loads, setLoads] = useState(0);
  const [frame, setFrame] = useState(0);
  const version = section.version;
  const target = (): PortalTarget => ({
    kind: "snapshot",
    source: { kind: "briefAttachment", projectId, section: section.key, name: figure.name, version },
    name: figure.name,
    from: `Home · ${title}`,
  });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let current = true;
    const key = JSON.stringify([projectId, section.key, figure.name, version]);
    const ask = () => {
      const kept = proven.get(key);
      if (kept && kept.until > Date.now()) {
        setShown({ state: "ready", at: kept.at });
        return;
      }
      setShown({ state: "preparing" });
      oneOfFew(async (): Promise<State> => {
        const at = await post<CardMinted>("/previews", {
          kind: "briefAttachment", projectId, section: section.key, name: figure.name, version, place: "card",
        });
        // Only a page kept for cards, of this very version, and one this browser reaches.
        if (at.place !== "card" || at.version !== version) return { state: "static", why: "here" };
        if (!(await provesPreview(at.proof))) return { state: "static", why: "here" };
        proven.set(key, { at, until: Date.parse(at.expiresAt) - 60_000 });
        return { state: "ready", at };
      })
        .then((next) => current && setShown(next))
        .catch((error) => current && setShown({ state: "static", why: phonePreviewsOff(error) ? "phoneOff" : "here" }));
    };
    // Asked for when the card comes into view; never for a card not shown (a closed Out of date).
    if (typeof IntersectionObserver === "undefined") {
      ask();
      return () => {
        current = false;
      };
    }
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      ask();
    });
    seen.observe(element);
    return () => {
      current = false;
      seen.disconnect();
    };
  }, [projectId, section.key, figure.name, version]);
  return (
    <div ref={box} className="home-card-page" data-page-state={shown.state}>
      {shown.state === "ready" && loads > 1 ? (
        // Its first load is the page; any later one is a page it went to, which this card no longer shows (Portal.tsx).
        <div className="home-card-page-state" role="status">
          <p>{t.pageMoved}</p>
          <button type="button" className="secondary-button" onClick={() => { setLoads(0); setFrame((n) => n + 1); }}>
            {t.pageBack}
          </button>
        </div>
      ) : shown.state === "ready" ? (
        <iframe
          key={frame}
          className="home-card-page-frame"
          title={figure.name}
          src={shown.at.url}
          // Scripts only: no same-origin, forms, popups or top navigation (as the Portal).
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow=""
          onLoad={() => setLoads((n) => n + 1)}
        />
      ) : shown.state === "static" ? (
        <div className="home-card-page-state home-card-page-static">
          <p className="home-card-page-name">{t.pageHere(figure.name, formatBytes(figure.size))}</p>
          <p className="home-note">{shown.why === "phoneOff" ? t.pagePhoneOff : t.pageNotHere}</p>
          <OpenChoice target={target} />
        </div>
      ) : (
        <p className="home-card-page-state" role="status">
          <LoaderCircle size={14} className="spin" /> {t.pagePreparing}
        </p>
      )}
      {shown.state === "ready" && (
        <button
          ref={large}
          type="button"
          className="icon-button home-card-page-large"
          aria-label={t.pageOpenLarge(figure.name)}
          title={t.pageOpenLarge(figure.name)}
          onClick={() => openInPortal(target(), large.current)}
        >
          <Maximize2 size={13} />
        </button>
      )}
    </div>
  );
}

/** A small card's page: no frame, one line that opens it (as a small card's kept image is a View image button). */
export function CardPageLine({ projectId, section, figure, title }: { projectId: string; section: Section; figure: PageFigure; title: string }) {
  const t = useStrings(cardText);
  return (
    <div className="home-card-page-line" aria-label={t.pagePreviewLabel(figure.name)}>
      <span className="home-card-page-name">{t.pageHere(figure.name, formatBytes(figure.size))}</span>
      <OpenChoice
        target={() => ({
          kind: "snapshot",
          source: { kind: "briefAttachment", projectId, section: section.key, name: figure.name, version: section.version },
          name: figure.name,
          from: `Home · ${title}`,
        })}
      />
    </div>
  );
}

import { RefreshCw } from "lucide-react";
import { useStrings } from "../i18n";
import { homeText } from "./home-text";
import { chooseHomeDensity, densities, useHomeDensity } from "./home-density";
import { Tip, TipText } from "../Tip";

/**
 * Home's density choice (YN-86): two forms of the same cards, kept on this
 * device for this Workspace. It stands in Home's header and on a Project's
 * page, which show the same cards.
 */
export function HomeDensity({ workspaceId }: { workspaceId: string }) {
  const t = useStrings(homeText);
  const density = useHomeDensity(workspaceId);
  return (
    <span className="home-density" role="group" aria-label={t.density}>
      {densities.map((option) => (
        <Tip
          key={option}
          content={<TipText title={option === "low" ? t.densityLowHelp : t.densityHighHelp} body={t.densityHelp} />}
          side="bottom"
        >
          <button
            type="button"
            className="home-density-option"
            aria-pressed={density === option}
            onClick={() => chooseHomeDensity(workspaceId, option)}
          >
            {option === "low" ? t.densityLow : t.densityHigh}
          </button>
        </Tip>
      ))}
    </span>
  );
}

/** Home's refresh, as the header shows it: its icon turns while the read it asked for is on its way. */
export function RefreshHome({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
  const t = useStrings(homeText);
  return (
    <Tip content={<TipText title={t.refresh} />} describe={false} side="bottom">
      <button
        type="button"
        className="icon-button home-refresh"
        aria-label={t.refresh}
        aria-busy={busy || undefined}
        onClick={onRefresh}
      >
        <RefreshCw size={14} className={busy ? "spin" : undefined} />
      </button>
    </Tip>
  );
}

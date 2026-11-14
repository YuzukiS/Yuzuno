import { RefreshCw } from "lucide-react";
import { useStrings } from "../i18n";
import { homeText } from "./home-text";
import { Tip, TipText } from "../Tip";

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

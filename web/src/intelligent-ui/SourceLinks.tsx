import { ArrowUpRight, FileText } from "lucide-react";
import { Tip, TipText } from "../Tip";
import { sourceTarget } from "./spec";
import { useResult } from "./ResultContext";

export function SourceLinks({
  ids,
  compact = false,
}: {
  ids: string[];
  compact?: boolean;
}) {
  const { sources, onFile } = useResult();
  return (
    <span className={`result-sources${compact ? " is-compact" : ""}`}>
      {ids.map((id) => {
        const source = sources.find((source) => source.id === id);
        if (!source) return null;
        const target = sourceTarget(source.href);
        if (!target) return null;
        const label = compact
          ? `[${sources.indexOf(source) + 1}]`
          : source.label;
        // What it is and where it points.
        return target.kind === "web" ? (
          <Tip key={id} content={<TipText title={source.label} value={target.path} />} size="wide">
            <a
              href={target.path}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={source.label}
            >
              {label}
              {!compact && <ArrowUpRight size={12} />}
            </a>
          </Tip>
        ) : (
          <Tip key={id} content={<TipText title={source.label} value={source.href} />} size="wide">
            <button
              type="button"
              disabled={!onFile}
              aria-label={source.label}
              onClick={() => onFile?.(target.path, target.line)}
            >
              {!compact && <FileText size={12} />}
              {label}
            </button>
          </Tip>
        );
      })}
    </span>
  );
}

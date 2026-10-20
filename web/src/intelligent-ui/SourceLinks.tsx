import { ArrowUpRight, FileText } from "lucide-react";
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
        return target.kind === "web" ? (
          <a
            key={id}
            href={target.path}
            target="_blank"
            rel="noopener noreferrer"
            title={`${source.label} · ${target.path}`}
            aria-label={source.label}
          >
            {label}
            {!compact && <ArrowUpRight size={12} />}
          </a>
        ) : (
          <button
            type="button"
            key={id}
            disabled={!onFile}
            title={`${source.label} · ${source.href}`}
            aria-label={source.label}
            onClick={() => onFile?.(target.path, target.line)}
          >
            {!compact && <FileText size={12} />}
            {label}
          </button>
        );
      })}
    </span>
  );
}

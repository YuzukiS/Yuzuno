import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * TeX typeset by KaTeX. Untrusted input: commands that would add links,
 * images or classes (\href, \includegraphics, …) stay disabled, expansion
 * and sizes are bounded, and a TeX error is shown in place, not thrown.
 */
export function BriefMath({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxSize: 20,
        maxExpand: 500,
        output: "htmlAndMathml",
      });
    } catch {
      return null;
    }
  }, [tex, display]);
  if (html === null)
    return (
      <pre className="brief-math is-error" role="status">
        <code>{tex}</code>
      </pre>
    );
  return (
    <div
      className={`brief-math ${display ? "is-display" : "is-inline"}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

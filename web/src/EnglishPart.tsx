import type { ReactNode } from "react";
import { TranslatedPart } from "./i18n";

/** A part not translated yet, inside one that is (T-189): its words stay in
 * English and say so (`lang`), shared pieces such as SaveStatus included. */
export function EnglishPart({ children }: { children: ReactNode }) {
  return (
    <TranslatedPart value={false}>
      <div lang="en" style={{ display: "contents" }}>
        {children}
      </div>
    </TranslatedPart>
  );
}

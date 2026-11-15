import { createContext, useContext } from "react";

/**
 * How a Brief part is drawn (T-9): `low` shows its main point (a plan's
 * steps as a short timeline, a metric's value with its trend, a
 * deliverable's preview), `high` every field and row. The same content
 * either way: the Agent writes one body.
 */
export type Density = "low" | "high";

/**
 * The density Brief parts draw at: low on a Home card's front, which shows
 * a card's main point (SummaryCard); everywhere else, Home's whole cards
 * and report pages included, the high form (YN-133: Home no longer offers
 * a choice).
 */
export const BriefDensity = createContext<Density>("high");
export const useBriefDensity = () => useContext(BriefDensity);

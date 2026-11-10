/** The kinds of work a routing candidate takes (YN-70, YN-84 S1), and the
 * three choices the editor offers: strong only, fast only, or both. Core
 * stores a candidate taking both with no `tiers` field at all, so that is
 * what "both" writes back. This module imports nothing, so its unit test runs
 * straight from TypeScript (CI's --experimental-strip-types). */

/** A kind of work an executor's tier names: strong for designing, investigating, deciding and checking, fast for
 * building what was decided. */
export type Tier = "strong" | "fast";
export const TIERS: readonly Tier[] = ["strong", "fast"];
/** What the editor's one choice can be, in the order the user wrote them. */
export type TierChoice = "strong" | "fast" | "both";
export const TIER_CHOICES: readonly TierChoice[] = ["strong", "fast", "both"];
/** A candidate as Core keeps it: `tiers` unknown here, so `[]` and stray values are read without failing. */
type Tiered = { tiers?: unknown; [field: string]: unknown };

/** The tiers a candidate serves: those it lists, or both when it lists none (as every candidate saved before YN-70). */
export const tiersOf = (c: Tiered): Tier[] => (Array.isArray(c.tiers) ? TIERS.filter((t) => (c.tiers as unknown[]).includes(t)) : [...TIERS]);
/** The one choice that shows `c`: a single kind it lists, otherwise both. An unknown value in `tiers` (or `[]`, which
 * Core refuses) is not guessed at; it shows both and is left as it is until the user picks. */
export const tierChoiceOf = (c: Tiered): TierChoice => { const t = tiersOf(c); return t.length === 1 ? t[0] : "both"; };
/** `c` taking `choice`: both is no field at all, so a candidate left at both is saved as one saved before YN-70. */
export function withTierChoice<C extends Tiered>(c: C, choice: TierChoice): C {
  const next = { ...c };
  if (choice === "both") delete next.tiers; else next.tiers = [choice];
  return next;
}

import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, errorText } from "../../api";
import { useStrings } from "../../i18n";
import { useTimeDisplay } from "../../time-preferences";
import { CardFoldWorkspace } from "../card-fold";
import { useBriefDensity } from "../home-density";
import { useBrief } from "./BriefContext";
import { BriefLiveRefs } from "./LiveRefs";
import { formatTime, researchPath, type ResearchDeskProps } from "./brief-catalog";
import { researchText, type DeskView } from "./research-text";
import "./research.css";

/**
 * A research desk (T-9): claims with their intervals, what may and may not
 * be said, the sources and definitions each number rests on, and candidate
 * next steps, all from one ResearchDesk block. The reader's selection (a
 * claim, a row, difference or parts, a view) stays inside the block and is
 * kept per Workspace, Project, section and block across later versions
 * while its ids stay. Nothing here runs anything: plans are previews, and
 * their links open what the app already has.
 */
type Desk = ResearchDeskProps;
type Claim = Desk["claims"][number];
type Plot = Desk["plots"][number];
type Row = Plot["rows"][number];
type Part = NonNullable<Row["parts"]>[number];
type Estimate = Row["estimate"];
type Num = Estimate["value"];
type Source = Desk["sources"][number];
type Definition = NonNullable<Desk["definitions"]>[number];

type Read =
  | { status: "read"; value: number; from: string }
  | { status: "missing" | "not_number"; from: string }
  | { status: "unavailable"; reason?: string; from: string };
type SourceInfo = {
  attachment: string;
  takenAt?: string;
  sha256?: string;
  available: boolean;
  reason?: string;
  stated?: "same" | "different" | "unknown";
};
type Resolved = { version: number; values: Record<string, Read>; sources: Record<string, SourceInfo> };
type Loaded = { key: string; data?: Resolved; error?: string };
type Origin = "read" | "provided" | "missing" | "not_number" | "unavailable" | "loading";
/** A number as shown: its value when there is one (as the file or the Agent has it), and where it came from. */
type Shown = { value: number | null; origin: Origin; from?: string };
/** A shown number times a plot's display scale; the value itself stays as it was. */
const scaled = (shown: Shown | undefined, scale: number | undefined) =>
  shown?.value === null || shown?.value === undefined || !scale ? shown?.value ?? null : shown.value * scale;

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function resolvedOf(value: unknown): Resolved | null {
  if (!object(value) || typeof value.version !== "number" || !object(value.values) || !object(value.sources)) return null;
  return value as unknown as Resolved;
}

/**
 * The desk's numbers read by Core, once per section version. Only the read of
 * the version on screen is shown: while a newer version loads, its numbers show
 * as loading, never the previous version's as read from a snapshot.
 */
function useResolved(elementKey: string | undefined, wanted: boolean) {
  const { projectId, section } = useBrief();
  const path = wanted && elementKey ? researchPath(projectId, section.key, elementKey, section.version) : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api<unknown>(path, { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return;
        const data = resolvedOf(value);
        setLoaded(data ? { key: path, data } : { key: path, error: "unreadable" });
      },
      (error) => {
        if (!controller.signal.aborted) setLoaded({ key: path, error: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [path]);
  const current = loaded?.key === path ? loaded : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: !!path && !current,
  };
}

/** A row named with its group, where the row's own list no longer shows the group: two rows may share a label. */
const named = (row: Row) => (row.group ? `${row.group} · ${row.label}` : row.label);

function shownOf(number: Num | undefined, at: string, resolved: Resolved | null, loading: boolean): Shown | undefined {
  if (number === undefined) return undefined;
  if (typeof number === "number") return { value: number, origin: "provided" };
  const read = resolved?.values[at];
  if (!read) return { value: null, origin: loading ? "loading" : "unavailable", from: number.from };
  return read.status === "read" ? { value: read.value, origin: "read", from: read.from } : { value: null, origin: read.status, from: read.from };
}

/** A number at the digits the plot asks for, signed when it is a difference from a reference of 0. */
function format(value: number | null, digits: number | undefined, signed: boolean): string {
  if (value === null) return "—";
  const text = digits === undefined ? String(value) : value.toFixed(digits);
  if (!signed) return text.replace(/^-/, "−");
  return value > 0 ? `+${text}` : text.replace(/^-/, "−");
}

type Selection = { claim?: string; row?: string; mode: "diff" | "parts"; view: DeskView };
const VIEWS: DeskView[] = ["claim", "evidence", "history", "next"];
const STORE = "yuzuno.research-desk.v1";
function readStored(key: string): Partial<Selection> {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    return object(all) && object(all[key]) ? (all[key] as Partial<Selection>) : {};
  } catch {
    return {};
  }
}
function writeStored(key: string, value: Selection) {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    const all: Record<string, unknown> = object(parsed) ? parsed : {};
    delete all[key];
    all[key] = value;
    // The newest 100 desks; a selection is a few ids.
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - 100))) delete all[old];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    // Without storage the selection lasts while the page does.
  }
}

/** The claim's rows: those of its plots, in order. */
function claimRows(desk: Desk, claim: Claim | undefined): Row[] {
  if (!claim) return [];
  const plots = claim.plots?.length ? desk.plots.filter((plot) => claim.plots!.includes(plot.id)) : desk.plots;
  return plots.flatMap((plot) => plot.rows);
}

/**
 * The selection the reader made, kept while its ids are still on the desk:
 * otherwise the first claim, and its primary row or first row.
 */
function useSelection(desk: Desk, storageKey: string) {
  const [chosen, setChosen] = useState<Partial<Selection>>(() => readStored(storageKey));
  useEffect(() => setChosen(readStored(storageKey)), [storageKey]);
  const claim = desk.claims.find((item) => item.id === chosen.claim) ?? desk.claims[0];
  const rows = claimRows(desk, claim);
  // A statement may rest on a row of a plot its claim does not show: that row is
  // kept for the evidence view, which shows any row; the claim view keeps its own plots.
  const elsewhere = chosen.view === "evidence" ? desk.plots.flatMap((plot) => plot.rows).find((item) => item.id === chosen.row) : undefined;
  const row = rows.find((item) => item.id === chosen.row) ?? elsewhere ?? rows.find((item) => item.id === claim?.primary) ?? rows[0];
  const selection: Selection = {
    claim: claim?.id,
    row: row?.id,
    mode: chosen.mode === "parts" && row?.parts?.length ? "parts" : "diff",
    view: VIEWS.includes(chosen.view as DeskView) ? (chosen.view as DeskView) : "claim",
  };
  const choose = (next: Partial<Selection>) => {
    const merged = { ...selection, ...next };
    if (next.claim && next.claim !== selection.claim && !next.row) {
      const picked = desk.claims.find((item) => item.id === next.claim);
      const first = claimRows(desk, picked);
      merged.row = (first.find((item) => item.id === picked?.primary) ?? first[0])?.id;
    }
    setChosen(merged);
    writeStored(storageKey, merged);
  };
  return { selection, claim, row, choose };
}

/**
 * Options of which one is selected, as a radio group: the arrow keys, Home
 * and End move the selection and the focus with it; Tab leaves the group.
 */
function Radios<T extends string>({
  label,
  options,
  selected,
  onSelect,
  className,
  render,
}: {
  label: string;
  options: readonly T[];
  selected: T | undefined;
  onSelect: (value: T) => void;
  className: string;
  render: (value: T, checked: boolean) => ReactNode;
}) {
  const refs = useRef(new Map<T, HTMLElement>());
  const move = (event: KeyboardEvent) => {
    const index = selected === undefined ? -1 : options.indexOf(selected);
    const last = options.length - 1;
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight" ? Math.min(last, index + 1)
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? Math.max(0, index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null || next < 0) return;
    event.preventDefault();
    const value = options[next];
    onSelect(value);
    refs.current.get(value)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={className} onKeyDown={move}>
      {options.map((value, index) => {
        const checked = value === selected || (selected === undefined && index === 0);
        return (
          <div
            key={value}
            ref={(node) => {
              if (node) refs.current.set(value, node);
              else refs.current.delete(value);
            }}
            role="radio"
            aria-checked={value === selected}
            tabIndex={checked ? 0 : -1}
            className="research-radio"
            onClick={() => onSelect(value)}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                onSelect(value);
              }
            }}
          >
            {render(value, value === selected)}
          </div>
        );
      })}
    </div>
  );
}

/** A small mark of where a number came from; its words are its label. */
function OriginMark({ origin }: { origin: Origin }) {
  const t = useStrings(researchText);
  return (
    <span className="research-origin" data-origin={origin} title={t.origin[origin]}>
      <span aria-hidden="true" className="research-origin-dot" />
      <span className="research-sr">{t.origin[origin]}</span>
    </span>
  );
}

type Line = { id: string; label: string; group?: string; value?: Shown; low?: Shown; high?: Shown };
function linesOf(items: (Row | Part)[], resolved: Resolved | null, loading: boolean): Line[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    group: "group" in item ? item.group : undefined,
    value: shownOf(item.estimate.value, `${item.id}.value`, resolved, loading),
    low: shownOf(item.estimate.low, `${item.id}.low`, resolved, loading),
    high: shownOf(item.estimate.high, `${item.id}.high`, resolved, loading),
  }));
}

/**
 * Rows as points with intervals on one scale, a reference line where the
 * plot has one. Selecting a row (pointer, arrow keys) selects it for the
 * whole desk when `onSelect` is given.
 */
function Intervals({
  title,
  lines,
  digits,
  scale,
  unit,
  reference,
  signed,
  selected,
  onSelect,
}: {
  title: string;
  lines: Line[];
  digits?: number;
  scale?: number;
  unit?: string;
  reference?: { value: number; label: string };
  signed: boolean;
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  const t = useStrings(researchText);
  const numbers = lines.flatMap((line) => [scaled(line.value, scale), scaled(line.low, scale), scaled(line.high, scale)]).filter((n): n is number => typeof n === "number");
  if (reference) numbers.push(reference.value);
  let min = numbers.length ? Math.min(...numbers) : 0;
  let max = numbers.length ? Math.max(...numbers) : 1;
  if (min === max) [min, max] = [min - 1, max + 1];
  const pad = (max - min) * 0.08;
  [min, max] = [min - pad, max + pad];
  const at = (value: number) => `${(((value - min) / (max - min)) * 100).toFixed(2)}%`;
  if (!lines.length) return <p className="research-empty">{t.noRows}</p>;
  const draw = (line: Line, checked: boolean) => {
    const value = scaled(line.value, scale);
    const low = scaled(line.low, scale);
    const high = scaled(line.high, scale);
    return (
      <>
        <span className="research-row-label">{line.label}</span>
        <span className="research-track" aria-hidden="true">
          {reference && <span className="research-reference" style={{ left: at(reference.value) }} />}
          {low !== null && high !== null && <span className="research-interval" style={{ left: at(low), right: `calc(100% - ${at(high)})` }} />}
          {value !== null && <span className="research-point" data-checked={checked || undefined} style={{ left: at(value) }} />}
        </span>
        <span className="research-row-value">
          <b>{format(value, digits, signed)}</b>
          {(line.low || line.high) && (
            <span className="research-row-interval"> [{format(low, digits, signed)}, {format(high, digits, signed)}]</span>
          )}
          {line.value && <OriginMark origin={line.value.origin} />}
        </span>
      </>
    );
  };
  const ids = lines.map((line) => line.id);
  const byId = new Map(lines.map((line) => [line.id, line]));
  const groupStart = (id: string, index: number) => {
    const group = byId.get(id)?.group;
    return group && (index === 0 || byId.get(ids[index - 1])?.group !== group) ? group : null;
  };
  return (
    <div className="research-intervals">
      <div className="research-scale">
        {reference && <span>{reference.label}</span>}
        {unit && <span>{unit}</span>}
      </div>
      {onSelect ? (
        <Radios
          label={t.rows(title)}
          options={ids}
          selected={selected && ids.includes(selected) ? selected : undefined}
          onSelect={onSelect}
          className="research-rows"
          render={(id, checked) => {
            const index = ids.indexOf(id);
            const group = groupStart(id, index);
            return (
              <>
                {group && <span className="research-group">{group}</span>}
                <span className="research-row" data-checked={checked || undefined}>{draw(byId.get(id)!, checked)}</span>
              </>
            );
          }}
        />
      ) : (
        <div className="research-rows">
          {lines.map((line, index) => (
            <div key={line.id}>
              {groupStart(line.id, index) && <span className="research-group">{line.group}</span>}
              <span className="research-row">{draw(line, false)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What Core knows of a source's snapshot, and the Agent's own description of it. */
function SourceLine({ source, info, lines }: { source: Source; info?: SourceInfo; lines?: string }) {
  const t = useStrings(researchText);
  const time = useTimeDisplay();
  return (
    <li className="research-source">
      <span className="research-source-name">
        {source.label}
        <span className="research-tag">{t.sourceKind[source.kind] ?? source.kind}</span>
        {lines && <span className="research-lines">{t.lines(lines)}</span>}
      </span>
      {source.snapshot && info?.sha256 && info.available && (
        <span className="research-snapshot">
          {t.snapshot} <code>{source.snapshot}</code> · SHA-256 <code title={info.sha256}>{info.sha256.slice(0, 12)}</code>
          {info.takenAt && <> · {t.taken(formatTime(info.takenAt, time))}</>}
          <span className="research-note">{t.notRechecked}</span>
        </span>
      )}
      {source.snapshot && info && !info.available && (
        <span className="research-snapshot" data-unavailable="">
          {info.reason === "not_snapshot" ? t.notSnapshot : t.snapshotMissing}
        </span>
      )}
      {info?.stated && <span className="research-note" data-stated={info.stated}>{t.stated[info.stated]}</span>}
      {(source.location || source.revision) && (
        <span className="research-described">
          {t.described}: {source.location && <>{t.location} <code>{source.location}</code></>}
          {source.revision && <> · {t.revision} <code>{source.revision}</code></>}
        </span>
      )}
    </li>
  );
}

function Statements({ claim, onBasis, labelOf }: { claim: Claim; onBasis: (id: string) => void; labelOf: (id: string) => string }) {
  const t = useStrings(researchText);
  const list = (stance: "can" | "cannot") => (claim.statements ?? []).filter((statement) => statement.stance === stance);
  if (!claim.statements?.length) return null;
  return (
    <div className="research-say">
      {(["can", "cannot"] as const).map((stance) =>
        list(stance).length ? (
          <section key={stance} data-stance={stance}>
            <h5>{stance === "can" ? t.canSay : t.cannotSay}</h5>
            <ul>
              {list(stance).map((statement) => (
                <li key={statement.id}>
                  <span className="research-tag" data-kind={statement.kind}>{t.kind[statement.kind]}</span>
                  <span>{statement.text}</span>
                  {statement.basis?.length ? (
                    <span className="research-basis">
                      {t.restsOn}:{" "}
                      {statement.basis.map((id) => (
                        <button key={id} type="button" className="research-link" onClick={() => onBasis(id)}>
                          {labelOf(id)}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

export function BriefResearchDesk(props: Desk & { elementKey?: string }) {
  const { elementKey, ...desk } = props;
  const t = useStrings(researchText);
  const time = useTimeDisplay();
  const density = useBriefDensity();
  const { projectId, section } = useBrief();
  const workspaceId = useContext(CardFoldWorkspace);
  const storageKey = `${workspaceId}:${projectId}:${section.key}#${elementKey ?? ""}`;
  const { selection, claim, row, choose } = useSelection(desk, storageKey);
  const reads = useMemo(
    () => desk.plots.some((plot) => plot.rows.some((r) => [r.estimate, ...(r.parts ?? []).map((p) => p.estimate)].some((e) => [e.value, e.low, e.high].some((n) => n !== undefined && typeof n !== "number")))),
    [desk.plots],
  );
  const wantsSources = desk.sources.some((source) => source.snapshot);
  const { data: resolved, error, loading } = useResolved(elementKey, reads || wantsSources);
  const sources = useMemo(() => new Map(desk.sources.map((source) => [source.id, source])), [desk.sources]);
  const plotOf = (rowId: string | undefined) => desk.plots.find((plot) => plot.rows.some((r) => r.id === rowId));
  const rowById = (id: string) => desk.plots.flatMap((plot) => plot.rows).find((r) => r.id === id);
  const partOwner = (id: string) => desk.plots.flatMap((plot) => plot.rows).find((r) => r.parts?.some((p) => p.id === id));
  const selectBasis = (id: string) => {
    // A row outside this claim's plots opens in the evidence view rather than joining them.
    const shown = (rowId: string) => claimRows(desk, claim).some((item) => item.id === rowId);
    const owner = rowById(id) ?? partOwner(id);
    if (!owner) return choose({ view: "evidence" });
    const mode = owner.id === id ? "diff" : "parts";
    choose(shown(owner.id) ? { row: owner.id, mode } : { row: owner.id, mode, view: "evidence" });
  };
  const sourceInfo = (id: string | undefined) => (id ? resolved?.sources[id] : undefined);
  /** A row, part or source by its label, for the reader rather than its id. */
  const labelOf = (id: string) => {
    const row = rowById(id);
    if (row) return `${named(row)} (${plotOf(id)?.title ?? ""})`;
    const owner = partOwner(id);
    const part = owner?.parts?.find((p) => p.id === id);
    if (owner && part) return `${named(owner)} · ${part.label}`;
    return sources.get(id)?.label ?? id;
  };
  const plots = claim?.plots?.length ? desk.plots.filter((plot) => claim.plots!.includes(plot.id)) : desk.plots;
  const plot = plotOf(row?.id);

  const numbers = (estimate: Estimate, owner: string) => {
    const shown = (["value", "low", "high"] as const).map((field) => [field, shownOf(estimate[field], `${owner}.${field}`, resolved, loading)] as const);
    return (
      <dl className="research-numbers">
        {shown.map(([field, value]) =>
          value ? (
            <div key={field}>
              <dt>{t[field]}</dt>
              <dd>
                {format(scaled(value, plot?.scale), plot?.digits, !!plot?.reference && plot.reference.value === 0)}
                {plot?.scale && value.value !== null && <span className="research-origin-text">{t.asFiled(String(value.value))}</span>}
                <span className="research-origin-text" data-origin={value.origin}>
                  {t.origin[value.origin]}
                  {value.from && <> · <code>{value.from}</code></>}
                </span>
              </dd>
            </div>
          ) : null,
        )}
      </dl>
    );
  };

  const primary = claim?.primary ? rowById(claim.primary) : undefined;
  const primaryPlot = plotOf(primary?.id);
  const primaryCard = primary && (() => {
    const signed = !!primaryPlot?.reference && primaryPlot.reference.value === 0;
    const [value, low, high] = (["value", "low", "high"] as const).map((field) => shownOf(primary.estimate[field], `${primary.id}.${field}`, resolved, loading));
    return (
      <section className="research-primary">
        <span className="research-primary-label">{t.primary}: {named(primary)}</span>
        <p className="research-big">
          <b>{format(scaled(value, primaryPlot?.scale), primaryPlot?.digits, signed)}</b>
          {primaryPlot?.unit && <span> {primaryPlot.unit}</span>}
        </p>
        {(low || high) && (
          <p>
            {primaryPlot?.interval ?? t.interval} [{format(scaled(low, primaryPlot?.scale), primaryPlot?.digits, signed)}, {format(scaled(high, primaryPlot?.scale), primaryPlot?.digits, signed)}]
          </p>
        )}
        {value && (
          <span className="research-origin-text" data-origin={value.origin}>
            {t.origin[value.origin]}
            {value.from && <> · <code>{value.from}</code></>}
          </span>
        )}
      </section>
    );
  })();
  const claimView = claim && (
    <>
      <header className="research-claim-head">
        <span className="research-status" data-status={claim.status}>
          {t.status[claim.status]} <small>({t.authors})</small>
        </span>
        <h4>{claim.title}</h4>
        <p>{claim.statement}</p>
      </header>
      {primaryCard}
      {plots.map((item) => {
        const signed = !!item.reference && item.reference.value === 0;
        const selectedHere = item.rows.find((r) => r.id === selection.row);
        // The toggle belongs to the selected row: a row without parts has nothing to show on its own.
        const hasParts = !!selectedHere?.parts?.length;
        const showParts = selection.mode === "parts" && selectedHere?.parts?.length;
        return (
          <section key={item.id} className="research-plot">
            <div className="research-plot-head">
              <h5>{item.title}</h5>
              {hasParts && (
                <Radios
                  label={t.showAs}
                  options={["diff", "parts"] as const}
                  selected={showParts ? "parts" : "diff"}
                  onSelect={(mode) => choose({ mode })}
                  className="research-toggle"
                  render={(mode) => (mode === "diff" ? item.diffLabel ?? t.difference : item.partsLabel ?? t.eachOwn)}
                />
              )}
            </div>
            {showParts ? (
              <>
                <p className="research-caption">{named(selectedHere)}</p>
                <Intervals title={item.title} lines={linesOf(selectedHere.parts!, resolved, loading)} digits={item.digits} scale={item.scale} unit={item.unit} signed={false} />
              </>
            ) : (
              <Intervals
                title={item.title}
                lines={linesOf(item.rows, resolved, loading)}
                digits={item.digits}
                scale={item.scale}
                unit={item.unit}
                reference={item.reference}
                signed={signed}
                selected={selection.row}
                onSelect={(id) => choose({ row: id })}
              />
            )}
          </section>
        );
      })}
      <Statements claim={claim} onBasis={selectBasis} labelOf={labelOf} />
      {claim.conditions?.length ? (
        <section className="research-conditions">
          <h5>{t.conditions}</h5>
          <ul>{claim.conditions.map((condition) => <li key={condition.id}>{condition.text}</li>)}</ul>
        </section>
      ) : null}
    </>
  );

  const definitionOf = (ref: { id: string; version: number } | undefined) => {
    if (!ref) return null;
    const definition = desk.definitions?.find((item) => item.id === ref.id);
    const version = definition?.versions.find((item) => item.version === ref.version);
    return definition && version ? { definition, version } : null;
  };
  const used = definitionOf(row?.estimate.definition);
  const evidenceView = row && (
    <>
      <header className="research-claim-head">
        <h4>{named(row)}</h4>
        {row.note && <p>{row.note}</p>}
      </header>
      <section className="research-panel">
        <h5>{t.numbersFrom}</h5>
        {numbers(row.estimate, row.id)}
        {row.estimate.cite && (
          <ul className="research-sources">
            {sources.get(row.estimate.cite.source) && (
              <SourceLine source={sources.get(row.estimate.cite.source)!} info={sourceInfo(row.estimate.cite.source)} lines={row.estimate.cite.lines} />
            )}
          </ul>
        )}
      </section>
      {row.parts?.length ? (
        <section className="research-panel">
          <h5>{plot?.partsLabel ?? t.eachOwn}</h5>
          {row.parts.map((part) => (
            <div key={part.id} className="research-part">
              <b>{part.label}</b>
              {numbers(part.estimate, part.id)}
            </div>
          ))}
        </section>
      ) : null}
      {used && (
        <section className="research-panel">
          <h5>
            {t.definition}: {used.definition.title} <span className="research-tag">{t.version(used.version.version)}</span>
          </h5>
          <p>{used.version.text}</p>
          {used.version.frozenAt && <p className="research-note">{t.frozen(formatTime(used.version.frozenAt, time))}</p>}
        </section>
      )}
      {claim?.conditions?.length ? (
        <section className="research-conditions">
          <h5>{t.conditions}</h5>
          <ul>{claim.conditions.map((condition) => <li key={condition.id}>{condition.text}</li>)}</ul>
        </section>
      ) : null}
    </>
  );

  const latest = (definition: Definition) => Math.max(...definition.versions.map((item) => item.version));
  const historyView = (
    <>
      <p className="research-note">{t.kept}</p>
      {!desk.definitions?.length && <p className="research-empty">{t.noDefinitions}</p>}
      {desk.definitions?.map((definition) => {
        const newest = latest(definition);
        const versions = [...definition.versions].sort((a, b) => b.version - a.version);
        const compared = desk.plots.flatMap((item) => item.rows).filter((r) => r.estimate.definition?.id === definition.id && r.compare);
        const pairs = [...new Set(compared.map((r) => r.compare!))].map((key) => {
          const byVersion = compared.filter((r) => r.compare === key).sort((a, b) => a.estimate.definition!.version - b.estimate.definition!.version);
          return { key, before: byVersion[0], after: byVersion[byVersion.length - 1] };
        }).filter((pair) => pair.before.id !== pair.after.id);
        const affected = desk.claims.filter((item) => item.dependsOn?.some((ref) => ref.id === definition.id && ref.version < newest));
        const drafts = (desk.revisions ?? []).filter((revision) => revision.definition.id === definition.id);
        return (
          <section key={definition.id} className="research-panel">
            <h5>{t.definition}: {definition.title}</h5>
            <ol className="research-versions">
              {versions.map((version) => {
                const info = sourceInfo(version.cite.source);
                return (
                  <li key={version.version} data-current={version.version === newest || undefined}>
                    <span className="research-tag">{t.version(version.version)} · {version.version === newest ? t.current : t.older}</span>
                    <p>{version.text}</p>
                    {version.change && <p className="research-note">{t.change}: {version.change}</p>}
                    {version.frozenAt && <p className="research-note">{t.frozen(formatTime(version.frozenAt, time))}</p>}
                    {sources.get(version.cite.source) && (
                      <ul className="research-sources"><SourceLine source={sources.get(version.cite.source)!} info={info} lines={version.cite.lines} /></ul>
                    )}
                  </li>
                );
              })}
            </ol>
            {pairs.length > 0 && (
              <table className="research-compare">
                <caption>{t.beforeAfter(pairs[0].before.estimate.definition!.version, pairs[0].after.estimate.definition!.version)}</caption>
                <tbody>
                  {pairs.map(({ key, before, after }) => {
                    const owner = plotOf(after.id);
                    const signed = !!owner?.reference && owner.reference.value === 0;
                    const text = (r: Row) => {
                      const [value, low, high] = (["value", "low", "high"] as const).map((field) => shownOf(r.estimate[field], `${r.id}.${field}`, resolved, loading));
                      return `${format(scaled(value, owner?.scale), owner?.digits, signed)}${low || high ? ` [${format(scaled(low, owner?.scale), owner?.digits, signed)}, ${format(scaled(high, owner?.scale), owner?.digits, signed)}]` : ""}`;
                    };
                    return (
                      <tr key={key}>
                        <th scope="row">{after.label}</th>
                        <td>{text(before)}</td>
                        <td aria-hidden="true">→</td>
                        <td><b>{text(after)}</b></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {versions.length > 1 && !pairs.length && <p className="research-note">{t.noComparison}</p>}
            {affected.length > 0 && (
              <div className="research-affected">
                <h6>{t.affected}</h6>
                <ul>
                  {affected.map((item) => {
                    const ref = item.dependsOn!.find((d) => d.id === definition.id)!;
                    return (
                      <li key={item.id}>
                        <button type="button" className="research-link" onClick={() => choose({ claim: item.id, view: "claim" })}>{item.title}</button>
                        <span className="research-note"> {t.affectedNote(ref.version, newest)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {drafts.length > 0 && (
              <div className="research-drafts">
                <h6>{t.drafts}</h6>
                {drafts.map((draft) => (
                  <blockquote key={draft.id}>
                    <span className="research-tag">{draft.target} · {t.draftBasis[draft.basis]} · {t.notApplied}</span>
                    <p>{draft.draft}</p>
                  </blockquote>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );

  const nextView = (
    <>
      <p className="research-banner">{t.previewOnly}</p>
      {!desk.plans?.length && <p className="research-empty">{t.noPlans}</p>}
      {desk.plans?.map((plan) => (
        <section key={plan.id} className="research-panel research-plan">
          <h5>
            {plan.title} <span className="research-tag" data-state={plan.state}>{t.planState[plan.state]}</span>
          </h5>
          <p><b>{t.question}:</b> {plan.question}</p>
          {plan.inputs?.length ? (
            <p>
              <b>{t.inputs}:</b>{" "}
              {plan.inputs.map((input, index) => (
                <span key={index} className="research-chip">{input.source ? sources.get(input.source)?.label ?? input.label : input.label}</span>
              ))}
            </p>
          ) : null}
          {plan.params?.length ? (
            <dl className="research-params">
              {plan.params.map((param) => (
                <div key={param.name}><dt>{param.name}</dt><dd>{param.value}</dd></div>
              ))}
            </dl>
          ) : null}
          <p>
            <span className="research-chip">{t.compute[plan.compute]}</span>
            {plan.budget && <span className="research-chip">{t.budget}: {plan.budget}</span>}
          </p>
          {(plan.outputs?.length || plan.notProduced?.length) ? (
            <div className="research-yields">
              {plan.outputs?.length ? <div><h6>{t.produces}</h6><ul>{plan.outputs.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
              {plan.notProduced?.length ? <div><h6>{t.notProduced}</h6><ul>{plan.notProduced.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
            </div>
          ) : null}
          {plan.note && <p className="research-note">{plan.note}</p>}
          {plan.links?.length ? (
            <div className="research-links">
              <h6>{t.linked}</h6>
              <BriefLiveRefs layout="list" items={plan.links} />
              <p className="research-note">{t.jobNotResult}</p>
            </div>
          ) : null}
        </section>
      ))}
    </>
  );

  const aside = (
    <aside className="research-aside">
      {claim?.paper?.length ? (
        <section className="research-panel">
          <h5>{t.paper}</h5>
          <ul className="research-sources">
            {claim.paper.map((place, index) => (
              <li key={index} className="research-source">
                <span className="research-source-name">{place.label}</span>
                {sources.get(place.cite.source) && (
                  <span className="research-note">
                    {sources.get(place.cite.source)!.label}
                    {place.cite.lines && <> · {t.lines(place.cite.lines)}</>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="research-panel">
        <h5>{t.sources}</h5>
        <ul className="research-sources">
          {desk.sources.map((source) => <SourceLine key={source.id} source={source} info={sourceInfo(source.id)} />)}
        </ul>
      </section>
    </aside>
  );

  const views = { claim: claimView, evidence: evidenceView, history: historyView, next: nextView };
  return (
    <div className="research-desk" data-density={density} data-view={selection.view}>
      <header className="research-head">
        {desk.title && <h4>{desk.title}</h4>}
        <Radios
          label={t.viewsLabel}
          options={VIEWS}
          selected={selection.view}
          onSelect={(view) => choose({ view })}
          className="research-views"
          render={(view) => t.views[view]}
        />
      </header>
      {error && <p className="research-error" role="status">{t.readFailed(error)}</p>}
      <div className="research-layout">
        <nav className="research-claims" aria-label={t.claims}>
          <Radios
            label={t.claims}
            options={desk.claims.map((item) => item.id)}
            selected={selection.claim}
            onSelect={(id) => choose({ claim: id })}
            className="research-claim-list"
            render={(id, checked) => {
              const item = desk.claims.find((c) => c.id === id)!;
              return (
                <span className="research-claim-card" data-checked={checked || undefined}>
                  <span className="research-claim-title">{item.title}</span>
                  <span className="research-status" data-status={item.status}>{t.status[item.status]}</span>
                </span>
              );
            }}
          />
        </nav>
        <div className="research-main">{views[selection.view]}</div>
        {aside}
      </div>
    </div>
  );
}

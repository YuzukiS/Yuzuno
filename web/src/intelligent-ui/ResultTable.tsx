import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { strings, useStrings } from "../i18n";
import type { TableProps } from "./spec";
import { emptyView, useResult } from "./ResultContext";
import { SourceLinks } from "./SourceLinks";

// The table's own words (T-189); titles, labels and cells as written.
const text = strings({
  filter: (title: string) => `Filter ${title}`,
  filterHint: "Filter…",
  clearFilter: (title: string) => `Clear filter ${title}`,
  region: (title: string) => `${title} table`,
  select: "Select",
  selectRow: (name: string) => `Select ${name}`,
  sources: "Sources",
  noMatches: "No matches. Try another filter.",
  noRows: "No rows were provided.",
  count: (shown: number, total: number) => `${shown} of ${total} rows`,
  selected: (count: number) => `${count} selected`,
  clearSelection: "Clear selection",
  showAllRows: (count: number) => `Show all ${count} rows`,
  showFewerRows: "Show fewer",
}, {
  filter: (title) => `筛选${title}`,
  filterHint: "筛选…",
  clearFilter: (title) => `清除${title}的筛选`,
  region: (title) => `${title}表格`,
  select: "选择",
  selectRow: (name) => `选择 ${name}`,
  sources: "来源",
  noMatches: "没有匹配的行，换个筛选词试试。",
  noRows: "没有提供任何行。",
  count: (shown, total) => `${shown} / ${total} 行`,
  selected: (count) => `已选 ${count} 行`,
  clearSelection: "清除选择",
  showAllRows: (count) => `显示全部 ${count} 行`,
  showFewerRows: "收起",
});

/** A column every non-empty cell of which is a number: set right, in tabular figures. */
const numericColumn = (rows: TableProps["rows"], key: string) =>
  rows.some((row) => typeof row.cells[key] === "number") &&
  rows.every((row) => {
    const value = row.cells[key];
    return value === null || value === undefined || value === "" || typeof value === "number";
  });

/** Folding leaves at least this many rows out, or shows them all. */
const FOLD_SLACK = 2;

export function ResultTable({
  id,
  title,
  rows,
  columns: definitions,
  selectable = false,
  pageSize,
}: TableProps & {
  /** Home (T-9): show this many rows until "Show all", so a long table
   * reads as part of the page instead of a box that scrolls on its own;
   * the row count then shows only when it says something. A conversation's
   * result leaves it unset and shows every row and its count as before. */
  pageSize?: number;
}) {
  const t = useStrings(text);
  const { views, update } = useResult();
  const view = views[id] || emptyView;
  const columns = useMemo<ColumnDef<TableProps["rows"][number]>[]>(
    () =>
      definitions.map((column) => ({
        id: column.key,
        header: column.label,
        accessorFn: (row) => row.cells[column.key],
        cell: (info) => String(info.getValue() ?? "—"),
      })),
    [definitions],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    state: { globalFilter: view.filter, sorting: view.sort },
    globalFilterFn: (row, columnId, value) =>
      String(row.getValue(columnId) ?? "")
        .toLocaleLowerCase()
        .includes(String(value).toLocaleLowerCase()),
    onSortingChange: (value) =>
      update(id, {
        sort: typeof value === "function" ? value(view.sort) : value,
      }),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const matching = table.getRowModel().rows;
  const [all, setAll] = useState(false);
  const folds = pageSize !== undefined && matching.length > pageSize + FOLD_SLACK;
  const visibleRows = folds && !all ? matching.slice(0, pageSize) : matching;
  const numeric = useMemo(
    () => new Set(definitions.filter((column) => numericColumn(rows, column.key)).map((column) => column.key)),
    [definitions, rows],
  );
  const filtered = matching.length !== rows.length;
  const showCount = pageSize === undefined || filtered || (folds && !all);
  const validSelected = view.selected.filter((selected) =>
    rows.some((row) => row.id === selected),
  );
  const hasSources = rows.some((row) => row.sourceIds?.length);
  return (
    <section className="result-table-section" aria-label={title}>
      <div className="result-table-tools">
        <h4>{title}</h4>
        <label className="result-filter">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={t.filter(title)}
            placeholder={t.filterHint}
            value={view.filter}
            maxLength={200}
            onChange={(event) => update(id, { filter: event.target.value })}
          />
          {view.filter && (
            <button
              type="button"
              aria-label={t.clearFilter(title)}
              onClick={() => update(id, { filter: "" })}
            >
              <X size={13} />
            </button>
          )}
        </label>
      </div>
      <div
        className="result-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={t.region(title)}
      >
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {selectable && (
                  <th scope="col">
                    <span className="sr-only">{t.select}</span>
                  </th>
                )}
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    data-numeric={numeric.has(header.column.id) || undefined}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {header.column.getIsSorted() === "asc" ? (
                        <ArrowUp size={12} />
                      ) : header.column.getIsSorted() === "desc" ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUpDown size={12} />
                      )}
                    </button>
                  </th>
                ))}
                {hasSources && <th scope="col" className="result-sources-cell">{t.sources}</th>}
              </tr>
            ))}
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.id}
                data-selected={validSelected.includes(row.id) || undefined}
              >
                {selectable && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t.selectRow(String(row.original.cells[definitions[0].key] ?? row.id))}
                      checked={validSelected.includes(row.id)}
                      onChange={(event) =>
                        update(id, {
                          selected: event.target.checked
                            ? [...validSelected, row.id]
                            : validSelected.filter((key) => key !== row.id),
                        })
                      }
                    />
                  </td>
                )}
                {row.getVisibleCells().map((cell, index) => (
                  <td
                    key={cell.id}
                    data-numeric={numeric.has(cell.column.id) || undefined}
                    data-primary={index === 0 || undefined}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
                {hasSources && (
                  <td className="result-sources-cell">
                    <SourceLinks ids={row.original.sourceIds || []} compact />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleRows.length && (
          <p className="result-empty">
            {rows.length ? t.noMatches : t.noRows}
          </p>
        )}
      </div>
      {(showCount || folds || selectable) && (
        <div className="result-table-caption">
          {showCount && (
            <span>
              {t.count(pageSize === undefined ? matching.length : visibleRows.length, rows.length)}
            </span>
          )}
          {folds && (
            <button type="button" className="result-table-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? t.showFewerRows : t.showAllRows(matching.length)}
            </button>
          )}
          {selectable && (
            <span>
              {t.selected(validSelected.length)}
              {validSelected.length > 0 && (
                <>
                  {" "}
                  ·{" "}
                  <button
                    type="button"
                    onClick={() => update(id, { selected: [] })}
                  >
                    {t.clearSelection}
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

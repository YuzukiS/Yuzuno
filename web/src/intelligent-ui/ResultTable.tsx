import { useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import type { TableProps } from "./spec";
import { emptyView, useResult } from "./ResultContext";
import { SourceLinks } from "./SourceLinks";

export function ResultTable({
  id,
  title,
  rows,
  columns: definitions,
  selectable = false,
}: TableProps) {
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
  const visibleRows = table.getRowModel().rows;
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
            aria-label={`Filter ${title}`}
            placeholder="Filter…"
            value={view.filter}
            maxLength={200}
            onChange={(event) => update(id, { filter: event.target.value })}
          />
          {view.filter && (
            <button
              type="button"
              aria-label={`Clear filter ${title}`}
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
        aria-label={`${title} table`}
      >
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {selectable && (
                  <th scope="col">
                    <span className="sr-only">Select</span>
                  </th>
                )}
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
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
                {hasSources && <th scope="col">Sources</th>}
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
                      aria-label={`Select ${row.original.cells[definitions[0].key] ?? row.id}`}
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
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
                {hasSources && (
                  <td>
                    <SourceLinks ids={row.original.sourceIds || []} compact />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleRows.length && (
          <p className="result-empty">
            {rows.length
              ? "No matches. Try another filter."
              : "No rows were provided."}
          </p>
        )}
      </div>
      <div className="result-table-caption">
        <span>
          {visibleRows.length} of {rows.length} rows
        </span>
        {selectable && (
          <span>
            {validSelected.length} selected
            {validSelected.length > 0 && (
              <>
                {" "}
                ·{" "}
                <button
                  type="button"
                  onClick={() => update(id, { selected: [] })}
                >
                  Clear selection
                </button>
              </>
            )}
          </span>
        )}
      </div>
    </section>
  );
}

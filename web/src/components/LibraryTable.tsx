// The table view of the library (SPEC §2.2): one row per puzzle, with columns to sort (a click on a
// header) and to filter (the row under the headers), and a choice of the columns shown.
import type { DragEvent, ReactNode } from 'react';
import { entryRating, type IndexEntry } from '../core/library';
import { ActionMenu, type MenuItem, ratingTitle, statusText, Thumb } from './LibraryParts';
import { UniquenessBadge, uniquenessText } from './UniquenessBadge';

export type ColumnKey =
  | 'thumb'
  | 'name'
  | 'folder'
  | 'level'
  | 'moves'
  | 'unique'
  | 'rating'
  | 'balance'
  | 'print'
  | 'pieces'
  | 'voxels'
  | 'grid'
  | 'source'
  | 'designer'
  | 'created'
  | 'updated';

type SortValue = number | string | number[] | null;

interface Column {
  key: ColumnKey;
  label: string;
  title?: string;
  /** How the filter of the column reads (see `columnTest`); none: no filter. */
  filter: 'text' | 'number' | 'level' | 'date' | 'unique' | 'none';
  /** The text shown, and searched by text filters. */
  text: (e: IndexEntry) => string;
  /** The value sorted and compared by number filters; null (or '') sorts last. */
  value: (e: IndexEntry) => SortValue;
  cell?: (e: IndexEntry) => ReactNode;
  numeric?: boolean;
}

const pct = (x: number) => Math.round(100 * x);
const date = (iso: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '');
const time = (iso: string) => (iso ? Date.parse(iso) : null);
/** `10.4.2` → [10, 4, 2]; null when not solved. */
const levels = (e: IndexEntry) => (e.status === 'solved' && e.levelString ? e.levelString.split('.').map(Number) : null);

export const COLUMNS: Column[] = [
  { key: 'thumb', label: '', filter: 'none', text: () => '', value: () => null },
  { key: 'name', label: 'Name', filter: 'text', text: (e) => e.name, value: (e) => e.name },
  { key: 'folder', label: 'Folder', filter: 'text', text: (e) => e.folder.split('/').join(' › '), value: (e) => e.folder },
  {
    key: 'level',
    label: 'Level',
    title: 'The level string; a filter like ≥9 or 9..10 compares the level (its first number)',
    filter: 'level',
    text: (e) => (e.status === 'solved' ? (e.levelString ?? '') : statusText(e)),
    value: levels,
    cell: (e) => (e.status === 'solved' ? e.levelString : <span className={`card-status ${e.status ?? ''}`}>{statusText(e)}</span>),
  },
  { key: 'moves', label: 'Moves', title: 'Total moves of the disassembly', filter: 'number', numeric: true, text: (e) => (e.moves === null ? '' : String(e.moves)), value: (e) => e.moves },
  {
    key: 'unique',
    label: 'Uniqueness',
    title: 'The uniqueness check of the generator: unique, or N solutions / M assemblies',
    filter: 'unique',
    text: (e) => (e.uniqueness ? uniquenessText(e.uniqueness) : ''),
    value: (e) => (e.uniqueness ? (e.uniqueness.unique ? -1 : e.uniqueness.solutions) : null),
    cell: (e) => e.uniqueness && <UniquenessBadge check={{ kind: 'done', result: e.uniqueness }} />,
  },
  {
    key: 'rating',
    label: 'Rating',
    title: '0–100: half for balanced piece sizes, half for pieces easy to 3D print (as in the generator)',
    filter: 'number',
    numeric: true,
    text: (e) => String(entryRating(e).total),
    value: (e) => entryRating(e).total,
    cell: (e) => <span title={ratingTitle(entryRating(e))}>{entryRating(e).total}</span>,
  },
  { key: 'balance', label: 'Balance', title: 'Balance of the piece sizes, %', filter: 'number', numeric: true, text: (e) => String(pct(entryRating(e).balance)), value: (e) => pct(entryRating(e).balance) },
  { key: 'print', label: 'Print', title: 'Share of the voxels printed without supports, best face down, %', filter: 'number', numeric: true, text: (e) => String(pct(entryRating(e).print)), value: (e) => pct(entryRating(e).print) },
  { key: 'pieces', label: 'Pieces', filter: 'number', numeric: true, text: (e) => String(e.pieces), value: (e) => e.pieces },
  { key: 'voxels', label: 'Voxels', title: 'Fixed voxels', filter: 'number', numeric: true, text: (e) => String(e.voxels), value: (e) => e.voxels },
  { key: 'grid', label: 'Grid', title: 'Sorted by volume', filter: 'text', text: (e) => e.grid.join('×'), value: (e) => e.grid[0] * e.grid[1] * e.grid[2] },
  { key: 'source', label: 'Source', filter: 'text', text: (e) => e.source, value: (e) => e.source },
  { key: 'designer', label: 'Designer', filter: 'text', text: (e) => e.designer, value: (e) => e.designer },
  { key: 'created', label: 'Created', filter: 'date', text: (e) => date(e.created), value: (e) => time(e.created) },
  { key: 'updated', label: 'Updated', filter: 'date', text: (e) => date(e.updated), value: (e) => time(e.updated) },
];

export const DEFAULT_HIDDEN: ColumnKey[] = ['designer', 'created'];

const column = (key: ColumnKey) => COLUMNS.find((c) => c.key === key) ?? COLUMNS[1];

const FILTER_HINTS: Record<Column['filter'], string> = {
  text: 'contains',
  number: '>5, 3..8',
  level: '≥9, 8..10',
  date: '>2026-10',
  unique: '',
  none: '',
};

/** A number filter: `<5`, `<=5`, `>5`, `>=5` (or ≤ ≥), `=5`, `3..8` (and `3-8` for numbers); null when `f` is not one. */
function numberTest(f: string, kind: 'number' | 'level' | 'date'): ((x: number | null) => boolean) | null {
  const parse = (s: string) => (kind === 'date' ? Date.parse(s.trim()) : Number(s.trim().replace(',', '.')));
  const s = f.replace('≤', '<=').replace('≥', '>=');
  let m = /^(<=|>=|<|>|=)\s*(.+)$/.exec(s);
  if (m) {
    const [op, v] = [m[1], parse(m[2])];
    if (Number.isNaN(v)) return null;
    return (x) => x !== null && (op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === '>=' ? x >= v : x === v);
  }
  m = /^(.+?)\s*\.\.\s*(.+)$/.exec(s) ?? (kind === 'date' ? null : /^(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)$/.exec(s));
  if (m) {
    const [lo, hi] = [parse(m[1]), parse(m[2])];
    if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
    return (x) => x !== null && x >= lo && x <= hi;
  }
  if (kind === 'number' && /^\d+(?:[.,]\d+)?$/.test(s)) {
    const v = parse(s);
    return (x) => x === v;
  }
  return null;
}

function columnTest(c: Column, f: string): (e: IndexEntry) => boolean {
  if (c.filter === 'unique') {
    return (e) => (f === 'unique' ? !!e.uniqueness?.unique : f === 'multiple' ? !!e.uniqueness && !e.uniqueness.unique : !e.uniqueness);
  }
  if (c.filter === 'number' || c.filter === 'level' || c.filter === 'date') {
    const test = numberTest(f, c.filter);
    if (test) return (e) => test(c.filter === 'level' ? (levels(e)?.[0] ?? null) : (c.value(e) as number | null));
  }
  const needle = f.toLowerCase();
  // A level reads from its start: 9 finds 9 and 9.3, not 19.
  if (c.filter === 'level') return (e) => c.text(e).toLowerCase().startsWith(needle);
  return (e) => c.text(e).toLowerCase().includes(needle);
}

export type Filters = Partial<Record<ColumnKey, string>>;

export function activeFilters(filters: Filters): number {
  return Object.values(filters).filter((f) => f?.trim()).length;
}

/** The entries that pass every column filter, and the search: every word in the name, folder, level, source or designer. */
export function filterEntries(entries: IndexEntry[], filters: Filters, search: string): IndexEntry[] {
  const tests = COLUMNS.flatMap((c) => {
    const f = filters[c.key]?.trim();
    return f && c.filter !== 'none' ? [columnTest(c, f)] : [];
  });
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    tests.push((e) => {
      const text = [e.name, e.folder, e.levelString ?? statusText(e), e.source, e.designer].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }
  return tests.length === 0 ? entries : entries.filter((e) => tests.every((t) => t(e)));
}

export interface Sort {
  key: ColumnKey;
  desc: boolean;
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? -1) - (b[i] ?? -1);
      if (d !== 0) return d;
    }
  }
  return 0;
}

/** Sorted by a column; empty values last either way, then by name. */
export function sortEntries(entries: IndexEntry[], sort: Sort): IndexEntry[] {
  const c = column(sort.key);
  const keyed = entries.map((e) => {
    const v = c.value(e);
    return { e, v: v === '' ? null : v };
  });
  keyed.sort((x, y) => {
    if (x.v === null || y.v === null) return x.v === y.v ? compareValues(x.e.name, y.e.name) : x.v === null ? 1 : -1;
    return (sort.desc ? -1 : 1) * compareValues(x.v, y.v) || compareValues(x.e.name, y.e.name);
  });
  return keyed.map((k) => k.e);
}

export function LibraryTable({
  entries,
  hidden,
  sort,
  onSort,
  filters,
  onFilter,
  folderRows,
  selection,
  onSelect,
  onOpen,
  menu,
  onDragStart,
  empty,
}: {
  entries: IndexEntry[];
  hidden: ColumnKey[];
  sort: Sort;
  onSort: (sort: Sort) => void;
  filters: Filters;
  onFilter: (filters: Filters) => void;
  /** The rows of the subfolders, given the number of columns. */
  folderRows: (span: number) => ReactNode;
  /** Null when the puzzles cannot be selected (a read-only library). */
  selection: Set<string> | null;
  onSelect: (ids: string[], on: boolean) => void;
  onOpen: (e: IndexEntry) => void;
  menu: (e: IndexEntry) => MenuItem[];
  onDragStart: ((e: IndexEntry, event: DragEvent) => void) | null;
  /** The text of a table without puzzles; none when empty. */
  empty: string;
}) {
  const shown = COLUMNS.filter((c) => !hidden.includes(c.key));
  const span = shown.length + 2;
  const all = selection !== null && entries.length > 0 && entries.every((e) => selection.has(e.id));
  return (
    <table className="lib-table">
      <thead>
        <tr>
          <th className="pick">
            {selection && <input type="checkbox" aria-label="Select all" checked={all} onChange={(ev) => onSelect(entries.map((e) => e.id), ev.target.checked)} />}
          </th>
          {shown.map((c) => (
            <th
              key={c.key}
              title={c.title}
              className={`${c.numeric ? 'num' : ''} ${c.key === 'thumb' ? 'thumb-cell' : 'sortable'}`}
              onClick={() => c.key !== 'thumb' && onSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : c.numeric || c.filter === 'date' || c.key === 'level' })}
            >
              {c.label}
              {sort.key === c.key && <span className="sort-mark">{sort.desc ? ' ▼' : ' ▲'}</span>}
            </th>
          ))}
          <th />
        </tr>
        <tr className="filters">
          <th />
          {shown.map((c) => (
            <th key={c.key}>
              {c.filter === 'unique' ? (
                <select value={filters[c.key] ?? ''} onChange={(ev) => onFilter({ ...filters, [c.key]: ev.target.value })}>
                  <option value="">any</option>
                  <option value="unique">unique</option>
                  <option value="multiple">not unique</option>
                  <option value="unchecked">not checked</option>
                </select>
              ) : (
                c.filter !== 'none' && (
                  <input
                    value={filters[c.key] ?? ''}
                    placeholder={FILTER_HINTS[c.filter]}
                    aria-label={`Filter ${c.label}`}
                    onChange={(ev) => onFilter({ ...filters, [c.key]: ev.target.value })}
                  />
                )
              )}
            </th>
          ))}
          <th />
        </tr>
      </thead>
      <tbody>
        {folderRows(span)}
        {entries.map((e) => (
          <tr key={e.id} className={selection?.has(e.id) ? 'selected' : ''} draggable={onDragStart !== null} onDragStart={(ev) => onDragStart?.(e, ev)}>
            <td className="pick">{selection && <input type="checkbox" aria-label={`Select ${e.name}`} checked={selection.has(e.id)} onChange={(ev) => onSelect([e.id], ev.target.checked)} />}</td>
            {shown.map((c) =>
              c.key === 'thumb' ? (
                <td key={c.key} className="thumb-cell">
                  <Thumb key={e.rev} entry={e} className="small" onClick={() => onOpen(e)} />
                </td>
              ) : (
                <td key={c.key} className={`${c.numeric ? 'num' : ''} col-${c.key}`} onClick={c.key === 'name' ? () => onOpen(e) : undefined} title={c.key === 'name' || c.key === 'source' ? c.text(e) : undefined}>
                  {c.cell ? c.cell(e) : c.text(e)}
                </td>
              ),
            )}
            <td className="lib-row-actions">
              <button onClick={() => onOpen(e)}>Open</button>
              <ActionMenu items={menu(e)} />
            </td>
          </tr>
        ))}
        {entries.length === 0 && empty && (
          <tr>
            <td colSpan={span} className="dim empty-row">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

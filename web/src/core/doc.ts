// The editable form of a document: cells as indices `x + gx * (y + gy * z)` in sets, which makes
// painting and lookups cheap. Converted to and from the JSON document (SPEC §2.1).
import type { Meta, PuzzleDoc, Target, Vec3 } from '../types';

export const PALETTE = [
  '#e6194b', '#4363d8', '#3cb44b', '#f58231', '#911eb4', '#ffe119',
  '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324', '#fabed4',
];
export const MAX_GRID = 32;
export const MAX_PIECES = 32;

export interface EPiece {
  id: string;
  name: string;
  color: string;
  notchable: boolean;
  fixed: Set<number>;
  optional: Set<number>;
}

export interface ETarget {
  required: Set<number>;
  variable: Set<number>;
}

export interface EDoc {
  name: string;
  description: string;
  grid: Vec3;
  pieces: EPiece[];
  target: ETarget | null;
  meta: Meta;
}

export function cellIndex(grid: Vec3, [x, y, z]: Vec3): number {
  return x + grid[0] * (y + grid[1] * z);
}

export function cellCoords(grid: Vec3, i: number): Vec3 {
  const x = i % grid[0];
  const r = (i - x) / grid[0];
  const y = r % grid[1];
  return [x, y, (r - y) / grid[1]];
}

export function inGrid(grid: Vec3, v: Vec3): boolean {
  return v.every((c, a) => Number.isInteger(c) && c >= 0 && c < grid[a]);
}

function compareVec([a0, a1, a2]: Vec3, [b0, b1, b2]: Vec3): number {
  return a0 - b0 || a1 - b1 || a2 - b2;
}

/** Cells of a set as sorted voxels (the order puzzle-core writes). */
export function toVoxels(grid: Vec3, cells: Iterable<number>): Vec3[] {
  return [...cells].map((i) => cellCoords(grid, i)).sort(compareVec);
}

/** Voxels as a set of cells; voxels outside the grid are dropped. */
export function toCells(grid: Vec3, voxels: Vec3[]): Set<number> {
  return new Set(voxels.filter((v) => inGrid(grid, v)).map((v) => cellIndex(grid, v)));
}

export function fromDoc(doc: PuzzleDoc): EDoc {
  const grid: Vec3 = [...doc.grid];
  return {
    name: doc.name,
    description: doc.description ?? '',
    grid,
    pieces: doc.pieces.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      notchable: !!p.notchable,
      fixed: toCells(grid, p.fixed),
      optional: toCells(grid, p.optional ?? []),
    })),
    target: doc.target
      ? { required: toCells(grid, doc.target.required), variable: toCells(grid, doc.target.variable ?? []) }
      : null,
    // Imported files may leave fields out.
    meta: { designer: '', source: '', created: '', updated: '', ...(doc.meta as Partial<Meta> | undefined) },
  };
}

export function toTarget(grid: Vec3, t: ETarget): Target {
  return { required: toVoxels(grid, t.required), variable: toVoxels(grid, t.variable) };
}

export function toDoc(d: EDoc): PuzzleDoc {
  return {
    format: 'puzzle-generator',
    version: 1,
    name: d.name,
    description: d.description,
    grid: [...d.grid],
    pieces: d.pieces.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      notchable: p.notchable,
      fixed: toVoxels(d.grid, p.fixed),
      optional: toVoxels(d.grid, p.optional),
    })),
    target: d.target ? toTarget(d.grid, d.target) : null,
    meta: { ...d.meta },
  };
}

export function cloneDoc(d: EDoc): EDoc {
  return {
    ...d,
    grid: [...d.grid],
    pieces: d.pieces.map((p) => ({ ...p, fixed: new Set(p.fixed), optional: new Set(p.optional) })),
    target: d.target ? { required: new Set(d.target.required), variable: new Set(d.target.variable) } : null,
    meta: { ...d.meta },
  };
}

/**
 * Where a smaller grid keeps most of the document: the corner of the new grid in the old one that
 * drops the fewest fixed voxels, then the fewest optional marks, then the fewest target cells.
 */
export function cropOffset(d: EDoc, grid: Vec3): Vec3 {
  const [X, Y, Z] = d.grid;
  const n = grid.map((g, k) => Math.min(g, d.grid[k]));
  const at = (x: number, y: number, z: number) => (z * (Y + 1) + y) * (X + 1) + x;
  // The count of `cells` in each box of the new size, from 3D prefix sums.
  const counter = (cells: Iterable<number>) => {
    const s = new Float64Array((X + 1) * (Y + 1) * (Z + 1));
    for (const i of cells) {
      const [x, y, z] = cellCoords(d.grid, i);
      s[at(x + 1, y + 1, z + 1)]++;
    }
    for (let z = 1; z <= Z; z++)
      for (let y = 1; y <= Y; y++)
        for (let x = 1; x <= X; x++)
          s[at(x, y, z)] += s[at(x - 1, y, z)] + s[at(x, y - 1, z)] + s[at(x, y, z - 1)] - s[at(x - 1, y - 1, z)] - s[at(x - 1, y, z - 1)] - s[at(x, y - 1, z - 1)] + s[at(x - 1, y - 1, z - 1)];
    return ([a, b, c]: Vec3) => {
      const [e, f, g] = [a + n[0], b + n[1], c + n[2]];
      return s[at(e, f, g)] - s[at(a, f, g)] - s[at(e, b, g)] - s[at(e, f, c)] + s[at(a, b, g)] + s[at(a, f, c)] + s[at(e, b, c)] - s[at(a, b, c)];
    };
  };
  const counts = [
    counter(d.pieces.flatMap((p) => [...p.fixed])),
    counter(d.pieces.flatMap((p) => [...p.optional])),
    counter(d.target ? [...d.target.required, ...d.target.variable] : []),
  ];
  let best: Vec3 = [0, 0, 0];
  let kept = counts.map((c) => c(best));
  for (let c = 0; c <= Z - n[2]; c++)
    for (let b = 0; b <= Y - n[1]; b++)
      for (let a = 0; a <= X - n[0]; a++) {
        const k = counts.map((f) => f([a, b, c]));
        const m = k.findIndex((v, i) => v !== kept[i]);
        if (m >= 0 && k[m] > kept[m]) [best, kept] = [[a, b, c], k];
      }
  return best;
}

/** The same document on a new grid whose corner is at `offset` in the old one; cells outside it are dropped. */
export function resizeGrid(d: EDoc, grid: Vec3, offset: Vec3 = [0, 0, 0]): EDoc {
  const move = (cells: Set<number>) => {
    const out = new Set<number>();
    for (const i of cells) {
      const v = cellCoords(d.grid, i).map((c, k) => c - offset[k]) as Vec3;
      if (inGrid(grid, v)) out.add(cellIndex(grid, v));
    }
    return out;
  };
  return {
    ...cloneDoc(d),
    grid: [...grid],
    pieces: d.pieces.map((p) => ({ ...p, fixed: move(p.fixed), optional: move(p.optional) })),
    target: d.target ? { required: move(d.target.required), variable: move(d.target.variable) } : null,
  };
}

/** A piece id not used in the document. */
export function newPieceId(d: EDoc): string {
  const used = new Set(d.pieces.map((p) => p.id));
  let n = d.pieces.length;
  while (used.has(`p${n}`)) n++;
  return `p${n}`;
}

export function newPiece(d: EDoc): EPiece {
  const index = d.pieces.length;
  return {
    id: newPieceId(d),
    name: String.fromCharCode(65 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : ''),
    color: PALETTE[index % PALETTE.length],
    notchable: false,
    fixed: new Set(),
    optional: new Set(),
  };
}

export function emptyDoc(grid: Vec3 = [8, 8, 8]): EDoc {
  const d: EDoc = {
    name: 'Untitled',
    description: '',
    grid,
    pieces: [],
    target: null,
    meta: { designer: '', source: '', created: '', updated: '' },
  };
  d.pieces.push(newPiece(d));
  d.pieces.push(newPiece(d));
  return d;
}

/** The fixed voxels of each piece and the grid: everything the live check depends on (SPEC §3.4). */
export function fixedSignature(d: EDoc): string {
  return JSON.stringify([d.grid, d.pieces.map((p) => [...p.fixed].sort((a, b) => a - b))]);
}

/** Bit mask of piece indices as a list of names. */
export function maskNames(names: string[], mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) if ((mask >>> i) & 1) out.push(names[i]);
  return out;
}

const sameSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Whether two documents have the same content (an edit that changed nothing is not recorded). */
export function docEquals(a: EDoc, b: EDoc): boolean {
  const target =
    a.target === null || b.target === null
      ? a.target === b.target
      : sameSet(a.target.required, b.target.required) && sameSet(a.target.variable, b.target.variable);
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.grid.every((g, k) => g === b.grid[k]) &&
    a.pieces.length === b.pieces.length &&
    a.pieces.every((p, i) => {
      const q = b.pieces[i];
      return (
        p.id === q.id && p.name === q.name && p.color === q.color && p.notchable === q.notchable &&
        sameSet(p.fixed, q.fixed) && sameSet(p.optional, q.optional)
      );
    }) &&
    target &&
    JSON.stringify(a.meta) === JSON.stringify(b.meta)
  );
}

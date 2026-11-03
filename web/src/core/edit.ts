// Editing operations (SPEC §7). Each one mutates a draft document (see `cloneDoc`) and keeps the
// cell rules of SPEC §1.3: a cell is fixed for at most one piece, and never optional for a piece
// while fixed for another.
import type { Vec3 } from '../types';
import { type EDoc, cellCoords, cellIndex, inGrid, newPiece } from './doc';

export type CellState = 'fixed' | 'optional';
export type TargetKind = 'required' | 'variable' | 'erase';

/** Makes the cell fixed for piece `p`, taking it from every other piece. */
export function paintFixed(d: EDoc, p: number, cell: number): void {
  d.pieces.forEach((q, i) => {
    if (i !== p) {
      q.fixed.delete(cell);
      q.optional.delete(cell);
    }
  });
  d.pieces[p].optional.delete(cell);
  d.pieces[p].fixed.add(cell);
}

/** Makes the cell optional for the pieces `ps`; false when it is fixed for another piece. */
export function paintOptional(d: EDoc, ps: number[], cell: number): boolean {
  if (d.pieces.some((q, i) => !ps.includes(i) && q.fixed.has(cell))) return false;
  for (const p of ps) {
    d.pieces[p].fixed.delete(cell);
    d.pieces[p].optional.add(cell);
  }
  return true;
}

/** Paints the cell for the pieces `ps`: a fixed voxel for the first one only, an optional mark for each. */
export function paint(d: EDoc, ps: number[], cell: number, state: CellState): boolean {
  if (state === 'fixed') {
    paintFixed(d, ps[0], cell);
    return true;
  }
  return paintOptional(d, ps, cell);
}

/** Whether `paint` would change the cell. */
export function paintChanges(d: EDoc, ps: number[], cell: number, state: CellState): boolean {
  if (state === 'fixed') return !d.pieces[ps[0]].fixed.has(cell);
  return !ps.every((p) => d.pieces[p].optional.has(cell)) && !d.pieces.some((q, i) => !ps.includes(i) && q.fixed.has(cell));
}

/** Empties the cell: the fixed voxel of any piece and the optional marks of the pieces `ps`. */
export function erase(d: EDoc, ps: number[], cell: number): void {
  for (const q of d.pieces) q.fixed.delete(cell);
  for (const p of ps) d.pieces[p]?.optional.delete(cell);
}

/** Toggles a cell of piece `p` between fixed and optional (the brush). */
export function toggleState(d: EDoc, p: number, cell: number): void {
  const piece = d.pieces[p];
  if (piece.fixed.has(cell)) {
    piece.fixed.delete(cell);
    piece.optional.add(cell);
  } else if (piece.optional.has(cell)) {
    paintFixed(d, p, cell);
  }
}

/** Every cell of the grid. */
export function gridCells(grid: Vec3): number[] {
  return Array.from({ length: grid[0] * grid[1] * grid[2] }, (_, i) => i);
}

/** The cells of the box spanned by two cells. */
export function boxCells(grid: Vec3, a: Vec3, b: Vec3): number[] {
  const lo = [0, 1, 2].map((k) => Math.min(a[k], b[k]));
  const hi = [0, 1, 2].map((k) => Math.max(a[k], b[k]));
  const out: number[] = [];
  for (let z = lo[2]; z <= hi[2]; z++)
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let x = lo[0]; x <= hi[0]; x++) if (inGrid(grid, [x, y, z])) out.push(cellIndex(grid, [x, y, z]));
  return out;
}

/** The cells of a straight line between two cells (a 3D DDA). */
export function lineCells(grid: Vec3, a: Vec3, b: Vec3): number[] {
  const n = Math.max(...[0, 1, 2].map((k) => Math.abs(b[k] - a[k])));
  const out = new Set<number>();
  for (let s = 0; s <= n; s++) {
    const t = n === 0 ? 0 : s / n;
    const v = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as Vec3;
    if (inGrid(grid, v)) out.add(cellIndex(grid, v));
  }
  return [...out];
}

export const AXIS_DIRS: Record<string, Vec3> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};

/**
 * Moves the content of the selected cells (every piece's fixed voxels and optional marks) by one
 * cell. Returns the moved selection, or an error message when a cell would leave the grid or land
 * on a conflicting cell.
 */
export function moveSelection(d: EDoc, selection: Set<number>, step: Vec3): Set<number> | string {
  const target = new Map<number, number>();
  for (const i of selection) {
    const v = cellCoords(d.grid, i);
    const w: Vec3 = [v[0] + step[0], v[1] + step[1], v[2] + step[2]];
    if (!inGrid(d.grid, w)) return 'The selection would leave the grid';
    target.set(i, cellIndex(d.grid, w));
  }
  const lifted = d.pieces.map((p) => ({
    fixed: [...selection].filter((i) => p.fixed.has(i)),
    optional: [...selection].filter((i) => p.optional.has(i)),
  }));
  d.pieces.forEach((p, k) => {
    for (const i of lifted[k].fixed) p.fixed.delete(i);
    for (const i of lifted[k].optional) p.optional.delete(i);
  });
  // A destination outside the selection keeps its content, so it must agree with what lands on it.
  for (let k = 0; k < d.pieces.length; k++) {
    for (const i of lifted[k].fixed) {
      const j = target.get(i)!;
      if (d.pieces.some((q, n) => n !== k && (q.fixed.has(j) || q.optional.has(j)))) {
        return 'The selection would overlap another piece';
      }
    }
    for (const i of lifted[k].optional) {
      const j = target.get(i)!;
      if (d.pieces.some((q, n) => n !== k && q.fixed.has(j))) return 'The selection would overlap another piece';
    }
  }
  d.pieces.forEach((p, k) => {
    for (const i of lifted[k].fixed) {
      p.optional.delete(target.get(i)!);
      p.fixed.add(target.get(i)!);
    }
    for (const i of lifted[k].optional) if (!p.fixed.has(target.get(i)!)) p.optional.add(target.get(i)!);
  });
  return new Set([...selection].map((i) => target.get(i)!));
}

/**
 * Moves the pieces `ps` (fixed voxels and optional marks) by one cell, or returns an error message
 * when a fixed voxel would leave the grid or land on another piece's voxel. Optional marks that
 * would leave the grid are dropped. The moved voxels take their cells from the optional marks of
 * the other pieces, and the moved marks give way to their voxels.
 */
export function movePieces(d: EDoc, ps: number[], step: Vec3): string | undefined {
  const to = (i: number) => {
    const v = cellCoords(d.grid, i);
    const w: Vec3 = [v[0] + step[0], v[1] + step[1], v[2] + step[2]];
    return inGrid(d.grid, w) ? cellIndex(d.grid, w) : -1;
  };
  const moved = ps.map((p) => ({
    fixed: [...d.pieces[p].fixed].map(to),
    optional: [...d.pieces[p].optional].map(to).filter((c) => c >= 0),
  }));
  if (moved.some((m) => m.fixed.includes(-1))) return 'The pieces would leave the grid';
  const others = d.pieces.filter((_, i) => !ps.includes(i));
  if (moved.some((m) => m.fixed.some((c) => others.some((q) => q.fixed.has(c))))) return 'The pieces would overlap another piece';
  ps.forEach((p, k) => {
    d.pieces[p].fixed = new Set(moved[k].fixed);
    d.pieces[p].optional = new Set(moved[k].optional.filter((c) => !others.some((q) => q.fixed.has(c))));
  });
  for (const m of moved) for (const c of m.fixed) for (const q of others) q.optional.delete(c);
  return undefined;
}

export interface BlockOptions {
  /** Width, height and length; the length runs along `axis`. */
  size: Vec3;
  /** The corner with the lowest coordinates. */
  position: Vec3;
  axis: 0 | 1 | 2;
  /** A piece index, or 'new' to add a piece. */
  piece: number | 'new';
  state: CellState;
}

/** The cells of a W×H×L block (the stick tool), or an error message. */
export function blockCells(grid: Vec3, o: BlockOptions): number[] | string {
  const extent = [0, 0, 0] as Vec3;
  extent[o.axis] = o.size[2];
  extent[(o.axis + 1) % 3] = o.size[0];
  extent[(o.axis + 2) % 3] = o.size[1];
  if (extent.some((e) => !Number.isInteger(e) || e < 1)) return 'Sizes must be positive integers';
  const far: Vec3 = [0, 1, 2].map((k) => o.position[k] + extent[k] - 1) as Vec3;
  if (!inGrid(grid, o.position) || !inGrid(grid, far)) return 'The block does not fit in the grid';
  return boxCells(grid, o.position, far);
}

/** Places a block; returns the index of the piece painted, or an error message. */
export function placeBlock(d: EDoc, o: BlockOptions): number | string {
  const cells = blockCells(d.grid, o);
  if (typeof cells === 'string') return cells;
  let p = o.piece;
  if (p === 'new') {
    d.pieces.push(newPiece(d));
    p = d.pieces.length - 1;
  }
  for (const c of cells) paint(d, [p], c, o.state);
  return p;
}

export function paintTarget(d: EDoc, cell: number, kind: TargetKind): void {
  d.target ??= { required: new Set(), variable: new Set() };
  d.target.required.delete(cell);
  d.target.variable.delete(cell);
  if (kind !== 'erase') d.target[kind].add(cell);
}

/** A zone of the grid: its outer cells (`required`) and its inside (`variable`), as for a target. */
export interface Shape {
  required: Set<number>;
  variable: Set<number>;
}

/** The cells of `inside` with a neighbour outside are required, the others variable. */
function shellShape(grid: Vec3, inside: (v: Vec3) => boolean): Shape {
  const shape: Shape = { required: new Set(), variable: new Set() };
  for (const i of gridCells(grid)) {
    const v = cellCoords(grid, i);
    if (!inside(v)) continue;
    const outer = Object.values(AXIS_DIRS).some((s) => !inside([v[0] + s[0], v[1] + s[1], v[2] + s[2]]));
    (outer ? shape.required : shape.variable).add(i);
  }
  return shape;
}

/** The whole grid: the cells of its outer faces required, the inside variable. */
export function cubeShape(grid: Vec3): Shape {
  return shellShape(grid, (v) => inGrid(grid, v));
}

/** The ellipsoid inscribed in the grid (a sphere in a cubic grid), by the centres of its cells. */
export function sphereShape(grid: Vec3): Shape {
  return shellShape(grid, (v) => inGrid(grid, v) && v.reduce((s, c, k) => s + ((c + 0.5 - grid[k] / 2) / (grid[k] / 2)) ** 2, 0) <= 1);
}

/**
 * Marks the cells optional for the pieces `ps`, except the cells holding a fixed voxel; returns how
 * many marks were added.
 */
export function fillOptional(d: EDoc, ps: number[], cells: Iterable<number>): number {
  let count = 0;
  for (const c of cells) {
    const owner = d.pieces.findIndex((q) => q.fixed.has(c));
    if (owner >= 0) continue;
    for (const p of ps) {
      if (d.pieces[p].optional.has(c)) continue;
      d.pieces[p].optional.add(c);
      count++;
    }
  }
  return count;
}

/** Removes every optional mark of the pieces `ps`; returns how many. */
export function clearOptional(d: EDoc, ps: number[]): number {
  let count = 0;
  for (const p of ps) {
    count += d.pieces[p].optional.size;
    d.pieces[p].optional.clear();
  }
  return count;
}

export function removePiece(d: EDoc, p: number): void {
  d.pieces.splice(p, 1);
}

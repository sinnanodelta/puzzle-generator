// Editor actions shared by the layer view, the 3D view and the keyboard (SPEC §7).
import { cellCoords, type EPiece, inGrid, MAX_GRID } from './core/doc';
import { erase, paint, paintTarget, toggleState } from './core/edit';
import { editDoc, getState, type Mat3, notify, redo, setState, type State, type Tool, undo, type ViewMode } from './store';
import type { Vec3 } from './types';

/**
 * Applies a painting tool to cells. `eraseMode` (right button or Alt) empties the cells, or clears
 * their target mark with the target tool.
 */
export function applyTool(tool: Tool, cells: number[], eraseMode: boolean): void {
  const { current, paintState, targetKind } = getState();
  const pieces = paintedPieces(getState());
  let conflicts = 0;
  editDoc((d) => {
    if (tool === 'target') {
      for (const c of cells) paintTarget(d, c, eraseMode ? 'erase' : targetKind);
      return;
    }
    if (!d.pieces[current]) return 'Add a piece first';
    for (const c of cells) {
      if (eraseMode || tool === 'eraser') erase(d, pieces, c);
      else if (tool === 'brush') toggleState(d, current, c);
      else if (!paint(d, pieces, c, paintState)) conflicts++;
    }
  });
  if (conflicts > 0) notify(`${conflicts} cell(s) fixed for another piece were left alone`);
}

/**
 * The pieces the tools paint: the current one first, then the pieces selected with it. Fixed voxels
 * and the toggle tool only go to the first.
 */
export function paintedPieces(s: Pick<State, 'doc' | 'current' | 'paintedWith'>): number[] {
  if (!s.doc.pieces[s.current]) return [];
  const others = s.doc.pieces.flatMap((p, i) => (i !== s.current && s.paintedWith.includes(p.id) ? [i] : []));
  return [s.current, ...others];
}

/**
 * Picks a piece of the piece list: 'only' paints it alone, 'toggle' (Ctrl) adds it to the selected
 * pieces or removes it, 'range' (Shift) selects the pieces from the current one to it.
 */
export function pickPiece(i: number, mode: 'only' | 'toggle' | 'range'): void {
  const { doc, current, paintedWith } = getState();
  const piece = doc.pieces[i];
  if (!piece) return;
  if (mode === 'only' || !doc.pieces[current]) {
    setState({ current: i, paintedWith: [] });
  } else if (mode === 'range') {
    const lo = Math.min(i, current);
    const range = doc.pieces.slice(lo, Math.max(i, current) + 1);
    setState({ paintedWith: range.filter((_, k) => lo + k !== current).map((p) => p.id) });
  } else if (i !== current) {
    setState({ paintedWith: paintedWith.includes(piece.id) ? paintedWith.filter((id) => id !== piece.id) : [...paintedWith, piece.id] });
  } else {
    // The current piece leaves the selection: the next selected one takes its place.
    const next = doc.pieces.findIndex((p, k) => k !== current && paintedWith.includes(p.id));
    if (next >= 0) setState({ current: next, paintedWith: paintedWith.filter((id) => id !== doc.pieces[next].id) });
  }
}

/** Removes the optional mark of one piece. */
export function eraseOptional(piece: number, cell: number): void {
  editDoc((d) => {
    d.pieces[piece]?.optional.delete(cell);
  });
}

/** Adds cells to the selection, removes them, or replaces it. */
export function select(cells: number[], mode: 'replace' | 'add' | 'toggle'): void {
  const selection = mode === 'replace' ? new Set<number>() : new Set(getState().selection);
  for (const c of cells) {
    if (mode === 'toggle' && selection.has(c)) selection.delete(c);
    else selection.add(c);
  }
  setState({ selection });
}

export function setSlice(slice: number): void {
  const { doc, axis } = getState();
  setState({ slice: Math.max(0, Math.min(doc.grid[axis] - 1, slice)) });
}

export function setAxis(axis: 0 | 1 | 2): void {
  const { doc, axis: old, slice } = getState();
  if (axis === old) return;
  setState({ axis, slice: Math.min(slice, doc.grid[axis] - 1) });
}

/** The tools whose left click adds a voxel of the current piece (in the 3D view, box and line act as the pencil). */
export const addsVoxels = (tool: Tool) => tool === 'pencil' || tool === 'box' || tool === 'line';

export const sameCell = (a: Vec3 | null, b: Vec3 | null) => a === b || (!!a && !!b && a.every((c, k) => c === b[k]));

export function setHoverCell(cell: Vec3 | null): void {
  if (!sameCell(cell, getState().hoverCell)) setState({ hoverCell: cell });
}

/** The orientation of the 3D views with the puzzle Z axis up. */
export const UPRIGHT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Quarter turns (+90°, right-handed) about X, Y and Z. */
const QUARTER_TURNS: Mat3[] = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [0, 0, 1, 0, 1, 0, -1, 0, 0],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
];

export const isUpright = (m: Mat3) => m.every((v, n) => v === UPRIGHT[n]);

/** Turns the 3D views a quarter turn about an axis of the puzzle; the document does not change. */
export function turnView(axis: 0 | 1 | 2): void {
  const r = getState().orientation;
  const q = QUARTER_TURNS[axis];
  // r·q: the turn is about the puzzle axis, wherever the current orientation shows it.
  const orientation = r.map((_, n) => {
    const i = n - (n % 3);
    const j = n % 3;
    return r[i] * q[j] + r[i + 1] * q[3 + j] + r[i + 2] * q[6 + j];
  });
  setState({ orientation });
}

/** How a piece is drawn, with isolation applied: an isolated piece ghosts all the others. */
export function pieceMode(s: Pick<State, 'viewModes' | 'isolate'>, piece: EPiece): ViewMode {
  const mode = s.viewModes[piece.id] ?? 'normal';
  if (s.isolate && s.isolate !== piece.id && mode === 'normal') return 'ghost';
  return mode;
}

/** The cells of the selection as voxels. */
export function selectionVoxels(): Vec3[] {
  const { doc, selection } = getState();
  return [...selection].map((i) => cellCoords(doc.grid, i)).filter((v) => inGrid(doc.grid, v));
}

export const clampGrid = (n: number) => Math.max(1, Math.min(MAX_GRID, Math.round(n) || 1));

const TOOL_KEYS: Record<string, Tool> = {
  p: 'pencil', e: 'eraser', b: 'box', l: 'line', t: 'brush', s: 'select', g: 'target',
};

/** Keyboard shortcuts of the editor; returns whether the key was used. */
export function editorKey(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === 'z') {
    if (e.shiftKey) redo();
    else undo();
    return true;
  }
  if (ctrl && key === 'y') {
    redo();
    return true;
  }
  if (ctrl || e.altKey) return false;
  if (e.key === '[' || e.key === ']') {
    setSlice(getState().slice + (e.key === ']' ? 1 : -1));
    return true;
  }
  if (e.key === 'Escape') {
    setState({ selection: new Set() });
    return true;
  }
  if (key === 'f' || key === 'o') {
    setState({ paintState: key === 'f' ? 'fixed' : 'optional' });
    return true;
  }
  const tool = TOOL_KEYS[key];
  if (tool) {
    setState({ tool });
    return true;
  }
  return false;
}

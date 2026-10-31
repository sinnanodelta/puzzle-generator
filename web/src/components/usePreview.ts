// The hover preview of the editor (SPEC §7): the voxel a left click would add, drawn by both views
// while the pointer is over its cell in either of them. Holding Shift hides it.
import { useEffect, useMemo, useState } from 'react';
import { addsVoxels, paintedPieces } from '../actions';
import { cellIndex, inGrid } from '../core/doc';
import { type CellState, paintChanges } from '../core/edit';
import { useStore } from '../store';
import type { Vec3 } from '../types';

export interface Preview {
  cell: Vec3;
  state: CellState;
  color: string;
}

/** Whether Shift is held, from the keyboard events of the window. */
function useShiftHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setHeld(e.shiftKey);
    const onBlur = () => setHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return held;
}

/** The voxel to preview, or null when there is none (a click there would change nothing). */
export function usePreview(): Preview | null {
  const enabled = useStore((s) => s.hoverPreview);
  const cell = useStore((s) => s.hoverCell);
  const tool = useStore((s) => s.tool);
  const doc = useStore((s) => s.doc);
  const current = useStore((s) => s.current);
  const paintedWith = useStore((s) => s.paintedWith);
  const state = useStore((s) => s.paintState);
  const shift = useShiftHeld();
  const piece = doc.pieces[current];
  const shown =
    enabled &&
    !shift &&
    addsVoxels(tool) &&
    !!cell &&
    !!piece &&
    inGrid(doc.grid, cell) &&
    paintChanges(doc, paintedPieces({ doc, current, paintedWith }), cellIndex(doc.grid, cell), state);
  const color = piece?.color;
  return useMemo(() => (shown && cell && color ? { cell, state, color } : null), [shown, cell, state, color]);
}

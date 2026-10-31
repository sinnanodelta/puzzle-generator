// The 3D view of the editor (SPEC §7.1): click a face to add a voxel next to it, click a voxel to
// erase it (eraser, right button or Alt). The current layer of the layer view is outlined, and
// clicking its plane paints the cell under the pointer. Hovering previews the voxel a click adds.
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { applyTool, eraseOptional, pieceMode, select, setHoverCell } from '../actions';
import { cellIndex, inGrid, toVoxels } from '../core/doc';
import { disposeGeometry, gridAxisGeometry, gridBoxGeometry, pieceGeometry } from '../core/geometry';
import { getState, useStore } from '../store';
import type { Vec3 } from '../types';
import { usePreview } from './usePreview';
import { AXIS_COLORS, Lines, Markers, noRaycast, PieceMesh, Viewport } from './Viewport';

/** The cell clicked on a piece face, and the empty cell in front of that face. */
function pickFace(e: ThreeEvent<MouseEvent>): { cell: Vec3; front: Vec3 } | null {
  if (!e.face) return null;
  const p = e.object.worldToLocal(e.point.clone());
  const n = [e.face.normal.x, e.face.normal.y, e.face.normal.z].map(Math.round);
  const cell = [p.x, p.y, p.z].map((c, k) => Math.floor(c - 0.5 * n[k])) as Vec3;
  return { cell, front: cell.map((c, k) => c + n[k]) as Vec3 };
}

function useLines(make: () => THREE.BufferGeometry, deps: unknown[]): THREE.BufferGeometry {
  // The geometry is rebuilt when a dependency changes and disposed with the previous one.
  const g = useMemo(make, deps);
  useEffect(() => () => g.dispose(), [g]);
  return g;
}

function SliceOutline({ grid, axis, slice }: { grid: Vec3; axis: number; slice: number }) {
  const g = useLines(() => {
    const size = [...grid] as Vec3;
    size[axis] = 1;
    const box = new THREE.BoxGeometry(...size);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    const at = grid.map((n) => n / 2) as Vec3;
    at[axis] = slice + 0.5;
    edges.translate(...at);
    return edges;
  }, [grid.join(), axis, slice]);
  return <Lines geometry={g} color="#4da3ff" opacity={0.9} />;
}

/** The edges of the grid box through the origin, in the colours of the axes. */
function GridAxes({ grid }: { grid: Vec3 }) {
  const lines = useMemo(() => [0, 1, 2].map((k) => gridAxisGeometry(grid, k)), [grid.join()]);
  useEffect(() => () => lines.forEach((g) => g.dispose()), [lines]);
  return lines.map((g, k) => <Lines key={k} geometry={g} color={AXIS_COLORS[k]} opacity={0.9} />);
}

function SelectionOutline({ voxels }: { voxels: Vec3[] }) {
  const key = voxels.map((v) => v.join()).join(';');
  // The key stands for the voxels, whose array is new on every render.
  const g = useMemo(() => pieceGeometry(voxels), [key]);
  useEffect(() => () => disposeGeometry(g), [g]);
  return <Lines geometry={g.creases} color="#ffd400" onTop />;
}

export function Scene3D() {
  const doc = useStore((s) => s.doc);
  const viewModes = useStore((s) => s.viewModes);
  const isolate = useStore((s) => s.isolate);
  const current = useStore((s) => s.current);
  const paintedWith = useStore((s) => s.paintedWith);
  const tool = useStore((s) => s.tool);
  const showTarget = useStore((s) => s.showTarget);
  const axis = useStore((s) => s.axis);
  const slice = useStore((s) => s.slice);
  const selection = useStore((s) => s.selection);
  const preview = usePreview();
  const group = useRef<THREE.Group>(null);
  // The object under the pointer that set the hover cell: leaving another one keeps the cell.
  const hoverSource = useRef<string | null>(null);
  const grid = doc.grid;

  useEffect(() => () => setHoverCell(null), []);

  const box = useLines(() => gridBoxGeometry(grid), [grid.join()]);
  const pieces = useMemo(
    () =>
      doc.pieces.map((p) => ({
        piece: p,
        fixed: toVoxels(grid, p.fixed),
        optional: toVoxels(grid, p.optional),
      })),
    [doc.pieces, grid],
  );
  const target = useMemo(
    () => doc.target && { required: toVoxels(grid, doc.target.required), variable: toVoxels(grid, doc.target.variable) },
    [doc.target, grid],
  );
  const selected = useMemo(() => toVoxels(grid, selection), [selection, grid]);

  const onFace = (e: ThreeEvent<MouseEvent>, eraseMode: boolean) => {
    const hit = pickFace(e);
    if (!hit || !inGrid(grid, hit.cell)) return;
    const t = getState().tool;
    const cell = cellIndex(grid, hit.cell);
    if (eraseMode || t === 'eraser') applyTool('eraser', [cell], true);
    else if (t === 'select') select([cell], 'toggle');
    else if (t === 'brush' || t === 'target') applyTool(t, [cell], false);
    else if (inGrid(grid, hit.front)) applyTool('pencil', [cellIndex(grid, hit.front)], false);
  };

  /**
   * The pointer moved over an object (`e`), or left it (null). `cellOf` gives the cell a left click
   * there would paint with the pencil.
   */
  const hoverOn = (source: string, e: ThreeEvent<PointerEvent> | null, cellOf: () => Vec3 | null) => {
    if (!e) {
      if (hoverSource.current !== source) return;
      hoverSource.current = null;
      setHoverCell(null);
      return;
    }
    hoverSource.current = source;
    // No preview while a button is down: the pointer is orbiting the view.
    const cell = e.nativeEvent.buttons === 0 ? cellOf() : null;
    setHoverCell(cell && inGrid(grid, cell) ? cell : null);
  };

  const onOptional = (piece: number) => (v: Vec3, eraseMode: boolean) => {
    const t = getState().tool;
    const cell = cellIndex(grid, v);
    if (eraseMode || t === 'eraser') eraseOptional(piece, cell);
    else if (t === 'select') select([cell], 'toggle');
    else if (t === 'brush') {
      if (piece === getState().current) applyTool('brush', [cell], false);
    } else applyTool(t === 'target' ? 'target' : 'pencil', [cell], false);
  };

  // The plane through the middle of the current layer; it takes clicks of the adding tools only.
  const planeSize = grid.filter((_, k) => k !== axis) as [number, number];
  const planeAt = grid.map((n) => n / 2) as Vec3;
  planeAt[axis] = slice + 0.5;
  const planeRotation: Vec3 = axis === 0 ? [0, Math.PI / 2, 0] : axis === 1 ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  if (axis === 0) planeSize.reverse();
  const adding = tool === 'pencil' || tool === 'box' || tool === 'line' || tool === 'target';
  const onPlane = (e: ThreeEvent<MouseEvent>, eraseMode: boolean) => {
    if (e.delta > 4 || !group.current) return;
    e.stopPropagation();
    const p = group.current.worldToLocal(e.point.clone());
    const v = [p.x, p.y, p.z].map(Math.floor) as Vec3;
    v[axis] = slice;
    if (!inGrid(grid, v)) return;
    const t = getState().tool;
    applyTool(t === 'target' ? 'target' : 'pencil', [cellIndex(grid, v)], eraseMode || e.nativeEvent.altKey);
  };
  const onPlaneHover = (e: ThreeEvent<PointerEvent> | null) => {
    e?.stopPropagation();
    hoverOn('plane', e, () => {
      if (!e || !group.current) return null;
      const p = group.current.worldToLocal(e.point.clone());
      const v = [p.x, p.y, p.z].map(Math.floor) as Vec3;
      v[axis] = slice;
      return v;
    });
  };

  const state = { viewModes, isolate };
  return (
    <Viewport size={Math.max(...grid)} center={grid.map((n) => n / 2) as Vec3} groupRef={group}>
      <Lines geometry={box} color="#5a6270" opacity={0.6} />
      <GridAxes grid={grid} />
      <SliceOutline grid={grid} axis={axis} slice={slice} />
      <mesh
        position={planeAt}
        rotation={planeRotation}
        raycast={adding ? THREE.Mesh.prototype.raycast : noRaycast}
        onClick={(e) => onPlane(e, false)}
        onContextMenu={(e) => onPlane(e, true)}
        onPointerMove={onPlaneHover}
        onPointerOut={() => onPlaneHover(null)}
      >
        <planeGeometry args={planeSize} />
        <meshBasicMaterial color="#4da3ff" transparent opacity={0.06} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {pieces.map(({ piece, fixed, optional }, i) => {
        const mode = pieceMode(state, piece);
        if (mode === 'hidden') return null;
        const ghost = mode === 'ghost';
        return (
          <group key={piece.id}>
            <PieceMesh
              voxels={fixed}
              color={piece.color}
              opacity={ghost ? 0.15 : 1}
              emissive={(i === current || paintedWith.includes(piece.id)) && !ghost ? '#1a1a1a' : '#000000'}
              onPick={ghost ? undefined : onFace}
              onHover={ghost ? undefined : (e) => hoverOn(`${piece.id}:fixed`, e, () => (e && pickFace(e)?.front) ?? null)}
            />
            <Markers
              cells={optional}
              size={0.42}
              color={piece.color}
              opacity={ghost ? 0.12 : 0.55}
              onPick={ghost ? undefined : onOptional(i)}
              onHover={ghost ? undefined : (cell, e) => hoverOn(`${piece.id}:optional`, e, () => cell)}
            />
          </group>
        );
      })}
      {target && (showTarget || tool === 'target') && (
        <>
          <Markers cells={target.required} size={0.2} color="#ffffff" opacity={0.9} />
          <Markers cells={target.variable} size={0.2} color="#8a93a3" opacity={0.9} />
        </>
      )}
      {preview &&
        (preview.state === 'fixed' ? (
          <PieceMesh voxels={[preview.cell]} color={preview.color} opacity={0.45} />
        ) : (
          <Markers cells={[preview.cell]} size={0.42} color={preview.color} opacity={0.35} />
        ))}
      {selected.length > 0 && <SelectionOutline voxels={selected} />}
    </Viewport>
  );
}

// The editor toolbar (SPEC §7.2–7.3), in two rows. The first holds the tools, undo and redo, and
// the View and Grid menus. The second holds the options of the active tool: fixed or optional
// painting (or the kind of target cell), the painted pieces, the Shapes menu (cube, sphere and burr
// zones as the target or as optional marks), moving the pieces or the selection, and the block tool.
import { useState } from 'react';
import { clampGrid, paintedPieces } from '../actions';
import { cellCoords, cropOffset, inGrid, resizeGrid, toCells, toDoc } from '../core/doc';
import {
  AXIS_DIRS,
  clearOptional,
  cubeShape,
  fillOptional,
  movePieces,
  moveSelection,
  type Shape,
  sphereShape,
  type TargetKind,
} from '../core/edit';
import { editDoc, getState, notify, redo, setState, type Tool, undo, useStore } from '../store';
import type { Vec3 } from '../types';
import { burrTarget, errorMessage } from '../wasm';
import { BlockDialog } from './BlockDialog';
import { Menu, useNarrow } from './Menu';

const TOOLS: { tool: Tool; icon: string; label: string; key: string; title: string }[] = [
  { tool: 'pencil', icon: '✎', label: 'Pencil', key: 'P', title: 'Add voxels to the current piece' },
  { tool: 'eraser', icon: '⌫', label: 'Eraser', key: 'E', title: 'Empty cells' },
  { tool: 'box', icon: '▭', label: 'Box', key: 'B', title: 'Drag a rectangle in the layer view' },
  { tool: 'line', icon: '╱', label: 'Line', key: 'L', title: 'Drag a line in the layer view' },
  { tool: 'brush', icon: '⇄', label: 'Toggle', key: 'T', title: 'Switch voxels of the current piece between fixed and optional' },
  { tool: 'select', icon: '⬚', label: 'Select', key: 'S', title: 'Select cells (Shift adds), then move them' },
  { tool: 'target', icon: '◎', label: 'Target', key: 'G', title: 'Paint the target shape for the assembler' },
];

const TARGET_KINDS: { kind: TargetKind; label: string; short: string }[] = [
  { kind: 'required', label: 'Required', short: 'Req.' },
  { kind: 'variable', label: 'Variable', short: 'Var.' },
  { kind: 'erase', label: 'Erase', short: 'Erase' },
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const grid = useStore((s) => s.doc.grid);
  const narrow = useNarrow();

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <span className="segmented">
          {TOOLS.map((t) => (
            <button key={t.tool} className={tool === t.tool ? 'on' : ''} title={`${t.label}: ${t.title} (${t.key})`} onClick={() => setState({ tool: t.tool })}>
              <span className="tool-icon">{t.icon}</span>
              <span className="tool-label">{t.label}</span>
            </button>
          ))}
        </span>
        <span className="segmented">
          <button disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)">
            ↷
          </button>
        </span>
        <span className="grow-left" />
        {narrow ? (
          <Menu label="⋯" title="View options and grid size">
            <ViewOptions />
            <GridSize key={grid.join()} grid={grid} />
          </Menu>
        ) : (
          <>
            <Menu label="View" title="What the views show">
              <ViewOptions />
            </Menu>
            <Menu label={`Grid ${grid.join('×')}`} title="Grid size (X × Y × Z)">
              <GridSize key={grid.join()} grid={grid} />
            </Menu>
          </>
        )}
      </div>
      <div className="toolbar-row context">
        <ToolOptions tool={tool} />
      </div>
    </div>
  );
}

/** The second row: the options of the active tool. */
function ToolOptions({ tool }: { tool: Tool }) {
  const paintState = useStore((s) => s.paintState);
  const targetKind = useStore((s) => s.targetKind);
  const hasTarget = useStore((s) => s.doc.target !== null);
  const selected = useStore((s) => s.selection.size);
  const [blockOpen, setBlockOpen] = useState(false);
  // Small screens get short labels, so the row fits without scrolling.
  const narrow = useNarrow();

  if (tool === 'target') {
    return (
      <>
        <span className="segmented" title="The kind of target cell painted">
          {TARGET_KINDS.map((k) => (
            <button key={k.kind} className={targetKind === k.kind ? 'on' : ''} title={k.label} onClick={() => setState({ targetKind: k.kind })}>
              {narrow ? k.short : k.label}
            </button>
          ))}
        </span>
        <ShapesMenu />
        <button disabled={!hasTarget} onClick={clearTarget} title="Clear the target">
          {narrow ? 'Clear' : 'Clear target'}
        </button>
      </>
    );
  }
  if (tool === 'select') {
    return (
      <>
        <span className="dim">{selected > 0 ? `${selected} selected` : narrow ? 'Tap or drag cells' : 'Click or drag cells (Shift adds)'}</span>
        {selected > 0 && <MoveMenu cells />}
        {selected > 0 && (
          <button onClick={() => setState({ selection: new Set() })} title="Clear the selection (Esc)">
            ✕
          </button>
        )}
        <ShapesMenu />
      </>
    );
  }
  const paints = tool === 'pencil' || tool === 'box' || tool === 'line';
  return (
    <>
      {paints && (
        <span className="segmented" title="State of painted voxels (F / O)">
          <button className={paintState === 'fixed' ? 'on' : ''} title="Fixed" onClick={() => setState({ paintState: 'fixed' })}>
            {narrow ? 'F' : 'Fixed'}
          </button>
          <button className={paintState === 'optional' ? 'on' : ''} title="Optional" onClick={() => setState({ paintState: 'optional' })}>
            {narrow ? 'O' : 'Optional'}
          </button>
        </span>
      )}
      <PiecesMenu />
      <ShapesMenu />
      <MoveMenu />
      {paints && (
        <button onClick={() => setBlockOpen(true)} title="Place a W×H×L block, e.g. a burr stick">
          Block…
        </button>
      )}
      {blockOpen && <BlockDialog onClose={() => setBlockOpen(false)} />}
    </>
  );
}

function clearTarget() {
  editDoc((d) => {
    d.target = null;
  });
}

function selectAllPieces() {
  const { doc, current } = getState();
  setState({ paintedWith: doc.pieces.filter((_, i) => i !== current).map((p) => p.id) });
}

/** The painted pieces, as "A +2": the current one and the number of the others selected. */
function usePaintedLabel(): string {
  const name = useStore((s) => s.doc.pieces[s.current]?.name);
  const painted = useStore((s) => paintedPieces(s).length);
  if (!name) return 'no piece';
  return painted > 1 ? `${name} +${painted - 1}` : name;
}

function PiecesMenu() {
  const label = usePaintedLabel();
  const color = useStore((s) => s.doc.pieces[s.current]?.color);
  const painted = useStore((s) => paintedPieces(s).length);
  const pieceCount = useStore((s) => s.doc.pieces.length);
  return (
    <Menu
      title="The painted pieces: optional marks and erasing go to all of them, fixed voxels and the toggle tool to the current one"
      label={
        <>
          {color && <span className="swatch" style={{ background: color }} />}
          {label}
        </>
      }
    >
      <div className="menu-row">
        <button disabled={painted === pieceCount} onClick={selectAllPieces}>
          All pieces
        </button>
        <button disabled={painted <= 1} onClick={() => setState({ paintedWith: [] })}>
          Only the current one
        </button>
      </div>
      <p className="menu-hint">In the list: Ctrl-click (or “multi”) adds a piece, Shift-click a range.</p>
    </Menu>
  );
}

/** Moves the painted pieces, or the selected cells (`cells`), by one cell along an axis. */
function MoveMenu({ cells = false }: { cells?: boolean }) {
  const label = usePaintedLabel();
  const painted = useStore((s) => paintedPieces(s).length);
  const pieceCount = useStore((s) => s.doc.pieces.length);
  if (!cells && pieceCount === 0) return null;

  const move = (step: Vec3) => {
    if (!cells) {
      editDoc((d) => movePieces(d, paintedPieces(getState()), step));
      return;
    }
    const out: { selection?: Set<number> } = {};
    editDoc((d) => {
      const moved = moveSelection(d, getState().selection, step);
      if (typeof moved === 'string') return moved;
      out.selection = moved;
    });
    if (out.selection) setState({ selection: out.selection });
  };

  return (
    <Menu label="Move" title={cells ? 'Move the selected cells by one' : 'Move the painted pieces by one cell'}>
      <div className="menu-title">{cells ? 'The selected cells' : label}</div>
      <div className="axis-pad">
        {(['x', 'y', 'z'] as const).map((a) => (
          <div key={a}>
            <span>{a.toUpperCase()}</span>
            <button onClick={() => move(AXIS_DIRS[`+${a}`])} title={`+${a.toUpperCase()}`}>
              +
            </button>
            <button onClick={() => move(AXIS_DIRS[`-${a}`])} title={`−${a.toUpperCase()}`}>
              −
            </button>
          </div>
        ))}
      </div>
      {!cells && (
        <div className="menu-row">
          <button disabled={painted === pieceCount} onClick={selectAllPieces}>
            All pieces
          </button>
        </div>
      )}
    </Menu>
  );
}

type ShapeKind = 'cube' | 'sphere' | 'burr' | 'fixed' | 'selection';

const SHAPES: { kind: ShapeKind; label: string; title: string; target: boolean; optional: boolean }[] = [
  { kind: 'cube', label: '■ Cube', title: 'The whole grid: its outer faces required, the inside variable', target: true, optional: true },
  {
    kind: 'sphere',
    label: '● Sphere',
    title: 'The sphere inscribed in the grid (an ellipsoid when the grid is not cubic): its outer cells required, the inside variable',
    target: true,
    optional: true,
  },
  { kind: 'burr', label: '✚ Burr', title: 'A six-stick burr: the burr shape required, plus its variable cells', target: true, optional: true },
  { kind: 'fixed', label: 'Fixed voxels', title: 'Every fixed voxel, as a required cell', target: true, optional: false },
  { kind: 'selection', label: '⬚ Selection', title: 'The selected cells', target: false, optional: true },
];

function shapeOf(kind: ShapeKind): Shape | string {
  const { doc, selection } = getState();
  switch (kind) {
    case 'cube':
      return cubeShape(doc.grid);
    case 'sphere':
      return sphereShape(doc.grid);
    case 'fixed':
      return { required: new Set(doc.pieces.flatMap((p) => [...p.fixed])), variable: new Set() };
    case 'selection':
      return { required: new Set(selection), variable: new Set() };
    case 'burr': {
      const t = burrTarget(toDoc(doc));
      if (!t) return 'No burr shape: needs six 2×2×L sticks, or a cubic grid of even side ≥ 6';
      return { required: toCells(doc.grid, t.required), variable: toCells(doc.grid, t.variable) };
    }
  }
}

/** The pieces the optional column acts on: the painted ones, or all of them. */
function shapePieces(all: boolean): number[] {
  const s = getState();
  return all ? s.doc.pieces.map((_, i) => i) : paintedPieces(s);
}

function setTargetShape(kind: ShapeKind) {
  try {
    const shape = shapeOf(kind);
    if (typeof shape === 'string') return notify(shape);
    editDoc(
      (d) => {
        d.target = shape;
      },
      { showTarget: true },
    );
  } catch (e) {
    notify(errorMessage(e));
  }
}

function fillShape(kind: ShapeKind, all: boolean) {
  try {
    const shape = shapeOf(kind);
    if (typeof shape === 'string') return notify(shape);
    const ps = shapePieces(all);
    let count = 0;
    const done = editDoc(
      (d) => {
        if (ps.length === 0) return 'Add a piece first';
        count = fillOptional(d, ps, [...shape.required, ...shape.variable]);
        if (count === 0) return 'Nothing to add: these cells are already optional or fixed';
      },
      { hideOptional: false },
    );
    if (done) notify(`${count} optional mark(s) added to ${ps.length} piece(s)`);
  } catch (e) {
    notify(errorMessage(e));
  }
}

function clearShape(all: boolean) {
  const ps = shapePieces(all);
  let count = 0;
  const done = editDoc((d) => {
    count = clearOptional(d, ps);
    if (count === 0) return 'No optional mark to clear';
  });
  if (done) notify(`${count} optional mark(s) removed from ${ps.length} piece(s)`);
}

/**
 * The zones of the grid (cube, sphere, burr, the fixed voxels, the selection) as the target or as
 * optional marks of the painted pieces or of every piece.
 */
function ShapesMenu() {
  const label = usePaintedLabel();
  const pieceCount = useStore((s) => s.doc.pieces.length);
  const hasTarget = useStore((s) => s.doc.target !== null);
  const selected = useStore((s) => s.selection.size);
  const noPiece = pieceCount === 0;
  return (
    <Menu label="Shapes" title="Cube, sphere and burr zones as the target or as optional marks">
      <table className="shapes">
        <thead>
          <tr>
            <th />
            <th>Target</th>
            <th title="Optional marks of the current piece and the selected ones">
              Optional
              <small>{label}</small>
            </th>
            <th title="Optional marks of every piece">
              Optional
              <small>all pieces</small>
            </th>
          </tr>
        </thead>
        <tbody>
          {SHAPES.filter((s) => s.kind !== 'selection' || selected > 0).map((s) => (
            <tr key={s.kind}>
              <th title={s.title}>{s.label}</th>
              <td>{s.target && <button onClick={() => setTargetShape(s.kind)}>Set</button>}</td>
              <td>
                {s.optional && (
                  <button disabled={noPiece} onClick={() => fillShape(s.kind, false)}>
                    Fill
                  </button>
                )}
              </td>
              <td>
                {s.optional && (
                  <button disabled={noPiece} onClick={() => fillShape(s.kind, true)}>
                    Fill
                  </button>
                )}
              </td>
            </tr>
          ))}
          <tr className="clear-row">
            <th>Clear</th>
            <td>
              <button disabled={!hasTarget} onClick={clearTarget}>
                Clear
              </button>
            </td>
            <td>
              <button disabled={noPiece} onClick={() => clearShape(false)}>
                Clear
              </button>
            </td>
            <td>
              <button disabled={noPiece} onClick={() => clearShape(true)}>
                Clear
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="menu-hint">Fill adds optional marks on every cell of the zone without a fixed voxel.</p>
    </Menu>
  );
}

function ViewOptions() {
  const showTarget = useStore((s) => s.showTarget);
  const showLayers = useStore((s) => s.showLayers);
  const hideOptional = useStore((s) => s.hideOptional);
  const hoverPreview = useStore((s) => s.hoverPreview);
  return (
    <div className="menu-checks">
      <label className="check">
        <input type="checkbox" checked={showTarget} onChange={(e) => setState({ showTarget: e.target.checked })} />
        Show the target
      </label>
      <label className="check" title="The layer view beside the 3D view">
        <input type="checkbox" checked={showLayers} onChange={(e) => setState({ showLayers: e.target.checked })} />
        2D layer view
      </label>
      <label className="check" title="Hide the optional marks, to edit the fixed voxels">
        <input type="checkbox" checked={hideOptional} onChange={(e) => setState({ hideOptional: e.target.checked })} />
        Hide the optional marks
      </label>
      <label className="check" title="Hovering shows the voxel a click would add (hold Shift to hide it)">
        <input type="checkbox" checked={hoverPreview} onChange={(e) => setState({ hoverPreview: e.target.checked })} />
        Hover preview
      </label>
    </div>
  );
}

function GridSize({ grid }: { grid: Vec3 }) {
  const [size, setSize] = useState<Vec3>(grid);
  const changed = size.some((n, k) => n !== grid[k]);
  const apply = () => {
    const g = size.map(clampGrid) as Vec3;
    const d = getState().doc;
    // A smaller grid keeps the part of the old one that holds most of the puzzle.
    const offset = cropOffset(d, g);
    const inside = (i: number) => inGrid(g, cellCoords(d.grid, i).map((c, k) => c - offset[k]) as Vec3);
    const lost = d.pieces.flatMap((p) => [...p.fixed, ...p.optional]).filter((i) => !inside(i)).length;
    if (lost > 0 && !window.confirm(`${lost} voxel(s) fall outside the new grid and will be removed. Resize?`)) return;
    editDoc(
      (x) => {
        Object.assign(x, resizeGrid(x, g, offset));
      },
      { selection: new Set() },
    );
    setSize(g);
  };
  return (
    <div className="grid-size" title="Grid size (X × Y × Z)">
      Grid
      {size.map((n, k) => (
        <input
          key={k}
          type="number"
          min={1}
          max={32}
          value={n}
          onChange={(e) => {
            const next = [...size] as Vec3;
            next[k] = Number(e.target.value);
            setSize(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply();
          }}
        />
      ))}
      <button disabled={!changed} onClick={apply}>
        Apply
      </button>
    </div>
  );
}

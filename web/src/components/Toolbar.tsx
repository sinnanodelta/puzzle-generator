// The editor toolbar (SPEC §7.2–7.3): tools, fixed / optional painting, the target, the views, the
// block tool, moving the selection, undo and redo, and the grid size.
import { useState } from 'react';
import { clampGrid, paintedPieces } from '../actions';
import { cellCoords, inGrid, resizeGrid, toCells, toDoc } from '../core/doc';
import { AXIS_DIRS, blankToOptional, cubeTarget, gridCells, moveSelection, prefillTarget, type TargetKind } from '../core/edit';
import { editDoc, getState, notify, redo, setState, type Tool, undo, useStore } from '../store';
import type { Vec3 } from '../types';
import { burrTarget, errorMessage } from '../wasm';
import { BlockDialog } from './BlockDialog';

const TOOLS: { tool: Tool; label: string; key: string; title: string }[] = [
  { tool: 'pencil', label: 'Pencil', key: 'P', title: 'Add voxels to the current piece' },
  { tool: 'eraser', label: 'Eraser', key: 'E', title: 'Empty cells' },
  { tool: 'box', label: 'Box', key: 'B', title: 'Drag a rectangle in the layer view' },
  { tool: 'line', label: 'Line', key: 'L', title: 'Drag a line in the layer view' },
  { tool: 'brush', label: 'Toggle', key: 'T', title: 'Switch voxels of the current piece between fixed and optional' },
  { tool: 'select', label: 'Select', key: 'S', title: 'Select cells (Shift adds), then move them' },
  { tool: 'target', label: 'Target', key: 'G', title: 'Paint the target shape for the assembler' },
];

const TARGET_KINDS: { kind: TargetKind; label: string }[] = [
  { kind: 'required', label: 'Required' },
  { kind: 'variable', label: 'Variable' },
  { kind: 'erase', label: 'Erase' },
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const paintState = useStore((s) => s.paintState);
  const targetKind = useStore((s) => s.targetKind);
  const showTarget = useStore((s) => s.showTarget);
  const showLayers = useStore((s) => s.showLayers);
  const hoverPreview = useStore((s) => s.hoverPreview);
  const selection = useStore((s) => s.selection);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const grid = useStore((s) => s.doc.grid);
  const hasTarget = useStore((s) => s.doc.target !== null);
  const painted = useStore((s) => paintedPieces(s).length);
  const [blockOpen, setBlockOpen] = useState(false);

  const blankToOptionalForAll = () => {
    const { doc, selection } = getState();
    let count = 0;
    editDoc((d) => {
      if (d.pieces.length === 0) return 'Add a piece first';
      count = blankToOptional(d, selection.size > 0 ? selection : gridCells(d.grid));
      if (count === 0) return selection.size > 0 ? 'No blank cell in the selection' : 'No blank cell';
    });
    if (count > 0) notify(`${count} cell(s) made optional for all ${doc.pieces.length} pieces`);
  };

  const moveBy = (step: Vec3) => {
    const out: { selection?: Set<number> } = {};
    editDoc((d) => {
      const moved = moveSelection(d, getState().selection, step);
      if (typeof moved === 'string') return moved;
      out.selection = moved;
    });
    if (out.selection) setState({ selection: out.selection });
  };

  const setBurrTarget = () => {
    const doc = getState().doc;
    try {
      const t = burrTarget(toDoc(doc));
      if (!t) {
        notify('No burr target: needs six 2×2×L sticks, or a cubic grid of even side ≥ 6');
        return;
      }
      editDoc(
        (d) => {
          d.target = { required: toCells(d.grid, t.required), variable: toCells(d.grid, t.variable) };
        },
        { showTarget: true },
      );
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  return (
    <div className="toolbar">
      <span className="segmented">
        {TOOLS.map((t) => (
          <button key={t.tool} className={tool === t.tool ? 'on' : ''} title={`${t.title} (${t.key})`} onClick={() => setState({ tool: t.tool })}>
            {t.label}
          </button>
        ))}
      </span>
      {tool === 'target' ? (
        <>
          <span className="segmented">
            {TARGET_KINDS.map((k) => (
              <button key={k.kind} className={targetKind === k.kind ? 'on' : ''} onClick={() => setState({ targetKind: k.kind })}>
                {k.label}
              </button>
            ))}
          </span>
          <button title="Every fixed voxel becomes a required target cell" onClick={() => editDoc(prefillTarget, { showTarget: true })}>
            Prefill
          </button>
          <button title="The target of a six-stick burr: the burr shape plus its variable cells" onClick={setBurrTarget}>
            Burr target
          </button>
          <button title="The whole grid: the cells of its outer faces required, the inside variable" onClick={() => editDoc(cubeTarget, { showTarget: true })}>
            Cube target
          </button>
          <button
            disabled={!hasTarget}
            onClick={() =>
              editDoc((d) => {
                d.target = null;
              })
            }
          >
            Clear target
          </button>
        </>
      ) : (
        <>
          <span className="segmented" title="State of painted voxels (F / O)">
            <button className={paintState === 'fixed' ? 'on' : ''} onClick={() => setState({ paintState: 'fixed' })}>
              Fixed
            </button>
            <button className={paintState === 'optional' ? 'on' : ''} onClick={() => setState({ paintState: 'optional' })}>
              Optional
            </button>
          </span>
          {painted > 1 && (
            <span className="dim" title="Optional marks and erasing go to every selected piece; fixed voxels and the toggle tool to the current one">
              {painted} pieces
            </span>
          )}
          {paintState === 'optional' && (
            <button
              title="Every blank cell (no voxel, no optional mark) becomes optional for every piece; only the selected cells when some are selected"
              onClick={blankToOptionalForAll}
            >
              Empty → optional
            </button>
          )}
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={showTarget} onChange={(e) => setState({ showTarget: e.target.checked })} />
        show target
      </label>
      <label className="check" title="The layer view beside the 3D view">
        <input type="checkbox" checked={showLayers} onChange={(e) => setState({ showLayers: e.target.checked })} />
        2D view
      </label>
      <label className="check" title="Hovering shows the voxel a click would add (hold Shift to hide it)">
        <input type="checkbox" checked={hoverPreview} onChange={(e) => setState({ hoverPreview: e.target.checked })} />
        hover preview
      </label>
      <button onClick={() => setBlockOpen(true)} title="Place a W×H×L block, e.g. a burr stick">
        Block…
      </button>
      {selection.size > 0 && (
        <span className="segmented" title="Move the selected cells by one">
          <span className="dim">{selection.size} selected</span>
          {Object.entries(AXIS_DIRS).map(([name, step]) => (
            <button key={name} onClick={() => moveBy(step)}>
              {name.toUpperCase()}
            </button>
          ))}
          <button onClick={() => setState({ selection: new Set() })} title="Clear the selection (Esc)">
            ✕
          </button>
        </span>
      )}
      <span className="grow-left" />
      <button disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)">
        ↷
      </button>
      <GridSize key={grid.join()} grid={grid} />
      {blockOpen && <BlockDialog onClose={() => setBlockOpen(false)} />}
    </div>
  );
}

function GridSize({ grid }: { grid: Vec3 }) {
  const [size, setSize] = useState<Vec3>(grid);
  const changed = size.some((n, k) => n !== grid[k]);
  const apply = () => {
    const g = size.map(clampGrid) as Vec3;
    const d = getState().doc;
    const lost = [...d.pieces.flatMap((p) => [...p.fixed, ...p.optional])].filter((i) => !inGrid(g, cellCoords(d.grid, i))).length;
    if (lost > 0 && !window.confirm(`${lost} voxel(s) fall outside the new grid and will be removed. Resize?`)) return;
    editDoc(
      (x) => {
        Object.assign(x, resizeGrid(x, g));
      },
      { selection: new Set() },
    );
    setSize(g);
  };
  return (
    <span className="grid-size" title="Grid size (X × Y × Z)">
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
    </span>
  );
}

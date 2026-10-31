// The block tool (SPEC §7.2): places a W×H×L block, such as a burr stick, in one click.
import { useState } from 'react';
import { blockCells, type BlockOptions, placeBlock } from '../core/edit';
import { editDoc, getState, setState, useStore } from '../store';
import type { Vec3 } from '../types';

const AXIS_NAMES = ['X', 'Y', 'Z'];

export function BlockDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const [o, setO] = useState<BlockOptions>(() => ({
    size: [2, 2, Math.min(8, Math.max(...doc.grid))],
    position: [0, 0, 0],
    axis: 0,
    piece: getState().current < doc.pieces.length ? getState().current : 'new',
    state: getState().paintState,
  }));
  const cells = blockCells(doc.grid, o);

  const vec = (label: string, names: string[], value: Vec3, set: (v: Vec3) => void) => (
    <div className="field">
      <span>{label}</span>
      {value.map((n, k) => (
        <label key={k}>
          {names[k]}
          <input
            type="number"
            value={n}
            onChange={(e) => {
              const v = [...value] as Vec3;
              v[k] = Number(e.target.value);
              set(v);
            }}
          />
        </label>
      ))}
    </div>
  );

  const place = () => {
    const out: { piece?: number } = {};
    editDoc((d) => {
      const p = placeBlock(d, o);
      if (typeof p === 'string') return p;
      out.piece = p;
    });
    if (out.piece !== undefined) {
      setState({ current: out.piece });
      // Later blocks go to the same piece rather than adding one each time.
      setO({ ...o, piece: out.piece });
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Place a block</h3>
        {vec('Size', ['W', 'H', 'L'], o.size, (size) => setO({ ...o, size }))}
        <div className="field">
          <span>Length along</span>
          <span className="segmented">
            {([0, 1, 2] as const).map((a) => (
              <button key={a} className={o.axis === a ? 'on' : ''} onClick={() => setO({ ...o, axis: a })}>
                {AXIS_NAMES[a]}
              </button>
            ))}
          </span>
        </div>
        {vec('Corner', ['x', 'y', 'z'], o.position, (position) => setO({ ...o, position }))}
        <div className="field">
          <span>Piece</span>
          <select
            value={String(o.piece)}
            onChange={(e) => setO({ ...o, piece: e.target.value === 'new' ? 'new' : Number(e.target.value) })}
          >
            {doc.pieces.map((p, i) => (
              <option key={p.id} value={i}>
                {p.name}
              </option>
            ))}
            <option value="new">New piece</option>
          </select>
          <span className="segmented">
            <button className={o.state === 'fixed' ? 'on' : ''} onClick={() => setO({ ...o, state: 'fixed' })}>
              Fixed
            </button>
            <button className={o.state === 'optional' ? 'on' : ''} onClick={() => setO({ ...o, state: 'optional' })}>
              Optional
            </button>
          </span>
        </div>
        <p className={typeof cells === 'string' ? 'warn' : 'dim'}>
          {typeof cells === 'string' ? cells : `${cells.length} cells`}
        </p>
        <div className="modal-actions">
          <button className="primary" disabled={typeof cells === 'string'} onClick={place}>
            Place
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

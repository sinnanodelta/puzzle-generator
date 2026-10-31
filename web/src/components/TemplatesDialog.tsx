// New puzzles from templates (SPEC §8): an empty grid, the parametric 6-piece burr, and the known
// burrs of the fixtures.
import { useMemo, useState } from 'react';
import { clampGrid } from '../actions';
import { emptyDoc, toDoc } from '../core/doc';
import { confirmDiscard, notify, openDoc } from '../store';
import type { PuzzleDoc, Vec3 } from '../types';
import { burrTemplate, errorMessage, knownBurr, knownBurrs } from '../wasm';

export function TemplatesDialog({ onClose }: { onClose: () => void }) {
  const burrs = useMemo(() => knownBurrs(), []);
  const [grid, setGrid] = useState<Vec3>([8, 8, 8]);
  const [length, setLength] = useState(8);

  const open = (make: () => PuzzleDoc) => {
    if (!confirmDiscard()) return;
    try {
      openDoc(make());
      onClose();
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  const lengthOk = length >= 6 && length <= 32 && length % 2 === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>New puzzle</h3>
        <div className="field">
          <span>Empty grid</span>
          {grid.map((n, k) => (
            <input
              key={k}
              type="number"
              min={1}
              max={32}
              value={n}
              onChange={(e) => {
                const g = [...grid] as Vec3;
                g[k] = Number(e.target.value);
                setGrid(g);
              }}
            />
          ))}
          <button onClick={() => open(() => toDoc(emptyDoc(grid.map(clampGrid) as Vec3)))}>Create</button>
        </div>
        <div className="field">
          <span>6-piece burr</span>
          <label>
            stick length
            <input type="number" min={6} max={32} step={2} value={length} onChange={(e) => setLength(Number(e.target.value))} />
          </label>
          <button disabled={!lengthOk} onClick={() => open(() => burrTemplate(length))}>
            Create
          </button>
          <span className="dim">2×2×L sticks; shared cells are optional</span>
        </div>
        <h4>Known burrs</h4>
        <table className="burrs">
          <thead>
            <tr>
              <th>Name</th>
              <th>Designer</th>
              <th>L</th>
              <th>Level</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {burrs.map((b) => (
              <tr key={b.key}>
                <td>{b.name}</td>
                <td className="dim">{b.designer ?? '—'}</td>
                <td>{b.stickLength}</td>
                <td>{b.levelString}</td>
                <td>
                  <button onClick={() => open(() => knownBurr(b.key))}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

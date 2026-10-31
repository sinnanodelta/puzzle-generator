// The pieces of the document (SPEC §7.4): name, colour, view mode, isolation, the "must stay
// notchable" flag, and the notchable / millable badges of the analysis. Ctrl- or Shift-clicking
// selects several pieces, which the tools paint together; the "multi" box does it on touch screens.
import { useState } from 'react';
import { MAX_PIECES, newPiece } from '../core/doc';
import { pickPiece } from '../actions';
import { removePiece } from '../core/edit';
import { beginStroke, editDoc, endStroke, setState, useStore, type ViewMode } from '../store';

const NEXT_MODE: Record<ViewMode, ViewMode> = { normal: 'ghost', ghost: 'hidden', hidden: 'normal' };
const MODE_ICON: Record<ViewMode, string> = { normal: '●', ghost: '◐', hidden: '○' };

export function PieceList() {
  const doc = useStore((s) => s.doc);
  const current = useStore((s) => s.current);
  const paintedWith = useStore((s) => s.paintedWith);
  const viewModes = useStore((s) => s.viewModes);
  const isolate = useStore((s) => s.isolate);
  const analysis = useStore((s) => s.analysis);
  const [multi, setMulti] = useState(false);

  const remove = (i: number) => {
    const p = doc.pieces[i];
    if (p.fixed.size + p.optional.size > 0 && !window.confirm(`Delete ${p.name} and its voxels?`)) return;
    editDoc((d) => removePiece(d, i), { current: current > i ? current - 1 : current });
  };

  return (
    <div className="piece-list">
      <div className="panel-header">
        <span>Pieces ({doc.pieces.length})</span>
        <label className="check" title="Clicks add or remove pieces of the selection, like Ctrl-click">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
          multi
        </label>
        <button
          className="grow-left"
          disabled={doc.pieces.length >= MAX_PIECES}
          onClick={() =>
            editDoc(
              (d) => {
                d.pieces.push(newPiece(d));
              },
              { current: doc.pieces.length },
            )
          }
        >
          + Add
        </button>
      </div>
      <ul>
        {doc.pieces.map((p, i) => {
          const mode = viewModes[p.id] ?? 'normal';
          const info = p.fixed.size > 0 ? analysis?.pieces[i] : undefined;
          return (
            <li
              key={p.id}
              className={i === current ? 'current' : paintedWith.includes(p.id) ? 'selected' : ''}
              title="Ctrl-click: paint several pieces at once; Shift-click: a range"
              onClick={(e) => pickPiece(i, multi || e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'only')}
            >
              <div className="piece-row">
                <input
                  type="color"
                  value={p.color}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={beginStroke}
                  onBlur={endStroke}
                  onChange={(e) => {
                    const color = e.target.value;
                    editDoc((d) => {
                      d.pieces[i].color = color;
                    });
                  }}
                />
                <input
                  key={p.name}
                  className="piece-name"
                  defaultValue={p.name}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== p.name) {
                      editDoc((d) => {
                        d.pieces[i].name = name;
                      });
                    } else e.target.value = p.name;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
                <button
                  className="icon"
                  title={`View: ${mode} (click to change)`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setState((s) => ({ viewModes: { ...s.viewModes, [p.id]: NEXT_MODE[mode] } }));
                  }}
                >
                  {MODE_ICON[mode]}
                </button>
                <button
                  className={`icon ${isolate === p.id ? 'on' : ''}`}
                  title="Show this piece alone"
                  onClick={(e) => {
                    e.stopPropagation();
                    setState({ isolate: isolate === p.id ? null : p.id });
                  }}
                >
                  ◎
                </button>
                <button
                  className="icon danger"
                  title="Delete the piece"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(i);
                  }}
                >
                  ✕
                </button>
              </div>
              <div className="piece-info">
                <span className="dim">
                  {p.fixed.size} fixed · {p.optional.size} opt
                </span>
                {info?.notchable && (
                  <span className="badge" title="Notchable: the piece is the intersection of the extrusions of its three projections">
                    N
                  </span>
                )}
                {info?.millable && (
                  <span className="badge" title="Millable: no empty voxel has filled neighbours along X, Y and Z at once">
                    M
                  </span>
                )}
                {info && p.notchable && !info.notchable && <span className="warn">not notchable</span>}
                {info && !info.connected && <span className="warn">disconnected</span>}
                <label className="grow-left" title="The generator keeps this piece notchable" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={p.notchable}
                    onChange={(e) => {
                      const notchable = e.target.checked;
                      editDoc((d) => {
                        d.pieces[i].notchable = notchable;
                      });
                    }}
                  />
                  keep notchable
                </label>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The solution viewer (SPEC §6): replays the disassembly found by the solver, with the move list
// grouped by separation. Space plays or pauses; the arrow keys step.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fixedSignature, fromDoc } from '../core/doc';
import { buildReplay, offsetsAt } from '../core/solution';
import { confirmDiscard, getState, openDoc, setState, useStore } from '../store';
import type { PuzzleDoc, SolveResult, Vec3 } from '../types';
import { PieceMesh, Viewport } from './Viewport';

const SPEEDS = [0.5, 1, 2, 4];
/** Seconds per step at speed 1. */
const STEP_TIME = 0.5;

function openInEditor(doc: PuzzleDoc): void {
  if (fixedSignature(fromDoc(doc)) === fixedSignature(getState().doc)) setState({ tab: 'editor' });
  else if (confirmDiscard()) openDoc(doc);
}

export function Viewer() {
  const viewer = useStore((s) => s.viewer);
  if (!viewer) {
    return (
      <div className="empty-state">
        <p>No puzzle to show. Open one from the library, or use “View solution” in the editor.</p>
        <button onClick={() => setState({ tab: 'library' })}>Library</button>
      </div>
    );
  }
  const { doc, result, loading, error } = viewer;
  if (loading) return <div className="empty-state">Solving “{doc.name}”…</div>;
  if (error || !result || result.status !== 'solved' || !result.solution) {
    const reason = error
      ? error
      : result?.status === 'aborted'
        ? `The solver gave up after ${result.states.toLocaleString()} states.`
        : 'This puzzle cannot be taken apart.';
    return (
      <div className="empty-state">
        <p>
          <strong>{doc.name}</strong>: {reason}
        </p>
        <button onClick={() => openInEditor(doc)}>Open in editor</button>
      </div>
    );
  }
  return <Replayer doc={doc} result={result} />;
}

function Replayer({ doc, result }: { doc: PuzzleDoc; result: SolveResult }) {
  const solution = result.solution!;
  const replay = useMemo(() => buildReplay(doc, solution), [doc, solution]);
  const n = replay.steps.length;
  const [p, setP] = useState(0);
  const pRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [focus, setFocus] = useState<number | null>(null);

  const go = (x: number) => {
    const c = Math.max(0, Math.min(n, x));
    pRef.current = c;
    setP(c);
  };

  useEffect(() => {
    go(0);
    setPlaying(false);
    setFocus(null);
  }, [replay]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = pRef.current + ((now - last) / 1000) * (speed / STEP_TIME);
      last = now;
      if (next >= n) {
        go(n);
        setPlaying(false);
        return;
      }
      go(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, n]);

  const togglePlay = () => {
    if (playing) setPlaying(false);
    else {
      if (pRef.current >= n) go(0);
      setPlaying(true);
    }
  };
  const stepTo = (x: number) => {
    setPlaying(false);
    go(x);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
      // Space on a focused button already clicks it.
      if (e.key === ' ' && !t.closest('button')) togglePlay();
      else if (e.key === 'ArrowRight') stepTo(Math.floor(pRef.current) + 1);
      else if (e.key === 'ArrowLeft') stepTo(Math.ceil(pRef.current) - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const base = Math.floor(p);
  const offsets = offsetsAt(replay, base, p - base);
  const active = Math.ceil(p) - 1;
  const activeStep = active >= 0 ? replay.steps[active] : null;
  const center = replay.lo.map((l, k) => (l + replay.hi[k]) / 2) as Vec3;
  const size = Math.max(...replay.hi.map((h, k) => h - replay.lo[k]));

  return (
    <div className="viewer">
      <div className="viewer-header">
        <h2>{doc.name}</h2>
        <span>
          Level <strong>{solution.level_string}</strong> · {solution.total_moves} moves · {result.states.toLocaleString()} states
        </span>
        <button className="grow-left" onClick={() => openInEditor(doc)}>
          Open in editor
        </button>
      </div>
      <div className="viewer-body">
        <div className="viewer-scene">
          <Viewport size={size} center={center}>
            {doc.pieces.map((piece, i) => {
              const inStep = activeStep !== null && (activeStep.mask >> i) & 1;
              const emissive = inStep ? (activeStep.kind === 'separate' && activeStep.root ? '#665500' : '#3a3000') : '#000000';
              return (
                <PieceMesh
                  key={piece.id}
                  voxels={piece.fixed}
                  color={piece.color}
                  opacity={focus === null || focus === i ? 1 : 0.15}
                  emissive={emissive}
                  position={offsets[i]}
                />
              );
            })}
          </Viewport>
          <div className="legend">
            {doc.pieces.map((piece, i) => (
              <button
                key={piece.id}
                className={focus === i ? 'on' : ''}
                title="Show this piece alone"
                onClick={() => setFocus(focus === i ? null : i)}
              >
                <span className="swatch" style={{ background: piece.color }} />
                {piece.name}
              </button>
            ))}
          </div>
        </div>
        <div className="move-list">
          {replay.groups.map((g, gi) => (
            <div key={gi} className={`move-group ${g.root ? 'root' : ''}`}>
              <div className="move-group-title">{g.title}</div>
              <ol>
                {replay.steps.map((s, k) =>
                  s.group !== gi ? null : (
                    <li
                      key={k}
                      className={`${k === active ? 'active' : ''} ${s.kind}`}
                      onClick={() => stepTo(k + 1)}
                    >
                      <span className="move-number">{s.number ?? ''}</span>
                      {s.label}
                    </li>
                  ),
                )}
              </ol>
            </div>
          ))}
        </div>
      </div>
      <div className="player">
        <button onClick={() => stepTo(0)} title="Start">
          ⏮
        </button>
        <button onClick={() => stepTo(Math.ceil(p) - 1)} title="Previous step (←)">
          ◀
        </button>
        <button className="primary" onClick={togglePlay} title="Play / pause (Space)">
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => stepTo(Math.floor(p) + 1)} title="Next step (→)">
          ▶▶
        </button>
        <button onClick={() => stepTo(n)} title="End">
          ⏭
        </button>
        <input
          type="range"
          min={0}
          max={n}
          step={0.01}
          value={p}
          onChange={(e) => stepTo(Number(e.target.value))}
        />
        <span className="dim">
          {Math.ceil(p)}/{n}
        </span>
        <span className="segmented" title="Speed">
          {SPEEDS.map((v) => (
            <button key={v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>
              ×{v}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

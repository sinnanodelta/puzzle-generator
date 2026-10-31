// The generator tab (SPEC §4.4): the settings and counters of a run, the live leaderboard, and a
// rotatable view of the selected puzzle.
import { useMemo } from 'react';
import { toDoc } from '../core/doc';
import { rate } from '../core/rating';
import { BOARD_SIZE, boardView, saveEntry, setBoardView, shownBoard, startGenerator, stopGenerator } from '../generation';
import {
  type BoardEntry,
  confirmDiscard,
  type GenSettings,
  notify,
  openDoc,
  randomSeed,
  setState,
  type UniquenessCheck,
  useStore,
  viewDoc,
} from '../store';
import type { GenEntry, PuzzleDoc, Vec3 } from '../types';
import { defaultCheckStates, errorMessage } from '../wasm';
import { UniquenessBadge } from './UniquenessBadge';
import { PieceMesh, Viewport } from './Viewport';

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${(ms / 1000).toFixed(1)} s`;
}

function setSetting(patch: Partial<GenSettings>): void {
  setState((s) => ({ genSettings: { ...s.genSettings, ...patch } }));
}

function NumberSetting({
  label,
  title,
  value,
  min,
  disabled,
  onChange,
}: {
  label: string;
  title: string;
  value: number;
  min: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <input type="number" min={min} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Settings({ running }: { running: boolean }) {
  const s = useStore((st) => st.genSettings);
  const hasRequired = useStore((st) => (st.doc.target?.required.size ?? 0) > 0);
  return (
    <>
      <h4>Settings</h4>
      <NumberSetting
        label="Workers"
        title="Parallel runs, each with its own seed"
        value={s.workers}
        min={1}
        disabled={running}
        onChange={(workers) => setSetting({ workers })}
      />
      <div className="field" title="Worker i runs with seed + i">
        <span>Seed</span>
        <input type="number" min={0} value={s.seed} disabled={running} onChange={(e) => setSetting({ seed: Number(e.target.value) })} />
        <button disabled={running} title="Random seed" onClick={() => setSetting({ seed: randomSeed() })}>
          🎲
        </button>
      </div>
      <NumberSetting
        label="Check cap"
        title="States explored by each solvability check before it gives up (a give-up counts as unsolvable)"
        value={s.maxStates ?? defaultCheckStates()}
        min={1}
        disabled={running}
        onChange={(maxStates) => setSetting({ maxStates })}
      />
      <NumberSetting
        label="Max removed"
        title="Voxels removed at most between two greedy passes"
        value={s.maxRemoved}
        min={1}
        disabled={running}
        onChange={(maxRemoved) => setSetting({ maxRemoved })}
      />
      <NumberSetting
        label="Restart after"
        title="Passes without improvement before restarting from the base (0: never)"
        value={s.restartAfter}
        min={0}
        disabled={running}
        onChange={(restartAfter) => setSetting({ restartAfter })}
      />
      <NumberSetting
        label="Time limit (s)"
        title="Stops the run after this many seconds (0: no limit)"
        value={s.timeLimit}
        min={0}
        disabled={running}
        onChange={(timeLimit) => setSetting({ timeLimit })}
      />
      <NumberSetting
        label="Target level"
        title="Stops the run once a puzzle reaches this level (0: no target)"
        value={s.targetLevel}
        min={0}
        disabled={running}
        onChange={(targetLevel) => setSetting({ targetLevel })}
      />
      <label
        className="field"
        title="The search prefers fewer holes (required target cells left empty) to a higher level, and the target level counts only puzzles without holes"
      >
        <span>Fill target first</span>
        <input
          type="checkbox"
          checked={s.fillTarget}
          disabled={running || !hasRequired}
          onChange={(e) => setSetting({ fillTarget: e.target.checked })}
        />
      </label>
    </>
  );
}

function RunPanel() {
  const gen = useStore((s) => s.gen);
  const docName = useStore((s) => s.doc.name);
  const running = gen?.running ?? false;
  const best = gen?.board[0];
  const hasRequired = (gen?.base.target?.required.length ?? 0) > 0;
  const bestFilled = gen?.board.find((e) => e.holes === 0);
  return (
    <div className="gen-panel">
      <h4>Base</h4>
      <div className="gen-base">
        <strong title={running ? undefined : 'The puzzle in the editor'}>{running ? gen!.base.name : docName}</strong>
        <button disabled={running} onClick={() => setState({ tab: 'editor' })}>
          Edit
        </button>
      </div>
      <Settings running={running} />
      <div className="gen-actions">
        {running ? (
          <button className="danger" onClick={() => stopGenerator()}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={startGenerator}>
            Start
          </button>
        )}
        <span className={`gen-state ${gen?.error ? 'bad' : ''}`}>{running ? 'Running…' : (gen?.stopReason ?? '')}</span>
      </div>
      {gen?.error && <p className="gen-error">{gen.error}</p>}
      {gen && (
        <dl className="counters">
          <dt>Elapsed</dt>
          <dd>{duration(gen.elapsed)}</dd>
          <dt>Checks</dt>
          <dd>{gen.checks.toLocaleString()}</dd>
          <dt>Checks/s</dt>
          <dd>{Math.round(gen.checksPerSecond).toLocaleString()}</dd>
          <dt>Gave up</dt>
          <dd>{gen.checks > 0 ? `${((100 * gen.aborted) / gen.checks).toFixed(1)} %` : '–'}</dd>
          <dt>Passes</dt>
          <dd>{gen.passes.toLocaleString()}</dd>
          <dt>Restarts</dt>
          <dd>{gen.restarts.toLocaleString()}</dd>
          <dt>Workers</dt>
          <dd>{gen.settings.workers}</dd>
          <dt>Best</dt>
          <dd>{best ? `level ${best.level_string}` : '–'}</dd>
          {hasRequired && (
            <>
              <dt title="Best puzzle without holes in the target">Best filled</dt>
              <dd>{bestFilled ? `level ${bestFilled.level_string}` : '–'}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

/** A leaderboard row: an entry and its rank in the whole leaderboard. */
interface Row {
  entry: BoardEntry;
  rank: number;
}

function RatingCell({ entry }: { entry: GenEntry }) {
  const r = rate(entry.key, entry.document);
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  return <td title={`Balance of the piece sizes ${pct(r.balance)} · 3D printing without supports ${pct(r.print)}`}>{r.total}</td>;
}

function Leaderboard({
  rows,
  saved,
  uniqueness,
  holes,
  shown,
}: {
  rows: Row[];
  saved: string[];
  /** Null without a target: the uniqueness is not checked. */
  uniqueness: Record<string, UniquenessCheck> | null;
  /** Shows the holes of each puzzle. */
  holes: boolean;
  shown: string | null;
}) {
  const run = (action: () => Promise<void>) => {
    action().catch((e) => notify(errorMessage(e)));
  };
  return (
    <table className="burrs leaderboard">
      <thead>
        <tr>
          <th>#</th>
          <th>Level</th>
          <th>Moves</th>
          <th title="0–100: half for balanced piece sizes, half for pieces easy to 3D print">Rating</th>
          {holes && <th title="Required cells of the target left empty">Holes</th>}
          <th>Found</th>
          {uniqueness && <th>Uniqueness</th>}
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ entry, rank }) => (
          <tr key={entry.key} className={entry.key === shown ? 'selected' : ''} onClick={() => setState({ genSelected: entry.key })}>
            <td className="dim">{rank}</td>
            <td>
              <strong>{entry.level_string}</strong>
            </td>
            <td>{entry.score.total_moves}</td>
            <RatingCell entry={entry} />
            {holes && <td className={entry.holes > 0 ? 'holes' : 'dim'}>{entry.holes}</td>}
            <td className="dim">{duration(entry.found)}</td>
            {uniqueness && (
              <td>
                <UniquenessBadge check={uniqueness[entry.key]} />
              </td>
            )}
            <td className="row-actions" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => void viewDoc(entry.document)}>View</button>
              <button disabled={saved.includes(entry.key)} onClick={() => run(() => saveEntry(entry))}>
                {saved.includes(entry.key) ? 'Saved' : 'Save'}
              </button>
              <button
                onClick={() => {
                  if (confirmDiscard()) openDoc(entry.document);
                }}
              >
                Open
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Preview({ doc, caption }: { doc: PuzzleDoc; caption: string }) {
  const grid = doc.grid;
  return (
    <>
      <Viewport size={Math.max(...grid)} center={grid.map((n) => n / 2) as Vec3}>
        {doc.pieces.map((piece) => (
          <PieceMesh key={piece.id} voxels={piece.fixed} color={piece.color} />
        ))}
      </Viewport>
      <div className="gen-caption">{caption}</div>
    </>
  );
}

export function Generator() {
  const gen = useStore((s) => s.gen);
  const selected = useStore((s) => s.genSelected);
  const editorDoc = useStore((s) => s.doc);
  const base = useMemo(() => gen?.base ?? toDoc(editorDoc), [gen?.base, editorDoc]);
  const uniqueOnly = useStore((s) => s.genUniqueOnly);
  const filledOnly = useStore((s) => s.genFilledOnly);
  const onePerLevel = useStore((s) => s.genOnePerLevel);
  const byRating = useStore((s) => s.genByRating);
  const board = gen?.board ?? [];
  const checked = base.target !== null;
  const hasRequired = (base.target?.required.length ?? 0) > 0;
  const view = boardView({ genFilledOnly: filledOnly, genOnePerLevel: onePerLevel, genByRating: byRating }, hasRequired);
  const filtered = view.filledOnly;
  const list = shownBoard(board, view);
  const uniqueness = gen && checked ? gen.uniqueness : null;
  const done = uniqueness ? list.filter((e) => uniqueness[e.key]?.kind === 'done').length : 0;
  const rows = list
    .map((entry, i) => ({ entry, rank: i + 1 }))
    .filter(({ entry }) => {
      if (!uniqueness || !uniqueOnly) return true;
      const check = uniqueness[entry.key];
      return check?.kind === 'done' && check.result.unique;
    });
  const shown = rows.find((r) => r.entry.key === selected) ?? rows[0] ?? null;

  return (
    <div className="generator">
      <RunPanel />
      <div className="gen-board">
        <div className="panel-header">
          <h2>Leaderboard</h2>
          <span className="dim small">
            {list.length}/{BOARD_SIZE} distinct puzzles{filtered ? ' without holes' : ''}
            {checked ? (list.length > 0 ? ` · ${done} checked for uniqueness` : '') : ' · no target: uniqueness not checked'}
          </span>
          <span className="gen-filters">
            {hasRequired && (
              <label className="check gen-filter" title="Shows only the puzzles that fill every required cell of the target, best first">
                <input type="checkbox" checked={filledOnly} onChange={(e) => setBoardView({ genFilledOnly: e.target.checked })} />
                Target filled only
              </label>
            )}
            <label className="check gen-filter" title="Shows only the best rated puzzle of each level">
              <input type="checkbox" checked={onePerLevel} onChange={(e) => setBoardView({ genOnePerLevel: e.target.checked })} />
              One per level
            </label>
            <label className="check gen-filter" title="Sorts by rating: balanced piece sizes and pieces easy to 3D print">
              <input type="checkbox" checked={byRating} onChange={(e) => setBoardView({ genByRating: e.target.checked })} />
              Sort by rating
            </label>
            {checked && (
              <label className="check gen-filter" title="Shows only the puzzles with exactly one assembly that comes apart">
                <input type="checkbox" checked={uniqueOnly} onChange={(e) => setState({ genUniqueOnly: e.target.checked })} />
                Unique only
              </label>
            )}
          </span>
        </div>
        {rows.length > 0 ? (
          <Leaderboard
            rows={rows}
            saved={gen!.saved}
            uniqueness={uniqueness}
            holes={hasRequired && board.some((e) => e.holes > 0)}
            shown={shown?.entry.key ?? null}
          />
        ) : list.length > 0 ? (
          <p className="dim">No unique puzzle so far.</p>
        ) : filtered && board.length > 0 ? (
          <p className="dim">No puzzle without holes so far.</p>
        ) : (
          <p className="dim">{gen?.running ? 'Searching…' : 'Start a run to fill the leaderboard with the best puzzles found.'}</p>
        )}
      </div>
      <div className="gen-scene">
        {shown ? (
          <Preview
            doc={shown.entry.document}
            caption={`#${shown.rank} · level ${shown.entry.level_string} · ${shown.entry.score.total_moves} moves`}
          />
        ) : (
          <Preview doc={base} caption={`Base: ${base.name}`} />
        )}
      </div>
    </div>
  );
}

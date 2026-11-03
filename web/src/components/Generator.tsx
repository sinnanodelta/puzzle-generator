// The generator tab (SPEC §4.4): the run bar, the settings and counters of a run, the live
// leaderboard, and a rotatable view of the selected puzzle. On small screens the settings and the
// leaderboard share one pane, the leaderboard is a list of cards, and the view stays below.
import { useMemo, useState, useSyncExternalStore } from 'react';
import { toDoc } from '../core/doc';
import { rate } from '../core/rating';
import {
  BOARD_SIZE,
  boardView,
  saveEntry,
  setBoardView,
  setSettings,
  shownBoard,
  startGenerator,
  stopGenerator,
  wakeLockSupported,
} from '../generation';
import { type BoardEntry, confirmDiscard, type GenRun, notify, openDoc, randomSeed, setState, type UniquenessCheck, useStore, viewDoc } from '../store';
import type { GenEntry, PuzzleDoc, Vec3 } from '../types';
import { defaultCheckStates, errorMessage } from '../wasm';
import { UniquenessBadge } from './UniquenessBadge';
import { PieceMesh, Viewport } from './Viewport';
import './Generator.css';

const PHONE = '(max-width: 820px)';

function subscribePhone(onChange: () => void): () => void {
  const query = matchMedia(PHONE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => matchMedia(PHONE).matches);
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${(ms / 1000).toFixed(1)} s`;
}

/** 12345 as "12.3k". */
function short(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

function NumberSetting({
  label,
  title,
  value,
  min,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  title: string;
  value: number;
  min: number;
  disabled: boolean;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <input type="number" inputMode="numeric" min={min} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <small className="dim">{hint}</small>}
    </label>
  );
}

function CheckSetting({ label, title, checked, disabled, onChange }: { label: string; title: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field gen-check" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Settings({ running }: { running: boolean }) {
  const s = useStore((st) => st.genSettings);
  const hasRequired = useStore((st) => (st.doc.target?.required.size ?? 0) > 0);
  const screenOn = useStore((st) => st.genScreenOn);
  return (
    <>
      <section className="gen-section">
        <h4>Search</h4>
        <NumberSetting
          label="Workers"
          title="Parallel runs, each with its own seed. Fewer workers use less memory, so a phone is less likely to reload the page in the background."
          value={s.workers}
          min={1}
          disabled={running}
          onChange={(workers) => setSettings({ workers })}
        />
        <div className="field" title="Worker i runs with seed + i: the same seed and settings give the same run">
          <span>Seed</span>
          <input type="number" inputMode="numeric" min={0} value={s.seed} disabled={running} onChange={(e) => setSettings({ seed: Number(e.target.value) })} />
          <button disabled={running} title="Random seed" aria-label="Random seed" onClick={() => setSettings({ seed: randomSeed() })}>
            🎲
          </button>
        </div>
        <NumberSetting
          label="Target level"
          title="Stops the run once a puzzle reaches this level (0: no target)"
          value={s.targetLevel}
          min={0}
          disabled={running}
          onChange={(targetLevel) => setSettings({ targetLevel })}
        />
        <NumberSetting
          label="Time limit (s)"
          title="Stops the run after this many seconds (0: no limit)"
          value={s.timeLimit}
          min={0}
          disabled={running}
          onChange={(timeLimit) => setSettings({ timeLimit })}
        />
        <CheckSetting
          label="Fill target first"
          title="The search prefers fewer holes (required target cells left empty) to a higher level, and the target level counts only puzzles without holes"
          checked={s.fillTarget}
          disabled={running || !hasRequired}
          onChange={(fillTarget) => setSettings({ fillTarget })}
        />
        <CheckSetting
          label="Auto tuning"
          title="The search sets how many voxels a perturbation removes (up to 12), and restarts from the base once a climb has stalled twice as long as it had been improving. Off: Max removed and Restart after, under Advanced."
          checked={s.auto}
          disabled={running}
          onChange={(auto) => setSettings({ auto })}
        />
      </section>
      <details className="gen-section gen-advanced">
        <summary>Advanced</summary>
        <NumberSetting
          label="Check cap"
          title="States explored by each solvability check before it gives up (a give-up counts as unsolvable)"
          value={s.maxStates ?? defaultCheckStates()}
          min={1}
          disabled={running}
          onChange={(maxStates) => setSettings({ maxStates })}
        />
        <NumberSetting
          label="Max removed"
          title="Voxels removed at most between two greedy passes (R)"
          value={s.maxRemoved}
          min={1}
          disabled={running || s.auto}
          hint={s.auto ? 'auto' : undefined}
          onChange={(maxRemoved) => setSettings({ maxRemoved })}
        />
        <NumberSetting
          label="Restart after"
          title="Passes without improvement before restarting from the base (N; 0: never)"
          value={s.restartAfter}
          min={0}
          disabled={running || s.auto}
          hint={s.auto ? 'auto' : undefined}
          onChange={(restartAfter) => setSettings({ restartAfter })}
        />
      </details>
      <section className="gen-section">
        <h4>In the background</h4>
        <CheckSetting
          label="Keep the screen on while running"
          title="A phone that sleeps or a hidden tab slows down or stops the run: the screen stays on while the tab is shown"
          checked={s.keepAwake}
          disabled={!wakeLockSupported()}
          onChange={(keepAwake) => setSettings({ keepAwake })}
        />
        <p className="gen-note dim small">
          {!wakeLockSupported() ? 'This browser cannot keep the screen on. ' : running && s.keepAwake ? (screenOn ? 'The screen stays on. ' : 'The browser may still turn the screen off. ') : ''}
          Browsers slow down or pause hidden tabs. The run is saved every few seconds and resumes if the page reloads.
        </p>
      </section>
    </>
  );
}

function Counters({ gen }: { gen: GenRun }) {
  const best = gen.board[0];
  const hasRequired = (gen.base.target?.required.length ?? 0) > 0;
  const bestFilled = gen.board.find((e) => e.holes === 0);
  const tiles: [string, string, string?][] = [
    ['Elapsed', duration(gen.elapsed)],
    ['Checks/s', Math.round(gen.checksPerSecond).toLocaleString()],
    ['Checks', gen.checks.toLocaleString()],
    ['Gave up', gen.checks > 0 ? `${((100 * gen.aborted) / gen.checks).toFixed(1)} %` : '–', 'Checks that reached the check cap'],
    ['Passes', gen.passes.toLocaleString()],
    ['Restarts', gen.restarts.toLocaleString()],
    ['Workers', String(gen.settings.workers)],
    ['Best', best ? best.level_string : '–'],
  ];
  if (hasRequired) tiles.push(['Best filled', bestFilled ? bestFilled.level_string : '–', 'Best puzzle without holes in the target']);
  if (gen.resumes > 0) tiles.push(['Resumed', `${gen.resumes}×`, 'Times the run resumed after the page was reloaded']);
  return (
    <dl className="gen-counters">
      {tiles.map(([label, value, title]) => (
        <div key={label} title={title}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunPanel({ gen }: { gen: GenRun | null }) {
  const docName = useStore((s) => s.doc.name);
  const running = gen?.running ?? false;
  return (
    <div className="gen-panel">
      <section className="gen-section">
        <h4>Base</h4>
        <div className="gen-base">
          <strong title={running ? 'The puzzle the run started from' : 'The puzzle in the editor'}>{running ? gen!.base.name : docName}</strong>
          <button disabled={running} onClick={() => setState({ tab: 'editor' })}>
            Edit
          </button>
        </div>
      </section>
      <Settings running={running} />
      {gen?.error && <p className="gen-error">{gen.error}</p>}
      {gen && (
        <section className="gen-section">
          <h4>Run</h4>
          <Counters gen={gen} />
        </section>
      )}
    </div>
  );
}

/** Start or stop, the state of the run and its main counters; on small screens also the pane switch. */
function RunBar({
  gen,
  pane,
  setPane,
  phone,
  onStart,
}: {
  gen: GenRun | null;
  pane: Pane;
  setPane: (p: Pane) => void;
  phone: boolean;
  onStart: () => void;
}) {
  const running = gen?.running ?? false;
  const best = gen?.board[0];
  const state = running ? `Running · ${duration(gen!.elapsed)}` : (gen?.stopReason ?? 'Ready');
  return (
    <div className="gen-bar">
      {running ? (
        <button className="danger" onClick={() => stopGenerator()}>
          Stop
        </button>
      ) : (
        <button className="primary" onClick={onStart}>
          Start
        </button>
      )}
      <div className="gen-status">
        <span className={`gen-state ${gen?.error ? 'bad' : ''}`}>{state}</span>
        {gen && (
          <span className="dim small">
            {best ? `best ${best.level_string}` : 'no puzzle yet'}
            {running && ` · ${short(gen.checksPerSecond)} checks/s`}
          </span>
        )}
      </div>
      {phone && (
        <div className="segmented gen-pane-switch">
          <button className={pane === 'settings' ? 'on' : ''} onClick={() => setPane('settings')}>
            Settings
          </button>
          <button className={pane === 'board' ? 'on' : ''} onClick={() => setPane('board')}>
            Board{gen && gen.board.length > 0 ? ` ${Math.min(gen.board.length, BOARD_SIZE)}` : ''}
          </button>
        </div>
      )}
    </div>
  );
}

/** A leaderboard row: an entry and its rank in the leaderboard shown. */
interface Row {
  entry: BoardEntry;
  rank: number;
}

function ratingTitle(entry: GenEntry): string {
  const r = rate(entry.key, entry.document);
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  return `Rating ${r.total}/100: balance of the piece sizes ${pct(r.balance)} · 3D printing without supports ${pct(r.print)}`;
}

function run(action: () => Promise<void>): void {
  action().catch((e) => notify(errorMessage(e)));
}

function Actions({ entry, saved }: { entry: GenEntry; saved: boolean }) {
  return (
    <>
      <button title="Replay its disassembly in the viewer" onClick={() => void viewDoc(entry.document)}>
        View
      </button>
      <button disabled={saved} title="Save it to the library" onClick={() => run(() => saveEntry(entry))}>
        {saved ? 'Saved' : 'Save'}
      </button>
      <button
        title="Open it in the editor"
        onClick={() => {
          if (confirmDiscard()) openDoc(entry.document);
        }}
      >
        Open
      </button>
    </>
  );
}

interface BoardProps {
  rows: Row[];
  saved: string[];
  /** Null without a target: the uniqueness is not checked. */
  uniqueness: Record<string, UniquenessCheck> | null;
  /** Shows the holes of each puzzle. */
  holes: boolean;
  /** The entry in the 3D view: the one picked, or the first. */
  shown: string | null;
  /** The entry the user picked. */
  picked: string | null;
}

function Table({ rows, saved, uniqueness, holes, shown }: BoardProps) {
  return (
    <table className="burrs leaderboard">
      <thead>
        <tr>
          <th>#</th>
          <th>Level</th>
          <th>Moves</th>
          <th title="0–100: half for balanced piece sizes, half for pieces easy to 3D print">Rating</th>
          {holes && <th title="Required cells of the target left empty">Holes</th>}
          <th title="Time into the run">Found</th>
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
            <td title={ratingTitle(entry)}>{rate(entry.key, entry.document).total}</td>
            {holes && <td className={entry.holes > 0 ? 'holes' : 'dim'}>{entry.holes}</td>}
            <td className="dim">{duration(entry.found)}</td>
            {uniqueness && (
              <td>
                <UniquenessBadge check={uniqueness[entry.key]} />
              </td>
            )}
            <td className="gen-row-actions" onClick={(e) => e.stopPropagation()}>
              <Actions entry={entry} saved={saved.includes(entry.key)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The leaderboard as cards, for small screens. The card picked shows its actions; the first one,
 * shown by default, doesn't: a card that grows whenever a better puzzle comes would move the cards
 * under the user's finger.
 */
function Cards({ rows, saved, uniqueness, holes, shown, picked }: BoardProps) {
  return (
    <ol className="gen-cards">
      {rows.map(({ entry, rank }) => {
        const selected = entry.key === shown;
        return (
          <li key={entry.key} className={selected ? 'selected' : ''} onClick={() => setState({ genSelected: entry.key })}>
            <span className="gen-card-rank dim">{rank}</span>
            <div className="gen-card-main">
              <div className="gen-card-line">
                <strong className="gen-card-level">{entry.level_string}</strong>
                <span>{entry.score.total_moves} moves</span>
                <span className="dim" title={ratingTitle(entry)}>
                  ★ {rate(entry.key, entry.document).total}
                </span>
              </div>
              <div className="gen-card-line">
                {uniqueness && <UniquenessBadge check={uniqueness[entry.key]} />}
                {holes && entry.holes > 0 && <span className="holes">{entry.holes === 1 ? '1 hole' : `${entry.holes} holes`}</span>}
                <span className="dim">{duration(entry.found)}</span>
              </div>
              {entry.key === picked && (
                <div className="gen-card-actions" onClick={(e) => e.stopPropagation()}>
                  <Actions entry={entry} saved={saved.includes(entry.key)} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Filter({ label, title, checked, onChange }: { label: string; title: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`gen-chip ${checked ? 'on' : ''}`} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
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

type Pane = 'settings' | 'board';

export function Generator() {
  const gen = useStore((s) => s.gen);
  const selected = useStore((s) => s.genSelected);
  const editorDoc = useStore((s) => s.doc);
  const base = useMemo(() => gen?.base ?? toDoc(editorDoc), [gen?.base, editorDoc]);
  const uniqueOnly = useStore((s) => s.genUniqueOnly);
  const filledOnly = useStore((s) => s.genFilledOnly);
  const onePerLevel = useStore((s) => s.genOnePerLevel);
  const byRating = useStore((s) => s.genByRating);
  const phone = usePhone();
  const [pane, setPane] = useState<Pane>(gen ? 'board' : 'settings');
  const board = gen?.board ?? [];
  const checked = base.target !== null;
  const hasRequired = (base.target?.required.length ?? 0) > 0;
  const view = boardView({ genFilledOnly: filledOnly, genOnePerLevel: onePerLevel, genByRating: byRating }, hasRequired);
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
  const props: BoardProps = {
    rows,
    saved: gen?.saved ?? [],
    uniqueness,
    holes: hasRequired && board.some((e) => e.holes > 0),
    shown: shown?.entry.key ?? null,
    picked: shown?.entry.key === selected ? selected : null,
  };
  const start = () => {
    startGenerator();
    setPane('board');
  };

  return (
    <div className={`generator pane-${pane}`}>
      <RunBar gen={gen} pane={pane} setPane={setPane} phone={phone} onStart={start} />
      <RunPanel gen={gen} />
      <div className="gen-board">
        <div className="gen-board-header">
          <h2>Leaderboard</h2>
          <span className="dim small">
            {list.length}/{BOARD_SIZE} puzzles{view.filledOnly ? ' without holes' : ''}
            {checked ? (list.length > 0 ? ` · ${done} checked for uniqueness` : '') : ' · no target: uniqueness not checked'}
          </span>
        </div>
        <div className="gen-filters">
          {hasRequired && (
            <Filter
              label="Target filled only"
              title="Shows only the puzzles that fill every required cell of the target, best first"
              checked={filledOnly}
              onChange={(v) => setBoardView({ genFilledOnly: v })}
            />
          )}
          <Filter label="One per level" title="Shows only the best rated puzzle of each level" checked={onePerLevel} onChange={(v) => setBoardView({ genOnePerLevel: v })} />
          <Filter
            label="Sort by rating"
            title="Sorts by rating: balanced piece sizes and pieces easy to 3D print"
            checked={byRating}
            onChange={(v) => setBoardView({ genByRating: v })}
          />
          {checked && (
            <Filter
              label="Unique only"
              title="Shows only the puzzles with exactly one assembly that comes apart"
              checked={uniqueOnly}
              onChange={(v) => setState({ genUniqueOnly: v })}
            />
          )}
        </div>
        <div className="gen-board-body">
          {rows.length > 0 ? (
            phone ? (
              <Cards {...props} />
            ) : (
              <Table {...props} />
            )
          ) : list.length > 0 ? (
            <p className="dim">No unique puzzle so far.</p>
          ) : view.filledOnly && board.length > 0 ? (
            <p className="dim">No puzzle without holes so far.</p>
          ) : gen?.running ? (
            <p className="dim">Searching…</p>
          ) : (
            <div className="gen-empty">
              <p className="dim">Start a run to fill the leaderboard with the best puzzles found.</p>
              {phone && !gen && (
                <button className="primary" onClick={start}>
                  Start
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="gen-scene">
        {shown ? (
          <Preview doc={shown.entry.document} caption={`#${shown.rank} · level ${shown.entry.level_string} · ${shown.entry.score.total_moves} moves`} />
        ) : (
          <Preview doc={base} caption={`Base: ${base.name}`} />
        )}
      </div>
    </div>
  );
}

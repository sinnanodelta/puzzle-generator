// Generator runs (SPEC §4.3): one worker per seed, each running the generator on a copy of the base.
// Their reports are merged into one leaderboard, deduplicated by canonical key, and flushed to the
// store a few times a second. When the base has a target, one more worker checks the uniqueness of the
// leaderboard entries, best first (SPEC §4.4).
import { toDoc } from './core/doc';
import { getEntry, newEntryId, putEntry, type Uniqueness, uniquenessKey, uniquenessOf } from './core/library';
import { rate } from './core/rating';
import { renderThumbnail } from './core/thumbnail';
import { type BoardEntry, type GenSettings, getState, notify, setState, type State, type UniquenessCheck } from './store';
import type { GenEntry, PuzzleDoc, StepReport } from './types';
import { defaultCheckStates, errorMessage } from './wasm';
import type { AssembleRequest, AssembleResponse } from './workers/assemble.worker';
import type { GeneratorRequest, GeneratorResponse } from './workers/generator.worker';

/** The leaderboard size (SPEC §4.4), also the number of puzzles each worker keeps. */
export const BOARD_SIZE = 20;
const FLUSH_MS = 250;
/** The window of the checks-per-second rate. */
const RATE_MS = 2000;

interface Active {
  workers: Worker[];
  /** The latest report of each worker; its counters are totals since the start. */
  reports: (StepReport | null)[];
  board: Map<string, BoardEntry>;
  started: number;
  samples: { time: number; checks: number }[];
  timer: ReturnType<typeof setInterval>;
}

let active: Active | null = null;

function better(a: GenEntry, b: GenEntry): number {
  return b.score.level - a.score.level || b.score.total_moves - a.score.total_moves;
}

/** The `BOARD_SIZE` best entries and the `BOARD_SIZE` best without holes, best first, as each worker keeps them. */
function kept(entries: BoardEntry[]): BoardEntry[] {
  let filled = 0;
  return entries.sort(better).filter((e, i) => {
    const keep = i < BOARD_SIZE || (e.holes === 0 && filled < BOARD_SIZE);
    if (e.holes === 0) filled++;
    return keep;
  });
}

export interface BoardView {
  /** Only the puzzles without holes. */
  filledOnly: boolean;
  /** Only the best rated puzzle of each level. */
  onePerLevel: boolean;
  /** Sorted by rating, then by score. */
  byRating: boolean;
}

/** The leaderboard shown: the best puzzles, or with `filledOnly` the best without holes. */
export function shownBoard(board: BoardEntry[], view: BoardView): BoardEntry[] {
  let list = view.filledOnly ? board.filter((e) => e.holes === 0) : board.slice(0, BOARD_SIZE);
  const rating = (e: BoardEntry) => rate(e.key, e.document).total;
  if (view.byRating) list = [...list].sort((a, b) => rating(b) - rating(a) || better(a, b));
  if (view.onePerLevel) {
    const best = new Map<string, BoardEntry>();
    for (const e of list) {
      const b = best.get(e.level_string);
      if (!b || rating(e) > rating(b)) best.set(e.level_string, e);
    }
    list = list.filter((e) => best.get(e.level_string) === e);
  }
  return list;
}

export function boardView(s: Pick<State, 'genFilledOnly' | 'genOnePerLevel' | 'genByRating'>, hasRequired: boolean): BoardView {
  return { filledOnly: s.genFilledOnly && hasRequired, onePerLevel: s.genOnePerLevel, byRating: s.genByRating };
}

/** Changes the leaderboard filters; the uniqueness checks follow the leaderboard shown. */
export function setBoardView(patch: Partial<Pick<State, 'genFilledOnly' | 'genOnePerLevel' | 'genByRating'>>): void {
  setState(patch);
  pumpUniqueness();
}

/** The settings as integers in range; the fields of the form may hold anything. */
function normalized(s: GenSettings): GenSettings {
  const int = (v: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
    Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
  return {
    workers: int(s.workers, 1, 64),
    seed: int(s.seed, 0),
    maxStates: s.maxStates === null ? null : int(s.maxStates, 1),
    maxRemoved: int(s.maxRemoved, 1),
    restartAfter: int(s.restartAfter, 0),
    timeLimit: int(s.timeLimit, 0),
    targetLevel: int(s.targetLevel, 0),
    fillTarget: s.fillTarget,
  };
}

/** Starts a run on the document of the editor. */
export function startGenerator(): void {
  if (active) return;
  cancelUniqueness();
  const settings = normalized(getState().genSettings);
  const base = toDoc(getState().doc);
  const run: Active = {
    workers: [],
    reports: Array<StepReport | null>(settings.workers).fill(null),
    board: new Map(),
    started: performance.now(),
    samples: [],
    timer: setInterval(() => flush(), FLUSH_MS),
  };
  active = run;
  setState({
    genSettings: settings,
    genSelected: null,
    gen: {
      base,
      settings,
      running: true,
      elapsed: 0,
      checks: 0,
      aborted: 0,
      passes: 0,
      restarts: 0,
      checksPerSecond: 0,
      board: [],
      saved: [],
      uniqueness: {},
      stopReason: null,
      error: null,
    },
  });
  const maxStates = settings.maxStates ?? defaultCheckStates();
  for (let i = 0; i < settings.workers; i++) {
    const worker = new Worker(new URL('./workers/generator.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<GeneratorResponse>) => {
      if (active !== run) return;
      if ('error' in e.data) stopGenerator('Failed', e.data.error);
      else receive(run, i, e.data.report);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      if (active === run) stopGenerator('Failed', e.message || 'a generator worker crashed');
    };
    const request: GeneratorRequest = {
      doc: base,
      options: {
        seed: settings.seed + i,
        max_states: maxStates,
        max_removed: settings.maxRemoved,
        restart_after: settings.restartAfter,
        keep: BOARD_SIZE,
        fill_target: settings.fillTarget,
      },
    };
    worker.postMessage(request);
    run.workers.push(worker);
  }
}

function receive(run: Active, worker: number, report: StepReport): void {
  run.reports[worker] = report;
  const found = performance.now() - run.started;
  for (const entry of report.entries) {
    if (!run.board.has(entry.key)) run.board.set(entry.key, { ...entry, found });
  }
  if (run.board.size > BOARD_SIZE) run.board = new Map(kept([...run.board.values()]).map((e) => [e.key, e]));
  const settings = getState().gen?.settings;
  const target = settings?.targetLevel ?? 0;
  const best = settings?.fillTarget ? report.best_filled : report.best;
  if (target > 0 && best && best.level >= target) stopGenerator(`Reached level ${target}`);
}

/** Publishes the counters and the leaderboard of the active run; `stop` ends it. */
function flush(stop?: { reason: string; error: string | null }): void {
  const run = active;
  if (!run) return;
  const now = performance.now();
  const elapsed = now - run.started;
  const totals = { checks: 0, aborted: 0, passes: 0, restarts: 0 };
  for (const r of run.reports) {
    if (!r) continue;
    totals.checks += r.checks;
    totals.aborted += r.aborted;
    totals.passes += r.passes;
    totals.restarts += r.restarts;
  }
  run.samples.push({ time: now, checks: totals.checks });
  while (run.samples.length > 2 && now - run.samples[1].time >= RATE_MS) run.samples.shift();
  const first = run.samples[0];
  const span = (now - first.time) / 1000;
  const checksPerSecond = span > 0 ? (totals.checks - first.checks) / span : 0;
  const board = [...run.board.values()].sort(better);
  setState((s) => ({
    gen: s.gen && {
      ...s.gen,
      ...totals,
      elapsed,
      checksPerSecond,
      board,
      running: !stop,
      stopReason: stop?.reason ?? null,
      error: stop?.error ?? null,
    },
  }));
  pumpUniqueness();
  const limit = getState().gen?.settings.timeLimit ?? 0;
  if (!stop && limit > 0 && elapsed >= limit * 1000) stopGenerator('Time limit reached');
}

/** Stops the active run: the workers are terminated and the leaderboard stays. */
export function stopGenerator(reason = 'Stopped', error: string | null = null): void {
  const run = active;
  if (!run) return;
  flush({ reason, error });
  active = null;
  clearInterval(run.timer);
  for (const worker of run.workers) worker.terminate();
}

/** Saves a leaderboard entry to the library, with its uniqueness result once there is one. */
export async function saveEntry(entry: GenEntry): Promise<void> {
  const now = new Date().toISOString();
  const doc = { ...entry.document, meta: { ...entry.document.meta, created: now, updated: now } };
  const id = newEntryId();
  const check = getState().gen?.uniqueness[entry.key];
  savedIds.set(entry.key, id);
  await putEntry({
    id,
    name: doc.name,
    doc,
    thumbnail: renderThumbnail(doc),
    meta: {
      status: 'solved',
      levelString: entry.level_string,
      uniqueness: check?.kind === 'done' ? check.result : null,
      created: now,
      updated: now,
    },
  });
  setState((s) => ({
    libraryVersion: s.libraryVersion + 1,
    message: `Saved “${doc.name}” to the library`,
    gen: s.gen && { ...s.gen, saved: [...s.gen.saved, entry.key] },
  }));
}

// --- Uniqueness ---------------------------------------------------------------------------------

/** The uniqueness check of the leaderboard entry `key` of the run on `base`. */
interface UniquenessJob {
  id: number;
  base: PuzzleDoc;
  key: string;
  doc: PuzzleDoc;
}

let assembler: Worker | null = null;
let job: UniquenessJob | null = null;
let lastJobId = 0;
/** The library entries saved from the leaderboard, by entry key: they get the uniqueness result when it comes. */
const savedIds = new Map<string, string>();

function newAssembler(): Worker {
  const worker = new Worker(new URL('./workers/assemble.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<AssembleResponse>) => {
    if (!job || job.id !== e.data.id) return;
    finish(job, 'error' in e.data ? { kind: 'failed', error: e.data.error } : { kind: 'done', result: uniquenessOf(e.data.result) });
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    if (assembler === worker) assembler = null;
    if (job) finish(job, { kind: 'failed', error: e.message || 'the assembler worker crashed' });
  };
  return worker;
}

function setUniqueness(base: PuzzleDoc, key: string, check: UniquenessCheck): void {
  setState((s) => (s.gen?.base === base ? { gen: { ...s.gen, uniqueness: { ...s.gen.uniqueness, [key]: check } } } : {}));
}

function finish(done: UniquenessJob, check: UniquenessCheck): void {
  job = null;
  setUniqueness(done.base, done.key, check);
  if (check.kind === 'done') recordUniqueness(done, check.result).catch((e) => notify(errorMessage(e)));
  pumpUniqueness();
}

/** Starts the uniqueness check of the best waiting leaderboard entry, shown ones first, unless one is running. */
function pumpUniqueness(): void {
  const s = getState();
  const gen = s.gen;
  if (job || !gen || gen.base.target === null) return;
  const order = [...shownBoard(gen.board, boardView(s, gen.base.target.required.length > 0)), ...gen.board];
  const entry = order.find((e) => !(e.key in gen.uniqueness));
  if (!entry) return;
  job = { id: ++lastJobId, base: gen.base, key: entry.key, doc: entry.document };
  setUniqueness(gen.base, entry.key, { kind: 'checking' });
  assembler ??= newAssembler();
  const request: AssembleRequest = { id: job.id, doc: entry.document };
  assembler.postMessage(request);
}

/** Drops the checks of the previous run. */
function cancelUniqueness(): void {
  if (job && assembler) {
    assembler.terminate();
    assembler = null;
  }
  job = null;
  savedIds.clear();
}

/** Gives a uniqueness result to the library entry saved from that leaderboard entry, if it is unchanged. */
async function recordUniqueness(done: UniquenessJob, result: Uniqueness): Promise<void> {
  const id = savedIds.get(done.key);
  if (!id) return;
  const entry = await getEntry(id);
  if (!entry || uniquenessKey(entry.doc) !== uniquenessKey(done.doc)) return;
  await putEntry({ ...entry, meta: { ...entry.meta, uniqueness: result } });
  setState((s) => ({ libraryVersion: s.libraryVersion + 1 }));
}

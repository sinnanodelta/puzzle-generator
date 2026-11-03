// Generator runs (SPEC §4.3): one worker per seed, each running the generator on a copy of the base.
// Their reports are merged into one leaderboard, deduplicated by canonical key, and flushed to the
// store a few times a second. When the base has a target, one more worker checks the uniqueness of the
// leaderboard entries, best first (SPEC §4.4).
//
// Browsers slow down, freeze or discard a page in the background, and nothing can prevent it. So the
// run keeps the screen on while it is active (Screen Wake Lock), and is kept in IndexedDB: after the
// page is reloaded, it resumes with fresh seeds, its leaderboard, counters and uniqueness checks.
import { toDoc } from './core/doc';
import { getEntry, newEntryId, putEntry, savedMessage, type Uniqueness, uniquenessKey } from './core/library';
import { rate } from './core/rating';
import { loadRun, type RunMeta, saveRun } from './core/runstore';
import { renderThumbnail } from './core/thumbnail';
import { type BoardEntry, type GenRun, type GenSettings, getState, notify, setState, type State, type UniquenessCheck } from './store';
import type { AssembleResult, GenEntry, PuzzleDoc, StepReport } from './types';
import { defaultCheckStates, errorMessage, initWasm } from './wasm';
import type { AssembleRequest, AssembleResponse } from './workers/assemble.worker';
import type { GeneratorRequest, GeneratorResponse } from './workers/generator.worker';

/** The leaderboard size (SPEC §4.4), also the number of puzzles each worker keeps. */
export const BOARD_SIZE = 20;
const FLUSH_MS = 250;
/** The window of the checks-per-second rate. */
const RATE_MS = 2000;
/** How often a running run is saved. */
const SAVE_MS = 5000;
/** Held by the tab running the generator, so that another tab does not resume the same run. */
const LOCK = 'puzzle-generator-run';

type Totals = Pick<GenRun, 'checks' | 'aborted' | 'passes' | 'restarts'>;

interface Active {
  workers: Worker[];
  /** The latest report of each worker; its counters are totals since the worker started. */
  reports: (StepReport | null)[];
  board: Map<string, BoardEntry>;
  /** The start of this part of the run, and the elapsed time and totals of the parts before it. */
  started: number;
  before: Totals & { elapsed: number };
  samples: { time: number; checks: number }[];
  timer: ReturnType<typeof setInterval>;
  lastSave: number;
  releaseLock: () => void;
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

/** Changes the settings form; they are kept with the run. */
export function setSettings(patch: Partial<GenSettings>): void {
  setState((s) => ({ genSettings: { ...s.genSettings, ...patch } }));
  if ('keepAwake' in patch) void updateWakeLock();
  scheduleSave();
}

/** The settings as integers in range; the fields of the form may hold anything. */
function normalized(s: GenSettings): GenSettings {
  const int = (v: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
    Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
  return {
    workers: int(s.workers, 1, 64),
    seed: int(s.seed, 0),
    maxStates: s.maxStates === null ? null : int(s.maxStates, 1),
    auto: s.auto,
    maxRemoved: int(s.maxRemoved, 1),
    restartAfter: int(s.restartAfter, 0),
    timeLimit: int(s.timeLimit, 0),
    targetLevel: int(s.targetLevel, 0),
    fillTarget: s.fillTarget,
    keepAwake: s.keepAwake,
  };
}

/** Starts a run on the document of the editor. */
export function startGenerator(): void {
  if (active) return;
  cancelUniqueness();
  const settings = normalized(getState().genSettings);
  const gen: GenRun = {
    base: toDoc(getState().doc),
    settings,
    running: true,
    elapsed: 0,
    checks: 0,
    aborted: 0,
    passes: 0,
    restarts: 0,
    checksPerSecond: 0,
    resumes: 0,
    board: [],
    saved: [],
    uniqueness: {},
    stopReason: null,
    error: null,
  };
  setState({ genSettings: settings, genSelected: null, gen });
  launch(gen);
}

/** Runs the workers of `gen`, continuing its counters and leaderboard. */
function launch(gen: GenRun): void {
  const { settings, base } = gen;
  const run: Active = {
    workers: [],
    reports: Array<StepReport | null>(settings.workers).fill(null),
    board: new Map(gen.board.map((e) => [e.key, e])),
    started: performance.now(),
    before: { elapsed: gen.elapsed, checks: gen.checks, aborted: gen.aborted, passes: gen.passes, restarts: gen.restarts },
    samples: [],
    timer: setInterval(() => flush(), FLUSH_MS),
    lastSave: performance.now(),
    releaseLock: () => {},
  };
  active = run;
  void takeLock(run);
  void updateWakeLock();
  saveNow();
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
        // Each resumed part of the run continues with seeds no worker has used yet.
        seed: settings.seed + i + gen.resumes * settings.workers,
        max_states: maxStates,
        auto: settings.auto,
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
  const found = run.before.elapsed + performance.now() - run.started;
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
  const elapsed = run.before.elapsed + now - run.started;
  const totals: Totals = { checks: run.before.checks, aborted: run.before.aborted, passes: run.before.passes, restarts: run.before.restarts };
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
  const sorted = [...run.board.values()].sort(better);
  setState((s) => {
    if (!s.gen) return {};
    // The same entries keep the same array, so the leaderboard is saved only when it changes.
    const same = sorted.length === s.gen.board.length && sorted.every((e, i) => e === s.gen!.board[i]);
    return {
      gen: {
        ...s.gen,
        ...totals,
        elapsed,
        checksPerSecond,
        board: same ? s.gen.board : sorted,
        running: !stop,
        stopReason: stop?.reason ?? null,
        error: stop?.error ?? null,
      },
    };
  });
  pumpUniqueness();
  if (stop || now - run.lastSave >= SAVE_MS) {
    run.lastSave = now;
    saveNow();
  }
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
  run.releaseLock();
  void updateWakeLock();
}

/** Saves a leaderboard entry to the library, with its uniqueness result once there is one. */
export async function saveEntry(entry: GenEntry): Promise<void> {
  const now = new Date().toISOString();
  const doc = { ...entry.document, meta: { ...entry.document.meta, created: now, updated: now } };
  const id = newEntryId();
  const check = getState().gen?.uniqueness[entry.key];
  savedIds.set(entry.key, id);
  const scope = await putEntry({
    id,
    name: doc.name,
    doc,
    thumbnail: renderThumbnail(doc),
    meta: {
      status: 'solved',
      levelString: entry.level_string,
      moves: entry.score.total_moves,
      uniqueness: check?.kind === 'done' ? check.result : null,
      created: now,
      updated: now,
    },
  });
  setState((s) => ({
    libraryVersion: s.libraryVersion + 1,
    message: savedMessage(scope, doc.name),
    gen: s.gen && { ...s.gen, saved: [...s.gen.saved, entry.key] },
  }));
  scheduleSave();
}

// --- Screen wake lock and the run lock ----------------------------------------------------------

let wakeLock: WakeLockSentinel | null = null;
let wakeLockPending = false;

/** Holds the screen wake lock while a run is active, the page visible and the setting on; the browser releases it when the page is hidden. */
async function updateWakeLock(): Promise<void> {
  const want = active !== null && getState().genSettings.keepAwake && document.visibilityState === 'visible';
  if (!want && wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    await lock.release().catch(() => {});
  } else if (want && !wakeLock && !wakeLockPending && 'wakeLock' in navigator) {
    wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
        setState({ genScreenOn: wakeLock !== null });
      });
      wakeLock = lock;
      // The run may have stopped while the lock was requested.
      if (active === null || !getState().genSettings.keepAwake) await updateWakeLock();
    } catch {
      // Refused (no user activation yet, battery saver, permissions policy): the run goes on.
    } finally {
      wakeLockPending = false;
    }
  }
  setState({ genScreenOn: wakeLock !== null });
}

export function wakeLockSupported(): boolean {
  return 'wakeLock' in navigator;
}

/** Holds the run lock for `run` until it stops. */
async function takeLock(run: Active): Promise<void> {
  if (!('locks' in navigator)) return;
  await navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
    if (!lock || active !== run) return;
    return new Promise<void>((release) => (run.releaseLock = release));
  });
}

// --- Saving and resuming ------------------------------------------------------------------------

/** The leaderboard last saved (or being saved). */
let savedBoard: { board: unknown; uniqueness: unknown; saved: unknown } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Restoring has finished: saving before would overwrite the run of the last visit. */
let restored = false;

/** Saves the run soon: for changes while no run is active. */
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1000);
}

/** Saves the run and the settings form; the leaderboard only when it changed. */
function saveNow(): void {
  clearTimeout(saveTimer);
  if (!restored) return;
  const s = getState();
  const gen = s.gen;
  const meta: RunMeta | null = gen && {
    base: gen.base,
    settings: gen.settings,
    running: gen.running,
    elapsed: gen.elapsed,
    checks: gen.checks,
    aborted: gen.aborted,
    passes: gen.passes,
    restarts: gen.restarts,
    checksPerSecond: 0,
    resumes: gen.resumes,
    stopReason: gen.stopReason,
    error: gen.error,
    form: s.genSettings,
  };
  const board =
    gen && (savedBoard?.board !== gen.board || savedBoard.uniqueness !== gen.uniqueness || savedBoard.saved !== gen.saved)
      ? { board: gen.board, uniqueness: gen.uniqueness, saved: gen.saved, savedIds: [...savedIds] }
      : null;
  if (!meta) return;
  if (board) savedBoard = board;
  saveRun(meta, board).catch(() => {
    // Storage full or blocked: the run goes on, it just cannot be resumed. The next save writes the leaderboard again.
    savedBoard = null;
  });
}

/** Restores the run of the last visit, and resumes it when it was running and no other tab runs it. */
async function restoreRun(): Promise<void> {
  try {
    await initWasm();
    const saved = await loadRun();
    if (!saved || getState().gen) return;
    const { form, ...meta } = saved.meta;
    // A check that was running when the page went away starts again.
    const uniqueness = Object.fromEntries(Object.entries(saved.board.uniqueness).filter(([, c]) => c.kind !== 'checking'));
    const gen: GenRun = { ...meta, board: saved.board.board, saved: saved.board.saved, uniqueness, running: false, checksPerSecond: 0 };
    for (const [key, id] of saved.board.savedIds) savedIds.set(key, id);
    savedBoard = { board: gen.board, uniqueness: gen.uniqueness, saved: gen.saved };
    setState({ gen, genSettings: { ...getState().genSettings, ...form } });
    restored = true;
    if (meta.running && !active) {
      const held = 'locks' in navigator ? ((await navigator.locks.query()).held ?? []) : [];
      if (!held.some((l) => l.name === LOCK)) {
        const next = { ...gen, running: true, resumes: gen.resumes + 1, stopReason: null };
        setState({ gen: next });
        launch(next);
        const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
        notify(`Generator run resumed${discarded ? ' after the browser discarded the page' : ' after the page was reloaded'}`);
      } else {
        setState({ gen: { ...gen, stopReason: 'Running in another tab' } });
      }
    }
    pumpUniqueness();
  } catch {
    // No storage: nothing to restore.
  } finally {
    restored = true;
  }
}

void restoreRun();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
  void updateWakeLock();
});
window.addEventListener('pagehide', saveNow);

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

/** The result without its first solution, which the leaderboard does not keep. */
function uniqueness(result: AssembleResult): Uniqueness {
  const { firstSolution: _, ...rest } = result;
  return rest;
}

function newAssembler(): Worker {
  const worker = new Worker(new URL('./workers/assemble.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<AssembleResponse>) => {
    if (!job || job.id !== e.data.id) return;
    finish(job, 'error' in e.data ? { kind: 'failed', error: e.data.error } : { kind: 'done', result: uniqueness(e.data.result) });
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
  if (!active) scheduleSave();
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

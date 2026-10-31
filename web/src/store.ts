// Application state: one immutable snapshot, replaced on every change and read through
// `useStore(selector)`. The document is edited on a copy (`editDoc`), which is what makes undo cheap.
import { useSyncExternalStore } from 'react';
import { Checker, type CheckState, solveInWorker } from './core/checker';
import { type EDoc, cloneDoc, docEquals, emptyDoc, fixedSignature, fromDoc, toDoc } from './core/doc';
import type { CellState, TargetKind } from './core/edit';
import { type EntryMeta, getEntry, newEntryId, putEntry, type Uniqueness, uniquenessKey } from './core/library';
import { renderThumbnail } from './core/thumbnail';
import type { Analysis, GenEntry, PuzzleDoc, SolveResult, Vec3 } from './types';
import { analyze, defaultMaxStates, errorMessage } from './wasm';

export type Tab = 'library' | 'editor' | 'viewer' | 'generator';
export type Tool = 'pencil' | 'eraser' | 'box' | 'line' | 'brush' | 'select' | 'target';
export type ViewMode = 'normal' | 'ghost' | 'hidden';
/** A 3×3 matrix, row-major. */
export type Mat3 = number[];

export interface ViewerState {
  doc: PuzzleDoc;
  result: SolveResult | null;
  loading: boolean;
  error: string | null;
}

/** The settings of a generator run (SPEC §4); kept between runs. */
export interface GenSettings {
  workers: number;
  /** Worker i runs with seed `seed + i`. */
  seed: number;
  /** The state cap of a check; null is the default cap. */
  maxStates: number | null;
  /** The largest number of voxels removed between greedy passes (R). */
  maxRemoved: number;
  /** Passes without improvement before a restart from the base (N); 0 never restarts. */
  restartAfter: number;
  /** Seconds; 0 is no limit. */
  timeLimit: number;
  /** Stops once a puzzle reaches this level; 0 is no target. With `fillTarget`, only puzzles without holes count. */
  targetLevel: number;
  /** The search prefers fewer holes in the target to a higher level (SPEC §4.2). */
  fillTarget: boolean;
}

/** A leaderboard entry, found `found` ms after the start of the run. */
export interface BoardEntry extends GenEntry {
  found: number;
}

/** The uniqueness check of a leaderboard entry (SPEC §5). */
export type UniquenessCheck = { kind: 'checking' } | { kind: 'done'; result: Uniqueness } | { kind: 'failed'; error: string };

/** A generator run, live or stopped. Counters are summed over the workers. */
export interface GenRun {
  base: PuzzleDoc;
  settings: GenSettings;
  running: boolean;
  /** Milliseconds. */
  elapsed: number;
  checks: number;
  aborted: number;
  passes: number;
  restarts: number;
  checksPerSecond: number;
  /** The best distinct puzzles of all workers, and the best without holes, best first. */
  board: BoardEntry[];
  /** The keys of the entries saved to the library. */
  saved: string[];
  /** Per entry key; absent is waiting. Only with a target. */
  uniqueness: Record<string, UniquenessCheck>;
  stopReason: string | null;
  error: string | null;
}

export interface State {
  tab: Tab;
  doc: EDoc;
  /** The library entry the document was opened from or saved to. */
  libraryId: string | null;
  /** Edited since opened or saved. */
  dirty: boolean;
  past: EDoc[];
  future: EDoc[];
  /** The piece being painted. */
  current: number;
  /** Ids of the pieces selected with the current one: they get its optional marks and erasing too. */
  paintedWith: string[];
  paintState: CellState;
  tool: Tool;
  targetKind: TargetKind;
  showTarget: boolean;
  /** The layer view: the axis across the layers, and the layer shown. */
  axis: 0 | 1 | 2;
  slice: number;
  /** Per piece id; absent is 'normal'. */
  viewModes: Record<string, ViewMode>;
  /** A piece id shown alone. */
  isolate: string | null;
  /** The layer view is shown beside the 3D view. */
  showLayers: boolean;
  /** The optional marks are hidden in both views, to edit the fixed voxels. */
  hideOptional: boolean;
  /** The header shows the document name and its buttons (small screens fold it). */
  headerOpen: boolean;
  /** Hovering shows the voxel a left click would add; holding Shift hides it. */
  hoverPreview: boolean;
  /** The cell a left click with the pencil would paint, under the pointer in either view. */
  hoverCell: Vec3 | null;
  /** How the 3D views turn the puzzle frame (display only): a rotation of quarter turns. */
  orientation: Mat3;
  selection: Set<number>;
  check: CheckState;
  analysis: Analysis | null;
  viewer: ViewerState | null;
  message: string | null;
  /** Bumped when the library changes, so its view reloads. */
  libraryVersion: number;
  genSettings: GenSettings;
  gen: GenRun | null;
  /** The key of the leaderboard entry shown; null shows the best. */
  genSelected: string | null;
  /** The leaderboard shows only the unique puzzles. */
  genUniqueOnly: boolean;
  /** The leaderboard shows only the puzzles without holes in the target. */
  genFilledOnly: boolean;
  /** The leaderboard shows only the best rated puzzle of each level. */
  genOnePerLevel: boolean;
  /** The leaderboard is sorted by rating. */
  genByRating: boolean;
}

const HISTORY = 200;

let state: State = {
  tab: 'library',
  doc: emptyDoc(),
  libraryId: null,
  dirty: false,
  past: [],
  future: [],
  current: 0,
  paintedWith: [],
  paintState: 'fixed',
  tool: 'pencil',
  targetKind: 'required',
  showTarget: false,
  axis: 2,
  slice: 0,
  viewModes: {},
  isolate: null,
  showLayers: true,
  hideOptional: false,
  headerOpen: false,
  hoverPreview: true,
  hoverCell: null,
  orientation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  selection: new Set(),
  check: { kind: 'idle' },
  analysis: null,
  viewer: null,
  message: null,
  libraryVersion: 0,
  genSettings: {
    workers: Math.max(1, (navigator.hardwareConcurrency || 2) - 1),
    seed: randomSeed(),
    maxStates: null,
    maxRemoved: 3,
    restartAfter: 30,
    timeLimit: 0,
    targetLevel: 0,
    fillTarget: false,
  },
  gen: null,
  genSelected: null,
  genUniqueOnly: false,
  genFilledOnly: false,
  genOnePerLevel: false,
  genByRating: false,
};

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The selected part of the state; the selector must return a stable value (no new objects). */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function notify(message: string): void {
  setState({ message });
}

// --- Live check and analysis -------------------------------------------------------------------

const checker = new Checker((check) => {
  setState({ check });
  if (check.kind === 'done' || check.kind === 'invalid') void recordStatus(check);
});

let analysisTimer: ReturnType<typeof setTimeout> | undefined;
let analysisSignature = '';

function scheduleAnalysis(signature: string): void {
  clearTimeout(analysisTimer);
  if (signature === analysisSignature) return;
  analysisTimer = setTimeout(() => {
    analysisSignature = signature;
    try {
      setState({ analysis: analyze(toDoc(state.doc)) });
    } catch (e) {
      setState({ analysis: null, message: errorMessage(e) });
    }
  }, 120);
}

/** After any change of the document: keeps indices in range and schedules the checks. */
function docChanged(): void {
  const d = state.doc;
  const patch: Partial<State> = {};
  if (state.current >= d.pieces.length) patch.current = Math.max(0, d.pieces.length - 1);
  if (state.slice >= d.grid[state.axis]) patch.slice = d.grid[state.axis] - 1;
  if (Object.keys(patch).length > 0) setState(patch);
  const signature = fixedSignature(d);
  checker.schedule(signature, () => toDoc(state.doc));
  scheduleAnalysis(signature);
}

/** The status of the current document, when the check is about its present fixed voxels. */
export function currentStatus(s: State): Pick<EntryMeta, 'status' | 'levelString'> {
  const check = s.check;
  if ((check.kind === 'done' || check.kind === 'invalid') && check.signature === fixedSignature(s.doc)) {
    if (check.kind === 'invalid') return { status: 'invalid', levelString: null };
    return { status: check.result.status, levelString: check.result.solution?.level_string ?? null };
  }
  return { status: null, levelString: null };
}

/** Stores the check result in the library entry of an unmodified document. */
async function recordStatus(check: CheckState): Promise<void> {
  const { libraryId, dirty, doc } = state;
  if (!libraryId || dirty || !('signature' in check) || check.signature !== fixedSignature(doc)) return;
  const entry = await getEntry(libraryId);
  if (!entry) return;
  const status = currentStatus(state);
  if (entry.meta.status === status.status && entry.meta.levelString === status.levelString) return;
  await putEntry({ ...entry, meta: { ...entry.meta, ...status } });
  setState((s) => ({ libraryVersion: s.libraryVersion + 1 }));
}

/** Checks again with ten times the state cap (after the check gave up). */
export function retryWithLargerCap(): void {
  const cap = state.check.kind === 'done' && state.check.maxStates ? state.check.maxStates : defaultMaxStates();
  checker.run(fixedSignature(state.doc), toDoc(state.doc), cap * 10, true);
}

// --- Editing -----------------------------------------------------------------------------------

let stroke: { recorded: boolean } | null = null;

function pushPast(past: EDoc[], doc: EDoc): EDoc[] {
  const next = [...past, doc];
  return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
}

/**
 * Applies an edit to a copy of the document. An edit returning a string fails with that message and
 * changes nothing. Returns whether the document changed.
 */
export function editDoc(edit: (d: EDoc) => string | void, extra: Partial<State> = {}): boolean {
  const draft = cloneDoc(state.doc);
  const error = edit(draft);
  if (typeof error === 'string') {
    notify(error);
    return false;
  }
  if (docEquals(draft, state.doc)) {
    if (Object.keys(extra).length > 0) setState(extra);
    return false;
  }
  const record = !stroke || !stroke.recorded;
  if (stroke) stroke.recorded = true;
  setState((s) => ({
    doc: draft,
    past: record ? pushPast(s.past, s.doc) : s.past,
    future: record ? [] : s.future,
    dirty: true,
    ...extra,
  }));
  docChanged();
  return true;
}

/** Edits until `endStroke` make one undo step (a drag of the pencil, for instance). */
export function beginStroke(): void {
  stroke = { recorded: false };
}

export function endStroke(): void {
  stroke = null;
}

export function undo(): void {
  const { past, future, doc } = state;
  if (past.length === 0) return;
  setState({ doc: past[past.length - 1], past: past.slice(0, -1), future: [...future, doc], dirty: true, selection: new Set() });
  docChanged();
}

export function redo(): void {
  const { past, future, doc } = state;
  if (future.length === 0) return;
  setState({ doc: future[future.length - 1], future: future.slice(0, -1), past: pushPast(past, doc), dirty: true, selection: new Set() });
  docChanged();
}

// --- Documents ---------------------------------------------------------------------------------

export function confirmDiscard(): boolean {
  return !state.dirty || window.confirm('Discard the unsaved changes of the current puzzle?');
}

/** Opens a document in the editor, replacing the current one. */
export function openDoc(doc: PuzzleDoc, libraryId: string | null = null): void {
  checker.reset();
  analysisSignature = '';
  const d = fromDoc(doc);
  setState((s) => ({
    tab: 'editor',
    doc: d,
    libraryId,
    dirty: false,
    past: [],
    future: [],
    current: 0,
    paintedWith: [],
    selection: new Set(),
    viewModes: {},
    isolate: null,
    slice: Math.floor(d.grid[s.axis] / 2),
    check: { kind: 'idle' },
    analysis: null,
  }));
  docChanged();
}

/** Saves the document to the library (a new entry when it has none). */
export async function saveDoc(): Promise<void> {
  const now = new Date().toISOString();
  const doc = toDoc(state.doc);
  doc.meta.created ||= now;
  doc.meta.updated = now;
  const id = state.libraryId ?? newEntryId();
  const existing = state.libraryId ? await getEntry(id) : undefined;
  const meta: EntryMeta = {
    ...currentStatus(state),
    uniqueness: existing && uniquenessKey(existing.doc) === uniquenessKey(doc) ? existing.meta.uniqueness : null,
    created: existing?.meta.created ?? now,
    updated: now,
  };
  await putEntry({ id, name: doc.name, doc, thumbnail: renderThumbnail(doc), meta });
  setState((s) => ({
    libraryId: id,
    dirty: false,
    doc: { ...s.doc, meta: { ...doc.meta } },
    message: 'Saved to the library',
    libraryVersion: s.libraryVersion + 1,
  }));
}

/** Shows the disassembly of a document; solves it in a worker when no result is given. */
export async function viewDoc(doc: PuzzleDoc, result: SolveResult | null = null): Promise<void> {
  setState({ tab: 'viewer', viewer: { doc, result, loading: result === null, error: null } });
  if (result) return;
  try {
    const solved = await solveInWorker(doc);
    if (state.viewer?.doc === doc) setState({ viewer: { doc, result: solved, loading: false, error: null } });
  } catch (e) {
    if (state.viewer?.doc === doc) setState({ viewer: { doc, result: null, loading: false, error: errorMessage(e) } });
  }
}

/** The viewer for the document in the editor, reusing the live check when it is current. */
export function viewCurrent(): void {
  const doc = toDoc(state.doc);
  const check = state.check;
  const current = check.kind === 'done' && check.signature === fixedSignature(state.doc);
  void viewDoc(doc, current ? check.result : null);
}

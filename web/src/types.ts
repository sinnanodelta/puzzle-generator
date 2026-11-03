// JSON shapes shared with puzzle-core (SPEC §2.1, §3).

export type Vec3 = [number, number, number];

export interface DocPiece {
  id: string;
  name: string;
  color: string;
  notchable: boolean;
  fixed: Vec3[];
  optional: Vec3[];
}

export interface Target {
  required: Vec3[];
  variable: Vec3[];
}

export interface Meta {
  designer: string;
  source: string;
  created: string;
  updated: string;
}

export interface PuzzleDoc {
  format: 'puzzle-generator';
  version: 1;
  name: string;
  description: string;
  grid: Vec3;
  pieces: DocPiece[];
  target: Target | null;
  meta: Meta;
}

export type Dir = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** A translation of the pieces of the mask `pieces`; `dist` null is a separation. */
export interface Move {
  pieces: number;
  dir: Dir;
  dist: number | null;
}

export interface SolveNode {
  pieces: number;
  moves: Move[];
  removed: number;
  remaining: SolveNode | null;
  removed_tree: SolveNode | null;
}

export interface Solution {
  level: number;
  level_string: string;
  total_moves: number;
  tree: SolveNode;
}

export interface SolveResult {
  status: 'solved' | 'unsolvable' | 'aborted';
  states: number;
  solution: Solution | null;
}

export interface PieceAnalysis {
  notchable: boolean;
  millable: boolean;
  connected: boolean;
}

export interface Analysis {
  pieces: PieceAnalysis[];
  voxels: number;
  holes: number;
}

export interface KnownBurrInfo {
  key: string;
  name: string;
  designer: string | null;
  stickLength: number;
  levelString: string;
}

/** Settings of one generator run (SPEC §4.2), as the core reads them. */
export interface GeneratorOptions {
  seed: number;
  max_states: number;
  /** The search tunes the voxels removed and the restarts itself; `max_removed` and `restart_after` are then unused. */
  auto: boolean;
  max_removed: number;
  restart_after: number;
  keep: number;
  /** Fewer holes rank before a higher level: the search heads for puzzles that fill the target. */
  fill_target: boolean;
}

/** What the generator maximizes: the level, then the total moves. */
export interface Score {
  level: number;
  total_moves: number;
}

export interface GenEntry {
  /** `canonical_key`, in hexadecimal. */
  key: string;
  score: Score;
  level_string: string;
  /** Holes: required cells of the target that no piece fills; 0 without a target. */
  holes: number;
  document: PuzzleDoc;
}

export interface StepReport {
  /** Totals since the start of the run. */
  checks: number;
  aborted: number;
  passes: number;
  restarts: number;
  current: Score;
  best: Score | null;
  /** The best score without holes. */
  best_filled: Score | null;
  /** Leaderboard entries recorded since the previous report. */
  entries: GenEntry[];
}

/** The assemblies of a document's pieces into its target, each one solved (SPEC §5). */
export interface AssembleResult {
  /** 'aborted': the count stopped at the assembly cap, so the counts are lower bounds. */
  status: 'complete' | 'aborted';
  /** M: the distinct assemblies. */
  assemblies: number;
  /** N: the assemblies that come apart. */
  solutions: number;
  /** Assemblies whose solve reached the state cap: counted in M, not in N. */
  undecided: number;
  unique: boolean;
  /** The order of the rotation group of the target. */
  symmetryOrder: number;
  /** The first assembly that comes apart: the voxels of each piece, in target coordinates. */
  firstSolution: Vec3[][] | null;
  /**
   * Required cells of the target the pieces leave empty, and voxels outside the target. When either
   * is not 0 no assembly fills the target: the counts are for the pieces' own shape (SPEC §5).
   * Absent in results saved before they existed.
   */
  holes?: number;
  outside?: number;
}

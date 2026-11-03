// Types of library-index.js, for the app.
import type { AssembleResult, Vec3 } from '../src/types';

export const INDEX_FORMAT: 'puzzle-library';

/** An entry of the index: what the library shows of a puzzle, without its document. */
export interface IndexEntry {
  id: string;
  /** Changes with every write of the document, stored as library/docs/<id>/<rev>.json. */
  rev: string;
  name: string;
  /** '' is the root. */
  folder: string;
  status: 'solved' | 'unsolvable' | 'aborted' | 'invalid' | null;
  levelString: string | null;
  /** The total moves of the disassembly; null when unknown. */
  moves: number | null;
  uniqueness: Omit<AssembleResult, 'firstSolution'> | null;
  grid: Vec3;
  pieces: number;
  voxels: number;
  /** The fixed voxels of each piece, for the thumbnail and the rating (see `encodeShape`). */
  shape: string;
  designer: string;
  source: string;
  created: string;
  updated: string;
}

export interface LibraryIndex {
  format: typeof INDEX_FORMAT;
  version: 1;
  /** Every folder path, with its parents. */
  folders: string[];
  entries: IndexEntry[];
}

/** A change of the library. A `put` without a folder keeps the entry where it is (the root when new). */
export type LibraryOp =
  | { op: 'put'; entry: Omit<IndexEntry, 'rev' | 'folder'> & { folder?: string } }
  | { op: 'meta'; id: string; patch: Partial<Pick<IndexEntry, 'status' | 'levelString' | 'moves' | 'uniqueness'>> }
  | { op: 'move'; ids: string[]; folder: string }
  | { op: 'delete'; ids: string[] }
  | { op: 'addFolder'; path: string }
  | { op: 'moveFolder'; from: string; to: string }
  /** Deletes the folder, its subfolders and the entries `ids` in them. */
  | { op: 'deleteFolder'; path: string; ids: string[] };

export function emptyIndex(): LibraryIndex;
export function isId(value: unknown): value is string;
export function normalizeFolder(path: string): string;
export function isWithin(path: string, folder: string): boolean;
export function parentFolder(path: string): string;
export function folderName(path: string): string;
export function checkOps(ops: unknown): string | null;
export function applyOps(
  index: LibraryIndex,
  ops: LibraryOp[],
  revs: Record<string, string>,
): { index: LibraryIndex; removed: { id: string; rev: string }[] };

// The puzzle library (SPEC §2.2): documents with a thumbnail and cached results, in IndexedDB.
import type { AssembleResult, PuzzleDoc, Vec3 } from '../types';

/** A uniqueness result (SPEC §5) without its first solution. */
export type Uniqueness = Omit<AssembleResult, 'firstSolution'>;

export function uniquenessOf(result: AssembleResult): Uniqueness {
  const { status, assemblies, solutions, undecided, unique, symmetryOrder } = result;
  return { status, assemblies, solutions, undecided, unique, symmetryOrder };
}

/** What the uniqueness of a document depends on: the fixed voxels of its pieces and its target. */
export function uniquenessKey(doc: PuzzleDoc): string {
  const cells = (voxels: Vec3[]) => voxels.map((v) => v.join(',')).sort().join(' ');
  return JSON.stringify([doc.pieces.map((p) => cells(p.fixed)), doc.target && [cells(doc.target.required), cells(doc.target.variable)]]);
}

export interface EntryMeta {
  levelString: string | null;
  status: 'solved' | 'unsolvable' | 'aborted' | 'invalid' | null;
  /** The uniqueness check of the generator (SPEC §4.4); null when it did not run. */
  uniqueness: Uniqueness | null;
  created: string;
  updated: string;
}

export interface LibraryEntry {
  id: string;
  name: string;
  doc: PuzzleDoc;
  thumbnail: string;
  meta: EntryMeta;
}

const DB_NAME = 'puzzle-generator';
const STORE = 'entries';

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

async function run<T>(mode: IDBTransactionMode, f: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const store = (await open()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const request = f(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Every entry, most recently updated first. */
export async function listEntries(): Promise<LibraryEntry[]> {
  const all = await run<LibraryEntry[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.meta.updated.localeCompare(a.meta.updated));
}

export function getEntry(id: string): Promise<LibraryEntry | undefined> {
  return run<LibraryEntry | undefined>('readonly', (s) => s.get(id));
}

export async function putEntry(entry: LibraryEntry): Promise<void> {
  await run('readwrite', (s) => s.put(entry));
}

export async function deleteEntry(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

export function newEntryId(): string {
  return crypto.randomUUID();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return name.replace(/[\/:*?"<>|]+/g, '_').trim() || 'puzzle';
}

export function downloadDoc(doc: PuzzleDoc): void {
  const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
  downloadBlob(blob, `${safeFilename(doc.name)}.json`);
}

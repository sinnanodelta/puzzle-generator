// The generator run kept in IndexedDB (SPEC §4.3), so that a run survives the page being reloaded:
// a mobile browser discards a page in the background and reloads it on return. Two records: the
// counters and settings, saved every few seconds, and the leaderboard with its uniqueness checks,
// saved with them when they changed.
import type { GenRun, GenSettings } from '../store';

const DB_NAME = 'puzzle-generator-run';
const STORE = 'run';

/** The run without its leaderboard; `running` is whether it was running when saved. */
export type RunMeta = Omit<GenRun, 'board' | 'uniqueness' | 'saved'> & {
  /** The settings form, kept between runs. */
  form: GenSettings;
};

export type RunBoard = Pick<GenRun, 'board' | 'uniqueness' | 'saved'> & {
  /** The library entries saved from the leaderboard, by entry key. */
  savedIds: [string, string][];
};

let db: Promise<IDBDatabase> | null = null;
let opened: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve((opened = request.result));
    request.onerror = () => reject(request.error);
  });
  return db;
}

async function request<T>(mode: IDBTransactionMode, f: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const store = (await open()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const r = f(store);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadRun(): Promise<{ meta: RunMeta; board: RunBoard } | null> {
  const [meta, board] = await Promise.all([
    request<RunMeta | undefined>('readonly', (s) => s.get('meta')),
    request<RunBoard | undefined>('readonly', (s) => s.get('board')),
  ]);
  return meta && board ? { meta, board } : null;
}

/**
 * Saves the run, with its leaderboard unless null, in one transaction. Once the database is open,
 * the transaction starts before this returns, so a save from `pagehide` is under way before the
 * page goes; transactions complete in the order they start.
 */
export function saveRun(meta: RunMeta, board: RunBoard | null): Promise<void> {
  const write = (d: IDBDatabase) =>
    new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      if (board) store.put(board, 'board');
      store.put(meta, 'meta');
      // Commits now rather than at the end of the task, which a page being unloaded may not reach.
      t.commit?.();
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
  return opened ? write(opened) : open().then(write);
}

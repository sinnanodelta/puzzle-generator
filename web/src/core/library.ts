// The puzzle library (SPEC §2.2). The shared library is on the server (api/library.js, in Vercel
// Blob): its index comes in one small request, a document only when it is opened, and both are kept
// in IndexedDB, so the library opens offline (read-only). Without the server (`npm run dev`, another
// host) the library of this device is used instead; it also keeps what could not be saved to the
// shared library (offline, no password) until it is uploaded. Thumbnails and ratings are computed
// here, from the voxels of the index.
import { applyOps, emptyIndex, type IndexEntry, type LibraryIndex, type LibraryOp } from '../../shared/library-index.js';
import type { AssembleResult, PuzzleDoc, Vec3 } from '../types';
import { type Rating, rate } from './rating';
import { renderThumbnail } from './thumbnail';

export type { IndexEntry, LibraryIndex, LibraryOp };
export { folderName, isWithin, normalizeFolder, parentFolder } from '../../shared/library-index.js';

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
  /** The total moves of the disassembly; absent or null when unknown. */
  moves?: number | null;
  /** The uniqueness check of the generator (SPEC §4.4); null when it did not run. */
  uniqueness: Uniqueness | null;
  created: string;
  updated: string;
}

/** A puzzle as the editor and the generator save it. */
export interface LibraryEntry {
  id: string;
  name: string;
  doc: PuzzleDoc;
  /** A thumbnail already drawn, kept instead of drawing it again. */
  thumbnail?: string;
  meta: EntryMeta;
}

/** The shared library, or the library of this device. */
export type Scope = 'shared' | 'local';

/**
 * loading: before the first answer of the server. shared: the server answers. offline: the server
 * did not answer; the shared library is the copy of the last visit, read-only. local: there is no
 * shared library here, only the library of this device.
 */
export type Mode = 'loading' | 'shared' | 'offline' | 'local';

export interface LibraryState {
  mode: Mode;
  /** Why the shared library is not used or not current. */
  notice: string | null;
  /** The shared index (the copy of the last visit when offline); null when there is none. */
  shared: LibraryIndex | null;
  /** When the copy of the shared index was fetched. */
  sharedAt: string | null;
  local: LibraryIndex;
  /** The library shown and its folder; new puzzles go to this folder. */
  scope: Scope;
  folder: string;
  /** The password of the shared library is stored on this device. */
  unlocked: boolean;
  /** Writes to the shared library in progress. */
  saving: number;
  /** The message of the password dialog while it is open. */
  passwordRequest: string | null;
}

const API = '/api/library';
const API_TIMEOUT = 15_000;
const PASSWORD_KEY = 'puzzle-generator.library-password';
const PLACE_KEY = 'puzzle-generator.library-place';
/** The largest request body: the limit of Vercel Functions is 4.5 MB. */
const MAX_REQUEST = 3_000_000;
/** The server takes at most 1000 operations per request. */
const MAX_OPS = 500;

export function newEntryId(): string {
  return crypto.randomUUID();
}

function newRev(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function load<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function storedPassword(): string | null {
  try {
    return localStorage.getItem(PASSWORD_KEY);
  } catch {
    return null;
  }
}

function timedOut(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

const timeoutNotice = `The shared library request timed out after ${API_TIMEOUT / 1000} seconds`;

// --- State ---------------------------------------------------------------------------------------

const place = load<{ scope: Scope; folder: string }>(PLACE_KEY);

let state: LibraryState = {
  mode: 'loading',
  notice: null,
  shared: null,
  sharedAt: null,
  local: emptyIndex(),
  scope: place?.scope === 'local' ? 'local' : 'shared',
  folder: typeof place?.folder === 'string' ? place.folder : '',
  unlocked: storedPassword() !== null,
  saving: 0,
  passwordRequest: null,
};
/** The ETag of the shared index. */
let etag: string | null = null;
/** Bumped by every change of the shared index, so a slower fetch does not undo a write. */
let sharedVersion = 0;

const listeners = new Set<() => void>();

export function getLibrary(): LibraryState {
  return state;
}

export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(patch: Partial<LibraryState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** The scope shown: the local one when there is no shared library. */
export function shownScope(s: LibraryState): Scope {
  return s.mode === 'local' || s.shared === null ? 'local' : s.scope;
}

export function indexOf(s: LibraryState, scope: Scope): LibraryIndex {
  return (scope === 'shared' ? s.shared : s.local) ?? emptyIndex();
}

export function canEdit(s: LibraryState, scope: Scope): boolean {
  return scope === 'local' || s.mode === 'shared';
}

export function openFolder(scope: Scope, folder: string): void {
  set({ scope, folder });
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify({ scope, folder }));
  } catch {
    // Not kept.
  }
}

function findEntry(scope: Scope, id: string): IndexEntry | undefined {
  return indexOf(state, scope).entries.find((e) => e.id === id);
}

// --- IndexedDB -----------------------------------------------------------------------------------

const DB_NAME = 'puzzle-generator';
/** The library before the shared one (version 1): read once, into the local library. */
const LEGACY = 'entries';
/** 'local': the local index; 'shared': the copy of the shared index, its ETag and its date. */
const STATE = 'state';
/** `${scope}/${id}` → the document of a revision. */
const DOCS = 'docs';
/** Revision → thumbnail (PNG data URL). */
const THUMBS = 'thumbs';

interface CachedDoc {
  rev: string;
  doc: PuzzleDoc;
}

interface SharedCopy {
  index: LibraryIndex;
  etag: string | null;
  fetched: string;
}

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains(LEGACY)) d.createObjectStore(LEGACY, { keyPath: 'id' });
      for (const name of [STATE, DOCS, THUMBS]) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
    };
    request.onsuccess = () => {
      const d = request.result;
      // A newer version of the app in another tab upgrades the database.
      d.onversionchange = () => d.close();
      resolve(d);
    };
    request.onblocked = () => reject(new Error('The library database is being upgraded in another tab. Close other app tabs and reload.'));
    request.onerror = () => reject(request.error);
  });
  return db;
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const s = (await open()).transaction(store, 'readonly').objectStore(store);
  return new Promise((resolve, reject) => {
    const request = s.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Runs writes in one transaction; resolves once it is committed. */
async function idbWrite(stores: string[], f: (t: IDBTransaction) => void): Promise<void> {
  const t = (await open()).transaction(stores, 'readwrite');
  f(t);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Cache writes: a failure only costs a download later. */
function cache(f: (t: IDBTransaction) => void, stores = [DOCS, THUMBS]): void {
  idbWrite(stores, f).catch((e) => console.warn('library cache:', e));
}

interface LegacyEntry {
  id: string;
  name: string;
  doc: PuzzleDoc;
  thumbnail: string;
  meta: EntryMeta;
}

async function idbKeys(store: string): Promise<IDBValidKey[]> {
  const s = (await open()).transaction(store, 'readonly').objectStore(store);
  return new Promise((resolve, reject) => {
    const request = s.getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Builds the local library from the library of version 1, once. */
async function migrate(): Promise<LibraryIndex> {
  const s = (await open()).transaction(LEGACY, 'readonly').objectStore(LEGACY);
  const all = await new Promise<LegacyEntry[]>((resolve, reject) => {
    const request = s.getAll();
    request.onsuccess = () => resolve(request.result as LegacyEntry[]);
    request.onerror = () => reject(request.error);
  });
  const revs: Record<string, string> = {};
  const ops: LibraryOp[] = all.map((e) => {
    revs[e.id] = newRev();
    return { op: 'put', entry: { ...indexFields(e), folder: '' } };
  });
  const { index } = applyOps(emptyIndex(), ops, revs);
  await idbWrite([STATE, DOCS, THUMBS], (t) => {
    for (const e of all) {
      t.objectStore(DOCS).put({ rev: revs[e.id], doc: e.doc } satisfies CachedDoc, `local/${e.id}`);
      if (e.thumbnail) t.objectStore(THUMBS).put(e.thumbnail, revs[e.id]);
    }
    t.objectStore(STATE).put(index, 'local');
  });
  return index;
}

// --- Entries, shapes and ratings -------------------------------------------------------------------

const B32 = '0123456789abcdefghijklmnopqrstuv';

/**
 * The fixed voxels of each piece, for thumbnails and ratings without the document: per piece, its
 * colour then three base-32 digits per voxel, from the corner of the bounding box; pieces are
 * separated by commas.
 */
export function encodeShape(doc: PuzzleDoc): string {
  const min = [Infinity, Infinity, Infinity];
  for (const p of doc.pieces) for (const v of p.fixed) for (let a = 0; a < 3; a++) min[a] = Math.min(min[a], v[a]);
  return doc.pieces
    .map((p) => {
      const color = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toLowerCase() : '#999999';
      return color + p.fixed.map((v) => B32[v[0] - min[0]] + B32[v[1] - min[1]] + B32[v[2] - min[2]]).join('');
    })
    .join(',');
}

/** A document with the pieces of an index entry: their colours and fixed voxels. */
export function shapeDoc(entry: IndexEntry): PuzzleDoc {
  const pieces = entry.shape
    ? entry.shape.split(',').map((part, i) => {
        const fixed: Vec3[] = [];
        for (let k = 7; k + 3 <= part.length; k += 3) fixed.push([B32.indexOf(part[k]), B32.indexOf(part[k + 1]), B32.indexOf(part[k + 2])]);
        return { id: `p${i}`, name: '', color: part.slice(0, 7), notchable: false, fixed, optional: [] };
      })
    : [];
  return {
    format: 'puzzle-generator',
    version: 1,
    name: entry.name,
    description: '',
    grid: entry.grid,
    pieces,
    target: null,
    meta: { designer: entry.designer, source: entry.source, created: entry.created, updated: entry.updated },
  };
}

const ratings = new Map<string, Rating>();

/** The rating of the generator (SPEC §4.4), from the voxels of the index. */
export function entryRating(entry: IndexEntry): Rating {
  let r = ratings.get(entry.rev);
  if (!r) {
    r = rate(`library:${entry.rev}`, shapeDoc(entry));
    ratings.set(entry.rev, r);
  }
  return r;
}

function indexFields(e: LibraryEntry): Omit<IndexEntry, 'rev' | 'folder'> {
  const doc = e.doc;
  return {
    id: e.id,
    name: e.name,
    status: e.meta.status,
    levelString: e.meta.levelString,
    moves: e.meta.moves ?? null,
    uniqueness: e.meta.uniqueness,
    grid: doc.grid,
    pieces: doc.pieces.length,
    voxels: doc.pieces.reduce((n, p) => n + p.fixed.length, 0),
    shape: encodeShape(doc),
    designer: doc.meta?.designer ?? '',
    source: doc.meta?.source ?? '',
    created: e.meta.created,
    updated: e.meta.updated,
  };
}

function toLibraryEntry(e: IndexEntry, doc: PuzzleDoc): LibraryEntry {
  const { levelString, status, moves, uniqueness, created, updated } = e;
  return { id: e.id, name: e.name, doc, meta: { levelString, status, moves, uniqueness, created, updated } };
}

// --- Loading -------------------------------------------------------------------------------------

let loading: Promise<void> | null = null;

/** Loads the library of this device and the copy of the shared index, then asks the server. */
export function loadLibrary(): Promise<void> {
  loading ??= (async () => {
    try {
      const local = (await idbGet<LibraryIndex>(STATE, 'local')) ?? (await migrate());
      const copy = await idbGet<SharedCopy>(STATE, 'shared');
      if (copy) etag = copy.etag;
      set({ local, shared: copy?.index ?? null, sharedAt: copy?.fetched ?? null });
    } catch (e) {
      console.warn('library: no local storage', e);
    }
    await refreshLibrary();
  })();
  return loading;
}

/** Loads the library the first time, then checks the server for changes. */
export function syncLibrary(): Promise<void> {
  return loading ? refreshLibrary() : loadLibrary();
}

function setShared(index: LibraryIndex, newEtag: string | null): void {
  sharedVersion++;
  etag = newEtag;
  const fetched = new Date().toISOString();
  set({ shared: index, sharedAt: fetched });
  cache((t) => t.objectStore(STATE).put({ index, etag, fetched } satisfies SharedCopy, 'shared'), [STATE]);
  prune();
}

let refreshing: Promise<void> | null = null;

/** Fetches the shared index if it changed. Never fails: the mode tells what happened. */
export function refreshLibrary(): Promise<void> {
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refresh(): Promise<void> {
  const version = sharedVersion;
  // Another tab may have changed the library of this device.
  const local = await idbGet<LibraryIndex>(STATE, 'local').catch(() => undefined);
  if (local) set({ local });
  let res: Response;
  try {
    res = await fetch(etag ? `${API}?since=${encodeURIComponent(etag)}` : API, {
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
  } catch (e) {
    goOffline(timedOut(e) ? timeoutNotice : undefined);
    return;
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  let body: { etag: string | null; index?: LibraryIndex; unchanged?: boolean; error?: string } | null;
  try {
    body = isJson ? ((await res.json()) as typeof body) : null;
  } catch (e) {
    if (timedOut(e)) {
      goOffline(timeoutNotice);
      return;
    }
    body = null;
  }
  if (!body || res.status === 404 || res.status === 503) {
    // A host without the API (the dev server answers with the page), or one not set up.
    set({
      mode: 'local',
      notice: body?.error ?? 'There is no shared library here (no /api/library): the library is kept in this browser only.',
    });
    return;
  }
  if (!res.ok) {
    goOffline(body.error ?? `the server answered ${res.status}`);
    return;
  }
  if (body.index && version === sharedVersion) setShared(body.index, body.etag);
  else if (body.unchanged) set({ sharedAt: new Date().toISOString() });
  set({ mode: 'shared', notice: null });
}

function goOffline(error?: string): void {
  if (state.shared) {
    const when = state.sharedAt ? new Date(state.sharedAt).toLocaleString() : 'the last visit';
    set({ mode: 'offline', notice: `${error ? `The shared library failed: ${error}.` : 'Offline.'} The shared library is shown as of ${when}, read-only.` });
  } else {
    set({ mode: 'local', notice: `${error ? `The shared library failed: ${error}.` : 'Offline.'} Only the library of this browser is available.` });
  }
}

// --- Password ------------------------------------------------------------------------------------

let answer: ((password: string | null) => void) | null = null;
let asking: Promise<string | null> | null = null;

/** Opens the password dialog (rendered by PasswordDialog); null when cancelled. */
function askPassword(message: string): Promise<string | null> {
  asking ??= new Promise<string | null>((resolve) => {
    answer = resolve;
    set({ passwordRequest: message });
  }).finally(() => {
    asking = null;
  });
  return asking;
}

export function answerPassword(password: string | null): void {
  const a = answer;
  answer = null;
  set({ passwordRequest: null });
  a?.(password);
}

/** Forgets the password on this device. */
export function lock(): void {
  try {
    localStorage.removeItem(PASSWORD_KEY);
  } catch {
    // Nothing kept.
  }
  set({ unlocked: false });
}

/** Asks for the password and checks it with the server; returns whether it is right. */
export async function unlock(): Promise<boolean> {
  try {
    await post([], {});
    return true;
  } catch (e) {
    if (e instanceof LibraryError && e.kind === 'password') return false;
    throw e;
  }
}

/** A write to the shared library that did not happen: no password, offline. */
export class LibraryError extends Error {
  constructor(
    message: string,
    readonly kind: 'password' | 'offline',
  ) {
    super(message);
  }
}

interface WriteAnswer {
  etag: string | null;
  revs: Record<string, string>;
  index?: LibraryIndex;
}

let queue: Promise<unknown> = Promise.resolve();

/** Sends operations to the server, one request at a time; asks for the password when needed. */
function post(ops: LibraryOp[], docs: Record<string, PuzzleDoc>): Promise<WriteAnswer> {
  const run = async (): Promise<WriteAnswer> => {
    let message = 'Changing the shared library needs its password.';
    for (;;) {
      const stored = storedPassword();
      const password = stored ?? (await askPassword(message));
      if (password === null) throw new LibraryError('The shared library needs its password', 'password');
      // When the server applies the operations to this index, it does not send the result back.
      const [base, baseIndex] = [etag, state.shared ?? emptyIndex()];
      let res: Response;
      try {
        res = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${encodeURIComponent(password)}` },
          body: JSON.stringify({ base, ops, docs }),
          signal: AbortSignal.timeout(API_TIMEOUT),
        });
      } catch (e) {
        const message = timedOut(e) ? timeoutNotice : 'Offline: the shared library cannot be changed';
        goOffline(message);
        throw new LibraryError(message, 'offline');
      }
      if (res.status === 401) {
        if (stored !== null) lock();
        message = 'Wrong password. Try again:';
        continue;
      }
      let body: (WriteAnswer & { error?: string }) | null;
      try {
        body = (await res.json()) as typeof body;
      } catch (e) {
        if (timedOut(e)) {
          goOffline(timeoutNotice);
          throw new LibraryError(timeoutNotice, 'offline');
        }
        body = null;
      }
      // Not set up for changes (no LIBRARY_PASSWORD): saves stay on this device.
      if (res.status === 503) throw new LibraryError(body?.error ?? 'The shared library cannot be changed', 'offline');
      if (!res.ok || !body) throw new Error(body?.error ?? `the server answered ${res.status}`);
      if (stored === null) {
        try {
          localStorage.setItem(PASSWORD_KEY, password);
        } catch {
          // Asked again next time.
        }
        set({ unlocked: true });
      }
      if (ops.length > 0) setShared(body.index ?? applyOps(baseIndex, ops, body.revs).index, body.etag);
      return body;
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  set({ saving: state.saving + 1 });
  return result.finally(() => set({ saving: state.saving - 1 }));
}

// --- Writes --------------------------------------------------------------------------------------

/**
 * Applies operations to a library. `docs` are the documents of the entries put, `thumbs` their
 * thumbnails when already drawn (by entry id). Large uploads to the shared library are split into
 * several requests.
 */
async function write(scope: Scope, ops: LibraryOp[], docs: Record<string, PuzzleDoc> = {}, thumbs: Record<string, string> = {}): Promise<void> {
  let revs: Record<string, string> = {};
  if (scope === 'local') {
    for (const id of Object.keys(docs)) revs[id] = newRev();
    // Read and written in one transaction: another tab may change it too.
    let index = state.local;
    await idbWrite([STATE, DOCS], (t) => {
      const request = t.objectStore(STATE).get('local');
      request.onsuccess = () => {
        const result = applyOps((request.result as LibraryIndex | undefined) ?? emptyIndex(), ops, revs);
        index = result.index;
        for (const r of result.removed) if (!(r.id in revs)) t.objectStore(DOCS).delete(`local/${r.id}`);
        for (const [id, doc] of Object.entries(docs)) t.objectStore(DOCS).put({ rev: revs[id], doc } satisfies CachedDoc, `local/${id}`);
        t.objectStore(STATE).put(index, 'local');
      };
    });
    set({ local: index });
    prune();
  } else {
    if (state.mode !== 'shared') throw new LibraryError('Offline: the shared library cannot be changed', 'offline');
    let chunk: LibraryOp[] = [];
    let chunkDocs: Record<string, PuzzleDoc> = {};
    let size = 0;
    const flush = async () => {
      if (chunk.length === 0) return;
      revs = { ...revs, ...(await post(chunk, chunkDocs)).revs };
      [chunk, chunkDocs, size] = [[], {}, 0];
    };
    for (const op of ops) {
      const doc = op.op === 'put' ? docs[op.entry.id] : undefined;
      const bytes = JSON.stringify(op).length + (doc ? JSON.stringify(doc).length : 0);
      if (size + bytes > MAX_REQUEST || chunk.length >= MAX_OPS) await flush();
      chunk.push(op);
      if (doc && op.op === 'put') chunkDocs[op.entry.id] = doc;
      size += bytes;
    }
    await flush();
    cache((t) => {
      for (const [id, doc] of Object.entries(docs)) if (revs[id]) t.objectStore(DOCS).put({ rev: revs[id], doc } satisfies CachedDoc, `shared/${id}`);
    });
  }
  for (const [id, url] of Object.entries(thumbs)) {
    if (!revs[id] || !url) continue;
    memoryThumbs.set(revs[id], url);
    cache((t) => t.objectStore(THUMBS).put(url, revs[id]), [THUMBS]);
  }
}

/** Changes a library: moves, deletions, folders. */
export function changeLibrary(scope: Scope, ops: LibraryOp[]): Promise<void> {
  return write(scope, ops);
}

/** Adds new puzzles to a folder of a library. */
export function addEntries(scope: Scope, entries: LibraryEntry[], folder: string): Promise<void> {
  const ops: LibraryOp[] = entries.map((e) => ({ op: 'put', entry: { ...indexFields(e), folder } }));
  const docs = Object.fromEntries(entries.map((e) => [e.id, e.doc]));
  const thumbs = Object.fromEntries(entries.flatMap((e) => (e.thumbnail ? [[e.id, e.thumbnail]] : [])));
  return write(scope, ops, docs, thumbs);
}

/** Renames a puzzle, in its document too. */
export async function renameEntry(scope: Scope, entry: IndexEntry, name: string): Promise<void> {
  const doc = await loadDoc(scope, entry);
  const updated = new Date().toISOString();
  const e = toLibraryEntry({ ...entry, name, updated }, { ...doc, name, meta: { ...doc.meta, updated } });
  const thumb = memoryThumbs.get(entry.rev);
  await write(scope, [{ op: 'put', entry: indexFields(e) }], { [e.id]: e.doc }, thumb ? { [e.id]: thumb } : {});
}

/**
 * Moves puzzles of this device to the shared library, with their folders (every puzzle when `ids`
 * is null). Returns how many were moved.
 */
export async function uploadLocal(ids: string[] | null): Promise<number> {
  const local = state.local;
  const entries = local.entries.filter((e) => ids === null || ids.includes(e.id));
  const docs: Record<string, PuzzleDoc> = {};
  for (const e of entries) docs[e.id] = await loadDoc('local', e);
  const all = ids === null;
  const thumbs: Record<string, string> = {};
  for (const e of entries) {
    const url = memoryThumbs.get(e.rev) ?? (await idbGet<string>(THUMBS, e.rev).catch(() => undefined));
    if (url) thumbs[e.id] = url;
  }
  // The entries keep their folder (the extra `rev` is ignored).
  await write('shared', [...(all ? local.folders.map((path): LibraryOp => ({ op: 'addFolder', path })) : []), ...entries.map((entry): LibraryOp => ({ op: 'put', entry }))], docs, thumbs);
  const gone: LibraryOp = { op: 'delete', ids: entries.map((e) => e.id) };
  await write('local', all ? [gone, ...local.folders.map((path): LibraryOp => ({ op: 'deleteFolder', path, ids: [] }))] : [gone]);
  if (state.local.entries.length === 0 && state.local.folders.length === 0) openFolder('shared', state.folder);
  return entries.length;
}

// --- Documents -----------------------------------------------------------------------------------

/** The document of an entry: from the cache, else from the server. */
export async function loadDoc(scope: Scope, entry: IndexEntry): Promise<PuzzleDoc> {
  const key = `${scope}/${entry.id}`;
  const cached = await idbGet<CachedDoc>(DOCS, key).catch(() => undefined);
  if (cached?.rev === entry.rev) return cached.doc;
  if (scope === 'local') throw new Error(`The document of “${entry.name}” is missing from this browser`);
  let res: Response;
  try {
    res = await fetch(`${API}?doc=${encodeURIComponent(entry.id)}&rev=${encodeURIComponent(entry.rev)}`);
  } catch {
    throw new Error(`Offline: “${entry.name}” was not opened on this device before, so it is not available offline`);
  }
  if (res.status === 404) {
    // Changed or deleted by another device since the index was fetched.
    await refreshLibrary();
    const now = findEntry('shared', entry.id);
    if (now && now.rev !== entry.rev) return loadDoc('shared', now);
    throw new Error(`“${entry.name}” is no longer in the shared library`);
  }
  if (!res.ok) throw new Error(`Could not load “${entry.name}”: the server answered ${res.status}`);
  const doc = (await res.json()) as PuzzleDoc;
  cache((t) => t.objectStore(DOCS).put({ rev: entry.rev, doc } satisfies CachedDoc, key), [DOCS]);
  return doc;
}

/** The library entry `id` with its document: from this device first, which holds the unsent changes. */
export async function getEntry(id: string): Promise<LibraryEntry | undefined> {
  await loadLibrary();
  for (const scope of ['local', 'shared'] as Scope[]) {
    const e = findEntry(scope, id);
    if (e) return toLibraryEntry(e, await loadDoc(scope, e));
  }
  return undefined;
}

const sameDoc = (a: PuzzleDoc, b: PuzzleDoc) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Saves a puzzle: to the shared library when it answers, else (offline, no password) to this
 * device. A puzzle of this device saved to the shared library leaves this device. When only its
 * results changed (the status of the editor's check, the uniqueness of the generator), only the index
 * is written, and nothing is asked: without the password or offline, the results are not kept.
 * Returns where the puzzle is.
 */
export async function putEntry(entry: LibraryEntry): Promise<Scope> {
  await loadLibrary();
  for (const scope of ['local', 'shared'] as Scope[]) {
    const old = findEntry(scope, entry.id);
    if (!old || old.name !== entry.name) continue;
    const cached = await idbGet<CachedDoc>(DOCS, `${scope}/${entry.id}`).catch(() => undefined);
    if (cached?.rev !== old.rev || !sameDoc(cached.doc, entry.doc)) continue;
    const patch = { status: entry.meta.status, levelString: entry.meta.levelString, moves: entry.meta.moves ?? old.moves, uniqueness: entry.meta.uniqueness };
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => JSON.stringify(patch[k]) !== JSON.stringify(old[k]));
    if (changed && (scope === 'local' || (state.mode === 'shared' && state.unlocked))) {
      await write(scope, [{ op: 'meta', id: entry.id, patch }]).catch((e) => console.warn('library: results not saved', e));
    }
    return scope;
  }
  const pending = findEntry('local', entry.id);
  const save = (scope: Scope) => {
    // A new puzzle goes to the folder shown; a known one stays in its folder.
    const known = findEntry(scope, entry.id) ?? findEntry(scope === 'local' ? 'shared' : 'local', entry.id);
    const folder = findEntry(scope, entry.id) ? undefined : (known?.folder ?? state.folder);
    const thumbs = entry.thumbnail ? { [entry.id]: entry.thumbnail } : {};
    return write(scope, [{ op: 'put', entry: { ...indexFields(entry), ...(folder === undefined ? {} : { folder }) } }], { [entry.id]: entry.doc }, thumbs);
  };
  if (state.mode === 'shared') {
    try {
      await save('shared');
      if (pending) await write('local', [{ op: 'delete', ids: [entry.id] }]);
      return 'shared';
    } catch (e) {
      if (!(e instanceof LibraryError)) throw e;
    }
  }
  await save('local');
  return 'local';
}

/** The message after a save to `scope`. */
export function savedMessage(scope: Scope, name?: string): string {
  const what = name ? ` “${name}”` : '';
  if (scope === 'shared') return `Saved${what} to the shared library`;
  if (state.mode === 'local') return `Saved${what} to the library`;
  return `Saved${what} on this device only (${state.mode === 'offline' ? 'offline' : 'no password'}); upload it from the Library`;
}

// --- Thumbnails ----------------------------------------------------------------------------------

const memoryThumbs = new Map<string, string>();
const drawQueue: { entry: IndexEntry; resolve: (url: string) => void }[] = [];
let drawing = false;

/** The thumbnail of an entry if it is at hand. */
export function thumbnailNow(entry: IndexEntry): string | undefined {
  return memoryThumbs.get(entry.rev);
}

/** The thumbnail of an entry: from memory, the cache, or drawn from the index (a few per frame). */
export async function thumbnail(entry: IndexEntry): Promise<string> {
  const hit = memoryThumbs.get(entry.rev) ?? (await idbGet<string>(THUMBS, entry.rev).catch(() => undefined));
  if (hit) {
    memoryThumbs.set(entry.rev, hit);
    return hit;
  }
  return new Promise((resolve) => {
    drawQueue.push({ entry, resolve });
    if (!drawing) {
      drawing = true;
      setTimeout(draw, 0);
    }
  });
}

function draw(): void {
  const end = performance.now() + 12;
  while (drawQueue.length > 0 && performance.now() < end) {
    const { entry, resolve } = drawQueue.shift()!;
    let url = memoryThumbs.get(entry.rev);
    if (!url) {
      url = renderThumbnail(shapeDoc(entry));
      memoryThumbs.set(entry.rev, url);
      const [rev, png] = [entry.rev, url];
      cache((t) => t.objectStore(THUMBS).put(png, rev), [THUMBS]);
    }
    resolve(url);
  }
  if (drawQueue.length > 0) setTimeout(draw, 0);
  else drawing = false;
}

let pruneTimer: ReturnType<typeof setTimeout> | undefined;

/** Deletes cached documents and thumbnails of revisions no index refers to, a little later. */
function prune(): void {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(async () => {
    try {
      // The local index as stored: another tab may have added entries.
      const local = (await idbGet<LibraryIndex>(STATE, 'local')) ?? state.local;
      const keep = new Set<string>();
      const revs = new Set<string>();
      for (const [scope, index] of [['shared', state.shared ?? emptyIndex()], ['local', local]] as const) {
        for (const e of index.entries) {
          keep.add(`${scope}/${e.id}`);
          revs.add(e.rev);
        }
      }
      const docs = (await idbKeys(DOCS)).filter((k) => !keep.has(String(k)));
      const thumbs = (await idbKeys(THUMBS)).filter((k) => !revs.has(String(k)));
      if (docs.length + thumbs.length === 0) return;
      cache((t) => {
        for (const k of docs) t.objectStore(DOCS).delete(k);
        for (const k of thumbs) t.objectStore(THUMBS).delete(k);
      });
    } catch (e) {
      console.warn('library prune:', e);
    }
  }, 2000);
}

// --- Files ---------------------------------------------------------------------------------------

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

// The library index (SPEC §2.2) and the operations that change it. Plain JavaScript, shared by the
// API function (api/library.js, through server/library.js) and the app (src/core/library.ts), which
// applies the same operations to the library of the device and to its copy of the shared index.
// Types: library-index.d.ts.

export const INDEX_FORMAT = 'puzzle-library';

/** Ids and revisions: also parts of blob pathnames. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OPS = 1000;

/** The fields of an index entry that a `put` sets; `rev` is set by whoever stores the document. */
const ENTRY_FIELDS = ['id', 'name', 'folder', 'status', 'levelString', 'moves', 'uniqueness', 'grid', 'pieces', 'voxels', 'shape', 'designer', 'source', 'created', 'updated'];
/** The fields a `meta` operation may change: the cached results, not the document. */
const META_FIELDS = ['status', 'levelString', 'moves', 'uniqueness'];

export function emptyIndex() {
  return { format: INDEX_FORMAT, version: 1, folders: [], entries: [] };
}

export function isId(value) {
  return typeof value === 'string' && ID.test(value);
}

/** A folder path: names separated by '/', trimmed, without empty names; '' is the root. */
export function normalizeFolder(path) {
  if (typeof path !== 'string') return '';
  return path
    .split('/')
    .map((name) => name.replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 12)
    .join('/');
}

/** Whether `path` is `folder` or inside it; everything is inside the root. */
export function isWithin(path, folder) {
  return folder === '' || path === folder || path.startsWith(folder + '/');
}

export function parentFolder(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function folderName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function pick(object, fields) {
  const out = {};
  for (const f of fields) if (object[f] !== undefined) out[f] = object[f];
  return out;
}

const isIds = (ids) => Array.isArray(ids) && ids.length <= 10000 && ids.every(isId);

/** Checks the shape of a list of operations; returns an error message, or null when they are valid. */
export function checkOps(ops) {
  if (!Array.isArray(ops)) return 'ops must be a list';
  if (ops.length > MAX_OPS) return `at most ${MAX_OPS} operations at once`;
  const put = new Set();
  for (const op of ops) {
    if (!op || typeof op !== 'object') return 'an operation must be an object';
    switch (op.op) {
      case 'put': {
        const e = op.entry;
        if (!e || typeof e !== 'object' || !isId(e.id)) return 'put: invalid entry id';
        if (put.has(e.id)) return `put: entry ${e.id} twice`;
        put.add(e.id);
        if (typeof e.name !== 'string' || typeof e.shape !== 'string') return 'put: invalid entry';
        if (e.folder !== undefined && typeof e.folder !== 'string') return 'put: invalid folder';
        break;
      }
      case 'meta':
        if (!isId(op.id) || !op.patch || typeof op.patch !== 'object') return 'meta: invalid operation';
        break;
      case 'move':
        if (!isIds(op.ids) || typeof op.folder !== 'string') return 'move: invalid operation';
        break;
      case 'delete':
        if (!isIds(op.ids)) return 'delete: invalid operation';
        break;
      case 'addFolder':
        if (!normalizeFolder(op.path)) return 'addFolder: invalid path';
        break;
      case 'moveFolder':
        if (!normalizeFolder(op.from) || typeof op.to !== 'string') return 'moveFolder: invalid operation';
        break;
      case 'deleteFolder':
        if (!normalizeFolder(op.path) || !isIds(op.ids)) return 'deleteFolder: invalid operation';
        break;
      default:
        return `unknown operation ${JSON.stringify(op.op)}`;
    }
  }
  return null;
}

/**
 * Applies checked operations to a copy of `index`. `revs` gives the new revision of each entry put.
 * Returns the new index and the revisions of documents it no longer refers to. Operations on
 * missing entries do nothing, so concurrent changes from several devices merge: the last write of
 * an entry wins, and the other entries are kept.
 */
export function applyOps(index, ops, revs) {
  const entries = new Map(index.entries.map((e) => [e.id, e]));
  let folders = new Set(index.folders);
  const removed = [];
  const drop = (id) => {
    const e = entries.get(id);
    if (!e) return;
    removed.push({ id, rev: e.rev });
    entries.delete(id);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'put': {
        const id = op.entry.id;
        const old = entries.get(id);
        if (old && old.rev !== revs[id]) removed.push({ id, rev: old.rev });
        // Without a folder, an entry stays where it is: another device may have moved it.
        const folder = op.entry.folder === undefined ? (old?.folder ?? '') : normalizeFolder(op.entry.folder);
        entries.set(id, { ...pick(op.entry, ENTRY_FIELDS), folder, rev: revs[id] });
        break;
      }
      case 'meta': {
        const e = entries.get(op.id);
        if (e) entries.set(op.id, { ...e, ...pick(op.patch, META_FIELDS) });
        break;
      }
      case 'move': {
        const folder = normalizeFolder(op.folder);
        for (const id of op.ids) {
          const e = entries.get(id);
          if (e) entries.set(id, { ...e, folder });
        }
        break;
      }
      case 'delete':
        for (const id of op.ids) drop(id);
        break;
      case 'addFolder':
        folders.add(normalizeFolder(op.path));
        break;
      case 'moveFolder': {
        const from = normalizeFolder(op.from);
        const to = normalizeFolder(op.to);
        // A folder cannot move into itself.
        if (!from || isWithin(to, from)) break;
        const moved = (path) => (isWithin(path, from) ? to + path.slice(from.length) : path);
        folders = new Set([...folders].map(moved));
        for (const [id, e] of entries) if (isWithin(e.folder, from)) entries.set(id, { ...e, folder: moved(e.folder) });
        break;
      }
      case 'deleteFolder': {
        // Only the entries the user was shown go: a folder that still holds others stays.
        const path = normalizeFolder(op.path);
        if (!path) break;
        for (const id of op.ids) if (isWithin(entries.get(id)?.folder ?? '', path)) drop(id);
        folders = new Set([...folders].filter((f) => !isWithin(f, path)));
        break;
      }
    }
  }
  // Every folder of an entry exists, with its parents.
  const all = new Set();
  const add = (path) => {
    for (let p = path; p && !all.has(p); p = parentFolder(p)) all.add(p);
  };
  for (const f of folders) add(f);
  for (const e of entries.values()) add(e.folder);
  return {
    index: { format: INDEX_FORMAT, version: 1, folders: [...all].sort(), entries: [...entries.values()] },
    removed,
  };
}

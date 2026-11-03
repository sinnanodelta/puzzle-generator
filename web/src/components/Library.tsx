// The puzzle library (SPEC §2.2): the shared library and the one of this device, in folders, shown as
// cards or as a table to sort and filter; import of JSON and BurrTools files, and export.
import { type DragEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { emptyDoc, fromDoc, toDoc } from '../core/doc';
import {
  addEntries,
  canEdit,
  changeLibrary,
  entryRating,
  folderName,
  getLibrary,
  type IndexEntry,
  indexOf,
  isWithin,
  type LibraryEntry,
  type LibraryOp,
  loadDoc,
  lock,
  newEntryId,
  normalizeFolder,
  openFolder,
  parentFolder,
  refreshLibrary,
  renameEntry,
  shownScope,
  subscribeLibrary,
  syncLibrary,
  unlock,
  uploadLocal,
} from '../core/library';
import { renderThumbnail } from '../core/thumbnail';
import { confirmDiscard, notify, openDoc, viewDoc } from '../store';
import type { PuzzleDoc } from '../types';
import { checkDocument, errorMessage, type XmpuzzleImport, type XmpuzzleProblem, xmpuzzleProblems } from '../wasm';
import type { XmpuzzleRequest, XmpuzzleResponse } from '../workers/xmpuzzle.worker';
import { ExportDialog } from './ExportDialog';
import './library.css';
import { ActionMenu, FolderPicker, folderLabel, type MenuItem, ratingTitle, statusText, Thumb } from './LibraryParts';
import { activeFilters, COLUMNS, type ColumnKey, DEFAULT_HIDDEN, type Filters, filterEntries, LibraryTable, type Sort, sortEntries } from './LibraryTable';
import { ProblemPicker } from './ProblemPicker';
import { TemplatesDialog } from './TemplatesDialog';
import { UniquenessBadge } from './UniquenessBadge';

interface ViewPrefs {
  view: 'cards' | 'table';
  sort: Sort;
  hidden: ColumnKey[];
  /** The puzzles of the subfolders are shown too. */
  subfolders: boolean;
}

const VIEW_KEY = 'puzzle-generator.library-view';
const UPLOAD_KEY = 'puzzle-generator.library-upload-hidden';
const ENTRIES_MIME = 'application/x-puzzle-entries';
const FOLDER_MIME = 'application/x-puzzle-folder';

function loadJson<T>(key: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) };
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept.
  }
}

// The search and the filters last while the app is open.
const session: { search: string; filters: Filters } = { search: '', filters: {} };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A document as a new library entry, or the reason it is not valid. */
function importedEntry(doc: PuzzleDoc): LibraryEntry | string {
  const error = checkDocument(doc);
  if (error) return error;
  const now = new Date().toISOString();
  const normal = toDoc(fromDoc(doc));
  normal.meta.created ||= now;
  normal.meta.updated ||= now;
  return {
    id: newEntryId(),
    name: normal.name,
    doc: normal,
    thumbnail: renderThumbnail(normal),
    meta: { levelString: null, status: null, moves: null, uniqueness: null, created: now, updated: now },
  };
}

/** Imports a problem of a BurrTools file in a worker of its own: placing the pieces may take seconds. */
function importXmpuzzleInWorker(bytes: Uint8Array, problem: number, fallbackName: string): Promise<XmpuzzleImport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/xmpuzzle.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<XmpuzzleResponse>) => {
      worker.terminate();
      if ('error' in e.data) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'the import worker failed'));
    };
    worker.postMessage({ id: 0, bytes, problem, fallbackName } satisfies XmpuzzleRequest);
  });
}

interface Picking {
  file: string;
  problems: XmpuzzleProblem[];
  pick: (index: number | null) => void;
}

const run = (action: () => Promise<unknown>) => {
  action().catch((e) => notify(errorMessage(e)));
};

/** Asks for a folder name; null when cancelled or not valid (with a message). */
function askFolderName(message: string, value = ''): string | null {
  const name = window.prompt(message, value)?.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (name.includes('/')) {
    notify('A folder name cannot contain “/”');
    return null;
  }
  return name;
}

export function Library() {
  const lib = useSyncExternalStore(subscribeLibrary, getLibrary);
  const scope = shownScope(lib);
  const index = indexOf(lib, scope);
  const editable = canEdit(lib, scope);
  const shared = scope === 'shared';
  // The folder shown, or its nearest parent still there (another device may have deleted it).
  let folder = lib.folder;
  while (folder && !index.folders.includes(folder)) folder = parentFolder(folder);

  const [prefs, setPrefs] = useState<ViewPrefs>(() =>
    loadJson<ViewPrefs>(VIEW_KEY, { view: 'cards', sort: { key: 'updated', desc: true }, hidden: DEFAULT_HIDDEN, subfolders: false }),
  );
  const [search, setSearch] = useState(session.search);
  const [filters, setFilters] = useState(session.filters);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [templates, setTemplates] = useState(false);
  const [exporting, setExporting] = useState<PuzzleDoc | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [moving, setMoving] = useState<{ ids: string[] } | { folder: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [uploadHidden, setUploadHidden] = useState<string[]>(() => loadJson<{ ids: string[] }>(UPLOAD_KEY, { ids: [] }).ids);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void syncLibrary();
    const check = () => {
      if (document.visibilityState === 'visible') void refreshLibrary();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  useEffect(() => setSelection(new Set()), [scope, folder]);

  const changePrefs = (patch: Partial<ViewPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveJson(VIEW_KEY, next);
  };
  const changeSearch = (value: string) => {
    session.search = value;
    setSearch(value);
  };
  const changeFilters = (value: Filters) => {
    session.filters = value;
    setFilters(value);
  };

  const filtering = search.trim() !== '' || activeFilters(filters) > 0;
  const deep = prefs.subfolders || filtering;
  const subfolders = index.folders.filter((f) => f !== '' && parentFolder(f) === folder);
  const inFolder = useMemo(() => index.entries.filter((e) => (deep ? isWithin(e.folder, folder) : e.folder === folder)), [index, folder, deep]);
  const shown = useMemo(() => sortEntries(filterEntries(inFolder, filters, search), prefs.sort), [inFolder, filters, search, prefs.sort]);
  const selected = index.entries.filter((e) => selection.has(e.id)).map((e) => e.id);
  const select = (ids: string[], on: boolean) =>
    setSelection((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const counts = (path: string) => {
    const puzzles = index.entries.filter((e) => isWithin(e.folder, path)).length;
    const folders = index.folders.filter((f) => f !== path && isWithin(f, path)).length;
    return [puzzles > 0 && plural(puzzles, 'puzzle'), folders > 0 && plural(folders, 'folder')].filter(Boolean).join(' · ') || 'empty';
  };

  // --- Actions -----------------------------------------------------------------------------------

  const change = (ops: LibraryOp[]) => run(() => changeLibrary(scope, ops));

  const open = (e: IndexEntry) => {
    if (confirmDiscard()) run(async () => openDoc(await loadDoc(scope, e), e.id));
  };

  const duplicate = (e: IndexEntry) =>
    run(async () => {
      const doc = await loadDoc(scope, e);
      const now = new Date().toISOString();
      const name = `${e.name} (copy)`;
      const meta = { levelString: e.levelString, status: e.status, moves: e.moves, uniqueness: e.uniqueness, created: now, updated: now };
      await addEntries(scope, [{ id: newEntryId(), name, doc: { ...doc, name, meta: { ...doc.meta, created: now, updated: now } }, meta }], e.folder);
    });

  const rename = (e: IndexEntry) => {
    const name = window.prompt('Rename the puzzle', e.name)?.trim();
    if (name && name !== e.name) run(() => renameEntry(scope, e, name));
  };

  const remove = (ids: string[]) => {
    const names = index.entries.filter((e) => ids.includes(e.id));
    if (names.length === 0) return;
    const what = names.length === 1 ? `“${names[0].name}”` : plural(names.length, 'puzzle');
    if (!window.confirm(`Delete ${what} from ${shared ? 'the shared library, on every device' : 'this device'}?`)) return;
    setSelection(new Set());
    change([{ op: 'delete', ids }]);
  };

  const upload = (ids: string[] | null) =>
    run(async () => {
      const n = await uploadLocal(ids);
      setSelection(new Set());
      notify(`Uploaded ${plural(n, 'puzzle')} to the shared library`);
    });

  const newFolder = () => {
    const name = askFolderName('Name of the new folder');
    if (!name) return;
    const path = normalizeFolder(`${folder}/${name}`);
    if (index.folders.includes(path)) notify(`There is already a folder “${name}” here`);
    else change([{ op: 'addFolder', path }]);
  };

  const renameFolder = (path: string) => {
    const name = askFolderName('Rename the folder', folderName(path));
    if (!name || name === folderName(path)) return;
    const to = normalizeFolder(`${parentFolder(path)}/${name}`);
    if (index.folders.includes(to)) notify(`There is already a folder “${name}” here`);
    else change([{ op: 'moveFolder', from: path, to }]);
  };

  /** Moves a folder into `target`; one of the same name there is merged with it. */
  const moveFolder = (path: string, target: string) => {
    const to = normalizeFolder(`${target}/${folderName(path)}`);
    if (to !== path && !isWithin(target, path)) change([{ op: 'moveFolder', from: path, to }]);
  };

  const deleteFolder = (path: string) => {
    const inside = index.entries.filter((e) => isWithin(e.folder, path));
    const subs = index.folders.filter((f) => f !== path && isWithin(f, path)).length;
    const content = [subs > 0 && plural(subs, 'subfolder'), inside.length > 0 && plural(inside.length, 'puzzle')].filter(Boolean).join(' and ');
    const question = content
      ? `Delete the folder “${folderName(path)}” with its ${content}${shared ? ', on every device' : ''}?`
      : `Delete the empty folder “${folderName(path)}”?`;
    if (window.confirm(question)) change([{ op: 'deleteFolder', path, ids: inside.map((e) => e.id) }]);
  };

  const entryMenu = (e: IndexEntry): MenuItem[] => [
    { label: 'View', action: () => run(async () => void viewDoc(await loadDoc(scope, e))) },
    { label: 'Export…', action: () => run(async () => setExporting(await loadDoc(scope, e))) },
    ...(editable
      ? [
          { label: 'Rename…', action: () => rename(e) },
          { label: 'Move…', action: () => setMoving({ ids: selection.has(e.id) ? selected : [e.id] }) },
          { label: 'Duplicate', action: () => duplicate(e) },
        ]
      : []),
    ...(scope === 'local' && lib.mode === 'shared' ? [{ label: 'Upload to the shared library', action: () => upload([e.id]) }] : []),
    ...(editable ? [{ label: 'Delete', danger: true, action: () => remove([e.id]) }] : []),
  ];

  const folderMenu = (path: string): MenuItem[] => [
    { label: 'Open', action: () => openFolder(scope, path) },
    ...(editable
      ? [
          { label: 'Rename…', action: () => renameFolder(path) },
          { label: 'Move…', action: () => setMoving({ folder: path }) },
          { label: 'Delete…', danger: true, action: () => deleteFolder(path) },
        ]
      : []),
  ];

  // --- Drag and drop (mouse): puzzles and folders onto folders and the path ----------------------

  const dragEntry = editable
    ? (e: IndexEntry, ev: DragEvent) => {
        ev.dataTransfer.setData(ENTRIES_MIME, JSON.stringify(selection.has(e.id) ? selected : [e.id]));
        ev.dataTransfer.effectAllowed = 'move';
      }
    : null;
  const dragFolder = (path: string) => (ev: DragEvent) => {
    ev.dataTransfer.setData(FOLDER_MIME, path);
    ev.dataTransfer.effectAllowed = 'move';
  };
  const dropOn = (target: string) =>
    editable
      ? {
          onDragOver: (ev: DragEvent) => {
            if (!ev.dataTransfer.types.includes(ENTRIES_MIME) && !ev.dataTransfer.types.includes(FOLDER_MIME)) return;
            ev.preventDefault();
            setDropTarget(target);
          },
          onDragLeave: () => setDropTarget((t) => (t === target ? null : t)),
          onDrop: (ev: DragEvent) => {
            ev.preventDefault();
            setDropTarget(null);
            const ids = ev.dataTransfer.getData(ENTRIES_MIME);
            const path = ev.dataTransfer.getData(FOLDER_MIME);
            if (ids) change([{ op: 'move', ids: JSON.parse(ids) as string[], folder: target }]);
            else if (path) moveFolder(path, target);
          },
        }
      : {};

  // --- Import ------------------------------------------------------------------------------------

  /** The problem to import from a BurrTools file: the only one, or the user's pick (null to skip the file). */
  const pickProblem = async (file: string, problems: XmpuzzleProblem[]): Promise<number | null> => {
    if (problems.length === 1) return problems[0].index;
    const index = await new Promise<number | null>((pick) => setPicking({ file, problems, pick }));
    setPicking(null);
    return index;
  };

  /** Reads one file; returns its messages (errors and warnings) and its puzzle. */
  const importFile = async (file: File): Promise<[string[], LibraryEntry | null]> => {
    if (file.name.toLowerCase().endsWith('.json')) {
      const entry = importedEntry(JSON.parse(await file.text()) as PuzzleDoc);
      return typeof entry === 'string' ? [[entry], null] : [[], entry];
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problems = xmpuzzleProblems(bytes);
    if (problems.length === 0) return [['the file has no problem'], null];
    const problem = await pickProblem(file.name, problems);
    if (problem === null) return [[], null];
    const { document, warnings } = await importXmpuzzleInWorker(bytes, problem, file.name.replace(/\.[^.]*$/, ''));
    const entry = importedEntry(document);
    return typeof entry === 'string' ? [[entry], null] : [warnings, entry];
  };

  const importFiles = async (files: File[]) => {
    const messages: string[] = [];
    const added: LibraryEntry[] = [];
    for (const file of files) {
      setImporting(file.name);
      try {
        const [lines, entry] = await importFile(file);
        messages.push(...lines.map((line) => `${file.name}: ${line}`));
        if (entry) added.push(entry);
      } catch (e) {
        messages.push(`${file.name}: ${errorMessage(e)}`);
      }
    }
    try {
      if (added.length > 0) await addEntries(scope, added, folder);
      notify([`Imported ${plural(added.length, 'puzzle')}`, ...messages].join('\n'));
    } catch (e) {
      notify([errorMessage(e), ...messages].join('\n'));
    }
    setImporting(null);
  };

  // --- View --------------------------------------------------------------------------------------

  const hasLocal = lib.local.entries.length > 0 || lib.local.folders.length > 0;
  const scopes = lib.mode !== 'local' && lib.shared !== null && (hasLocal || scope === 'local');
  const rootName = scope === 'local' && lib.mode !== 'local' ? 'This device' : 'Library';
  const pending = lib.local.entries.filter((e) => !uploadHidden.includes(e.id));
  const offerUpload = lib.mode === 'shared' && scope === 'shared' && pending.length > 0;
  const crumbs = folder ? folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')) : [];
  const emptyLibrary = index.entries.length === 0 && index.folders.length === 0;
  const emptyText = filtering ? 'No puzzle matches the search and the filters.' : 'No puzzle in this folder.';

  const card = (e: IndexEntry) => {
    const r = entryRating(e);
    return (
      <div key={e.id} className={selection.has(e.id) ? 'card selected' : 'card'} draggable={editable} onDragStart={(ev) => dragEntry?.(e, ev)}>
        <div className="card-thumb">
          <Thumb key={e.rev} entry={e} onClick={() => open(e)} />
          {editable && <input type="checkbox" className="card-pick" aria-label={`Select ${e.name}`} checked={selection.has(e.id)} onChange={(ev) => select([e.id], ev.target.checked)} />}
        </div>
        <div className="card-name" title={e.name}>
          {e.name}
        </div>
        <div className={`card-status ${e.status ?? ''}`}>
          {statusText(e)}
          {e.moves !== null && <span className="dim"> · {plural(e.moves, 'move')}</span>}
        </div>
        <div className="card-info">
          {e.uniqueness && <UniquenessBadge check={{ kind: 'done', result: e.uniqueness }} />}
          <span className="dim small" title={ratingTitle(r)}>
            rating {r.total}
          </span>
        </div>
        {e.folder !== folder && <div className="dim small card-folder">📁 {folderLabel(e.folder)}</div>}
        <div className="dim small">{new Date(e.updated).toLocaleString()}</div>
        <div className="card-actions">
          <button onClick={() => open(e)}>Open</button>
          <ActionMenu items={entryMenu(e)} />
        </div>
      </div>
    );
  };

  return (
    <div className="library">
      <div className="library-actions">
        <button
          className="primary"
          onClick={() => {
            if (confirmDiscard()) openDoc(toDoc(emptyDoc()));
          }}
        >
          New puzzle
        </button>
        <button onClick={() => setTemplates(true)}>Templates…</button>
        <button disabled={importing !== null || !editable} title="Puzzles of this app (.json) or BurrTools files (.xmpuzzle)" onClick={() => fileInput.current?.click()}>
          Import…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.xmpuzzle,application/json"
          multiple
          hidden
          onChange={(e) => {
            const input = e.target;
            const files = [...(input.files ?? [])];
            input.value = '';
            if (files.length > 0) void importFiles(files);
          }}
        />
        <button disabled={!editable} onClick={newFolder}>
          New folder
        </button>
        {importing && <span className="dim">Importing {importing}…</span>}
        <span className="lib-tools">
          <input type="search" className="lib-search" placeholder="Search" aria-label="Search the library" value={search} onChange={(e) => changeSearch(e.target.value)} />
          <span className="segmented">
            <button className={prefs.view === 'cards' ? 'on' : ''} title="Thumbnails" onClick={() => changePrefs({ view: 'cards' })}>
              Cards
            </button>
            <button className={prefs.view === 'table' ? 'on' : ''} title="A table to sort and filter by column" onClick={() => changePrefs({ view: 'table' })}>
              Table
            </button>
          </span>
          {prefs.view === 'table' ? (
            <ActionMenu
              label="Columns"
              title="Columns shown"
              items={COLUMNS.filter((c) => c.key !== 'name').map((c) => ({
                label: c.label || 'Thumbnail',
                checked: !prefs.hidden.includes(c.key),
                action: () => changePrefs({ hidden: prefs.hidden.includes(c.key) ? prefs.hidden.filter((k) => k !== c.key) : [...prefs.hidden, c.key] }),
              }))}
            />
          ) : (
            <span className="lib-sort">
              <select aria-label="Sort by" value={prefs.sort.key} onChange={(e) => changePrefs({ sort: { ...prefs.sort, key: e.target.value as ColumnKey } })}>
                {COLUMNS.filter((c) => c.key !== 'thumb').map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button title={prefs.sort.desc ? 'Descending' : 'Ascending'} onClick={() => changePrefs({ sort: { ...prefs.sort, desc: !prefs.sort.desc } })}>
                {prefs.sort.desc ? '▼' : '▲'}
              </button>
            </span>
          )}
          <SyncStatus />
        </span>
      </div>

      {lib.notice && <div className={`lib-notice ${lib.mode === 'offline' ? 'warn' : ''}`}>{lib.notice}</div>}
      {offerUpload && (
        <div className="lib-notice offer">
          <span>
            {plural(pending.length, 'puzzle is', 'puzzles are')} saved in this browser only (from before the shared library, offline, or without the password).
          </span>
          <button className="primary" onClick={() => upload(null)}>
            Upload to the shared library
          </button>
          <button onClick={() => openFolder('local', '')}>Show</button>
          <button
            onClick={() => {
              const ids = lib.local.entries.map((e) => e.id);
              setUploadHidden(ids);
              saveJson(UPLOAD_KEY, { ids });
            }}
          >
            Not now
          </button>
        </div>
      )}

      <div className="library-nav">
        {scopes && (
          <span className="segmented">
            <button className={shared ? 'on' : ''} onClick={() => openFolder('shared', '')}>
              Shared library
            </button>
            <button className={shared ? '' : 'on'} title="Puzzles saved in this browser only" onClick={() => openFolder('local', '')}>
              This device ({lib.local.entries.length})
            </button>
          </span>
        )}
        <nav className="crumbs" aria-label="Folder">
          <button className={`${folder === '' ? 'here' : ''} ${dropTarget === '' ? 'drop' : ''}`} onClick={() => openFolder(scope, '')} {...dropOn('')}>
            {rootName}
          </button>
          {crumbs.map((path) => (
            <span key={path}>
              <span className="dim">›</span>
              <button className={`${path === folder ? 'here' : ''} ${dropTarget === path ? 'drop' : ''}`} onClick={() => openFolder(scope, path)} {...dropOn(path)}>
                {folderName(path)}
              </button>
            </span>
          ))}
        </nav>
        <label className="check" title="Show the puzzles of the subfolders too (searching always does)">
          <input type="checkbox" checked={prefs.subfolders} onChange={(e) => changePrefs({ subfolders: e.target.checked })} />
          Subfolders
        </label>
        <span className="dim small">
          {plural(shown.length, 'puzzle')}
          {shown.length !== inFolder.length && ` of ${inFolder.length}`}
          {filtering && (
            <button
              className="link"
              onClick={() => {
                changeSearch('');
                changeFilters({});
              }}
            >
              clear filters
            </button>
          )}
        </span>
      </div>

      {selected.length > 0 && (
        <div className="lib-selection">
          <span>{plural(selected.length, 'puzzle')} selected</span>
          <button onClick={() => setMoving({ ids: selected })}>Move…</button>
          {scope === 'local' && lib.mode === 'shared' && <button onClick={() => upload(selected)}>Upload to the shared library</button>}
          <button className="danger" onClick={() => remove(selected)}>
            Delete
          </button>
          <button onClick={() => setSelection(new Set())}>Clear</button>
        </div>
      )}

      <div className="library-body">
        {lib.mode === 'loading' && emptyLibrary ? (
          <p className="dim">Loading…</p>
        ) : emptyLibrary && !filtering ? (
          <div className="empty-state">
            <p>The library is empty. Start from a template, or import a JSON or BurrTools file.</p>
          </div>
        ) : prefs.view === 'table' ? (
          <LibraryTable
            entries={shown}
            hidden={prefs.hidden}
            sort={prefs.sort}
            onSort={(sort) => changePrefs({ sort })}
            filters={filters}
            onFilter={changeFilters}
            folderRows={(span) =>
              subfolders.map((path) => (
                <tr key={path} className={dropTarget === path ? 'folder-row drop' : 'folder-row'} draggable={editable} onDragStart={dragFolder(path)} {...dropOn(path)}>
                  <td className="pick" />
                  <td colSpan={span - 2} onClick={() => openFolder(scope, path)}>
                    📁 {folderName(path)} <span className="dim small">{counts(path)}</span>
                  </td>
                  <td className="lib-row-actions">
                    <ActionMenu items={folderMenu(path)} />
                  </td>
                </tr>
              ))
            }
            selection={editable ? selection : null}
            onSelect={select}
            onOpen={open}
            menu={entryMenu}
            onDragStart={dragEntry}
            empty={subfolders.length > 0 ? '' : emptyText}
          />
        ) : (
          <>
            <div className="cards">
              {subfolders.map((path) => (
                <div
                  key={path}
                  className={dropTarget === path ? 'card folder-card drop' : 'card folder-card'}
                  draggable={editable}
                  onDragStart={dragFolder(path)}
                  onClick={() => openFolder(scope, path)}
                  {...dropOn(path)}
                >
                  <div className="folder-icon">📁</div>
                  <div className="card-name" title={path}>
                    {folderName(path)}
                  </div>
                  <div className="dim small">{counts(path)}</div>
                  <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                    <ActionMenu items={folderMenu(path)} />
                  </div>
                </div>
              ))}
              {shown.map(card)}
            </div>
            {shown.length === 0 && subfolders.length === 0 && <p className="dim">{emptyText}</p>}
          </>
        )}
      </div>

      {templates && <TemplatesDialog onClose={() => setTemplates(false)} />}
      {exporting && <ExportDialog doc={exporting} onClose={() => setExporting(null)} />}
      {picking && <ProblemPicker file={picking.file} problems={picking.problems} onPick={picking.pick} />}
      {moving && (
        <FolderPicker
          title={'ids' in moving ? `Move ${plural(moving.ids.length, 'puzzle')} to` : `Move the folder “${folderName(moving.folder)}” to`}
          folders={index.folders}
          current={'ids' in moving ? folder : parentFolder(moving.folder)}
          exclude={'folder' in moving ? moving.folder : undefined}
          onClose={() => setMoving(null)}
          onPick={(target) => {
            setMoving(null);
            if ('ids' in moving) {
              setSelection(new Set());
              change([{ op: 'move', ids: moving.ids, folder: target }]);
            } else moveFolder(moving.folder, target);
          }}
        />
      )}
    </div>
  );
}

/** Where the library comes from, the password, and a check for changes. */
function SyncStatus() {
  const lib = useSyncExternalStore(subscribeLibrary, getLibrary);
  if (lib.mode === 'local') return null;
  const checked = lib.sharedAt ? new Date(lib.sharedAt).toLocaleTimeString() : 'never';
  return (
    <span className="lib-sync">
      {lib.mode === 'loading' && <span className="dim small">Connecting…</span>}
      {lib.mode === 'offline' && <span className="warn small">Offline</span>}
      {lib.saving > 0 && <span className="dim small">Saving…</span>}
      {lib.mode === 'shared' &&
        (lib.unlocked ? (
          <button title="Forget the password of the shared library on this device" onClick={lock}>
            🔓<span className="lib-label"> Lock</span>
          </button>
        ) : (
          <button
            title="Type the password to change the shared library from this device"
            onClick={() =>
              run(async () => {
                if (await unlock()) notify('The shared library can be changed from this device');
              })
            }
          >
            🔒<span className="lib-label"> Unlock</span>
          </button>
        ))}
      <button title={`Check for changes (last check: ${checked})`} onClick={() => void refreshLibrary()}>
        ↻
      </button>
    </span>
  );
}

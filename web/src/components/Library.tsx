// The puzzle library (SPEC §2.2): saved puzzles with their thumbnail and cached status, import of
// JSON and BurrTools files, and export.
import { useEffect, useRef, useState } from 'react';
import { emptyDoc, fromDoc, toDoc } from '../core/doc';
import { deleteEntry, type EntryMeta, type LibraryEntry, listEntries, newEntryId, putEntry } from '../core/library';
import { renderThumbnail } from '../core/thumbnail';
import { confirmDiscard, notify, openDoc, setState, useStore, viewDoc } from '../store';
import type { PuzzleDoc } from '../types';
import { checkDocument, errorMessage, type XmpuzzleImport, type XmpuzzleProblem, xmpuzzleProblems } from '../wasm';
import type { XmpuzzleRequest, XmpuzzleResponse } from '../workers/xmpuzzle.worker';
import { ExportDialog } from './ExportDialog';
import { ProblemPicker } from './ProblemPicker';
import { TemplatesDialog } from './TemplatesDialog';
import { UniquenessBadge } from './UniquenessBadge';

function statusText(meta: EntryMeta): string {
  switch (meta.status) {
    case 'solved':
      return `level ${meta.levelString}`;
    case 'unsolvable':
      return 'not solvable';
    case 'aborted':
      return 'solver gave up';
    case 'invalid':
      return 'invalid';
    default:
      return 'not checked';
  }
}

const bump = () => setState((s) => ({ libraryVersion: s.libraryVersion + 1 }));

/** Adds a document to the library; returns an error message when it is not valid. */
async function importDoc(doc: PuzzleDoc): Promise<string | null> {
  const error = checkDocument(doc);
  if (error) return error;
  const now = new Date().toISOString();
  const normal = toDoc(fromDoc(doc));
  normal.meta.created ||= now;
  normal.meta.updated ||= now;
  await putEntry({
    id: newEntryId(),
    name: normal.name,
    doc: normal,
    thumbnail: renderThumbnail(normal),
    meta: { levelString: null, status: null, uniqueness: null, created: now, updated: now },
  });
  return null;
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

export function Library() {
  const version = useStore((s) => s.libraryVersion);
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [templates, setTemplates] = useState(false);
  const [exporting, setExporting] = useState<PuzzleDoc | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    listEntries().then(
      (list) => live && setEntries(list),
      (e) => notify(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [version]);

  /** The problem to import from a BurrTools file: the only one, or the user's pick (null to skip the file). */
  const pickProblem = async (file: string, problems: XmpuzzleProblem[]): Promise<number | null> => {
    if (problems.length === 1) return problems[0].index;
    const index = await new Promise<number | null>((pick) => setPicking({ file, problems, pick }));
    setPicking(null);
    return index;
  };

  /** Imports one file; returns its messages (errors and warnings) and whether a puzzle was added. */
  const importFile = async (file: File): Promise<[string[], boolean]> => {
    if (file.name.toLowerCase().endsWith('.json')) {
      const error = await importDoc(JSON.parse(await file.text()));
      return error ? [[error], false] : [[], true];
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problems = xmpuzzleProblems(bytes);
    if (problems.length === 0) return [['the file has no problem'], false];
    const problem = await pickProblem(file.name, problems);
    if (problem === null) return [[], false];
    const { document, warnings } = await importXmpuzzleInWorker(bytes, problem, file.name.replace(/\.[^.]*$/, ''));
    const error = await importDoc(document);
    return error ? [[error], false] : [warnings, true];
  };

  const importFiles = async (files: File[]) => {
    const messages: string[] = [];
    let added = 0;
    for (const file of files) {
      setImporting(file.name);
      try {
        const [lines, ok] = await importFile(file);
        messages.push(...lines.map((line) => `${file.name}: ${line}`));
        if (ok) added++;
      } catch (e) {
        messages.push(`${file.name}: ${errorMessage(e)}`);
      }
    }
    setImporting(null);
    notify([`Imported ${added} puzzle${added === 1 ? '' : 's'}`, ...messages].join('\n'));
    bump();
  };

  const duplicate = async (entry: LibraryEntry) => {
    const now = new Date().toISOString();
    const name = `${entry.name} (copy)`;
    const doc = { ...entry.doc, name, meta: { ...entry.doc.meta, created: now, updated: now } };
    await putEntry({ ...entry, id: newEntryId(), name, doc, meta: { ...entry.meta, created: now, updated: now } });
    bump();
  };

  const remove = async (entry: LibraryEntry) => {
    if (!window.confirm(`Delete “${entry.name}” from the library?`)) return;
    await deleteEntry(entry.id);
    bump();
  };

  const run = (action: () => Promise<void>) => () => {
    action().catch((e) => notify(errorMessage(e)));
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
        <button disabled={importing !== null} title="Puzzles of this app (.json) or BurrTools files (.xmpuzzle)" onClick={() => fileInput.current?.click()}>
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
        {importing && <span className="dim">Importing {importing}…</span>}
      </div>
      {entries === null ? (
        <p className="dim">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <p>The library is empty. Start from a template, or import a JSON or BurrTools file.</p>
        </div>
      ) : (
        <div className="cards">
          {entries.map((entry) => (
            <div key={entry.id} className="card">
              <img
                src={entry.thumbnail}
                alt=""
                onClick={() => {
                  if (confirmDiscard()) openDoc(entry.doc, entry.id);
                }}
              />
              <div className="card-name" title={entry.name}>
                {entry.name}
              </div>
              <div className={`card-status ${entry.meta.status ?? ''}`}>{statusText(entry.meta)}</div>
              {entry.meta.uniqueness && (
                <div>
                  <UniquenessBadge check={{ kind: 'done', result: entry.meta.uniqueness }} />
                </div>
              )}
              <div className="dim small">{new Date(entry.meta.updated).toLocaleString()}</div>
              <div className="card-actions">
                <button
                  onClick={() => {
                    if (confirmDiscard()) openDoc(entry.doc, entry.id);
                  }}
                >
                  Open
                </button>
                <button onClick={() => void viewDoc(entry.doc)}>View</button>
                <button onClick={() => setExporting(entry.doc)}>Export…</button>
                <button onClick={run(() => duplicate(entry))}>Duplicate</button>
                <button className="danger" onClick={run(() => remove(entry))}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {templates && <TemplatesDialog onClose={() => setTemplates(false)} />}
      {exporting && <ExportDialog doc={exporting} onClose={() => setExporting(null)} />}
      {picking && <ProblemPicker file={picking.file} problems={picking.problems} onPick={picking.pick} />}
    </div>
  );
}

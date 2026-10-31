// Export of a puzzle (SPEC §2.2–2.4): the JSON document, a BurrTools `.xmpuzzle` file, or a zip of
// STL pieces.
import { useMemo, useState } from 'react';
import { downloadBlob, downloadDoc, safeFilename } from '../core/library';
import type { PuzzleDoc } from '../types';
import { errorMessage, exportXmpuzzle, type StlOptions, stlFileNames, stlZip } from '../wasm';

/** The STL options of the last export, kept for the next one. */
let lastStl: StlOptions = { unit: 10, clearance: 0.1, chamfer: 0 };

const STL_FIELDS: [keyof StlOptions, string, number, string][] = [
  ['unit', 'Voxel size', 0.5, 'Side of a voxel'],
  ['clearance', 'Clearance', 0.05, 'Removed from every face of a piece: touching faces end up twice this apart'],
  ['chamfer', 'Chamfer', 0.1, 'Size of the 45° chamfer of the convex edges; 0 for none'],
];

export function ExportDialog({ doc, onClose }: { doc: PuzzleDoc; onClose: () => void }) {
  const [stl, setStl] = useState<StlOptions>(lastStl);
  const [error, setError] = useState<string | null>(null);
  const files = useMemo(() => {
    try {
      return stlFileNames(doc).filter((_, i) => doc.pieces[i].fixed.length > 0);
    } catch {
      return [];
    }
  }, [doc]);
  const base = safeFilename(doc.name);

  const run = (action: () => void) => () => {
    setError(null);
    try {
      action();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const download = (bytes: Uint8Array, filename: string, type: string) =>
    downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), filename);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal export" onClick={(e) => e.stopPropagation()}>
        <h3>Export “{doc.name}”</h3>
        <div className="field">
          <span>JSON</span>
          <button onClick={run(() => downloadDoc(doc))}>Download .json</button>
          <span className="dim small">the document, for this app</span>
        </div>
        <div className="field">
          <span>BurrTools</span>
          <button onClick={run(() => download(exportXmpuzzle(doc), `${base}.xmpuzzle`, 'application/octet-stream'))}>Download .xmpuzzle</button>
          <span className="dim small">one problem with its solution</span>
        </div>
        <h4>STL for 3D printing</h4>
        {STL_FIELDS.map(([key, label, step, hint]) => (
          <div className="field" key={key}>
            <span title={hint}>{label}</span>
            <input
              type="number"
              min={0}
              step={step}
              value={stl[key]}
              title={hint}
              onChange={(e) => setStl({ ...stl, [key]: e.target.valueAsNumber })}
            />
            <span className="dim">mm</span>
          </div>
        ))}
        <div className="field">
          <span />
          <button
            className="primary"
            disabled={files.length === 0 || !Object.values(stl).every(Number.isFinite)}
            onClick={run(() => {
              download(stlZip(doc, stl), `${base}-stl.zip`, 'application/zip');
              lastStl = stl;
            })}
          >
            Download STL zip
          </button>
          <span className="dim small" title={files.join('\n')}>
            {files.length === 1 ? '1 file' : `${files.length} files`}, one per piece
          </span>
        </div>
        {error && <p className="export-error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

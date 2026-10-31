// Picks the problem to import from a BurrTools file with several (SPEC §2.3).
import type { XmpuzzleProblem } from '../wasm';

export function ProblemPicker({ file, problems, onPick }: { file: string; problems: XmpuzzleProblem[]; onPick: (index: number | null) => void }) {
  return (
    <div className="modal-backdrop" onClick={() => onPick(null)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Import from {file}</h3>
        <p className="dim">The file has {problems.length} problems. Pick the one to import.</p>
        <table className="burrs">
          <thead>
            <tr>
              <th>Problem</th>
              <th>Pieces</th>
              <th>Solutions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {problems.map((p) => (
              <tr key={p.index}>
                <td>{p.name || <span className="dim">Problem {p.index + 1}</span>}</td>
                <td>{p.pieces}</td>
                <td>{p.solutions}</td>
                <td>
                  <button onClick={() => onPick(p.index)}>Import</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button onClick={() => onPick(null)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// The status bar (SPEC §7.5): the live check of the fixed voxels and the counts of the analysis.
import { checkText } from '../core/checker';
import { fixedSignature } from '../core/doc';
import { retryWithLargerCap, useStore, viewCurrent } from '../store';

export function StatusBar() {
  const doc = useStore((s) => s.doc);
  const check = useStore((s) => s.check);
  const analysis = useStore((s) => s.analysis);

  const fresh = check.kind !== 'idle' && check.signature === fixedSignature(doc);
  let text = fresh ? checkText(check) : check.kind === 'idle' ? '' : 'computing…';
  let tone = '';
  if (fresh && check.kind === 'done') {
    tone = { solved: 'ok', unsolvable: 'bad', aborted: 'warn' }[check.result.status];
    if (check.result.status === 'aborted') text += ` after ${check.result.states.toLocaleString()} states`;
  } else if (fresh && check.kind === 'invalid') tone = 'invalid';

  return (
    <div className="status-bar">
      <span className={`status ${tone}`}>{text || ' '}</span>
      {fresh && check.kind === 'done' && check.result.status === 'solved' && (
        <button onClick={viewCurrent}>View solution</button>
      )}
      {fresh && check.kind === 'done' && check.result.status === 'aborted' && (
        <button onClick={retryWithLargerCap}>Retry with ×10 cap</button>
      )}
      <span className="dim grow-left">
        {doc.pieces.length} pieces
        {analysis && ` · ${analysis.voxels} voxels · ${analysis.holes} holes`}
      </span>
    </div>
  );
}

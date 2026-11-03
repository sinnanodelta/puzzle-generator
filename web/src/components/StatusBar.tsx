// The status bar (SPEC §7.5): the live check of the fixed voxels and the counts of the analysis. It
// keeps one line of fixed height; a cut text shows in full on a click (or a tap).
import { checkText } from '../core/checker';
import { fixedSignature } from '../core/doc';
import { notify, retryWithLargerCap, useStore, viewCurrent } from '../store';

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
      <span
        className={`status ${tone}`}
        title={text}
        onClick={(e) => {
          const el = e.currentTarget;
          if (el.scrollWidth > el.clientWidth) notify(text);
        }}
      >
        {text || ' '}
      </span>
      {fresh && check.kind === 'done' && check.result.status === 'solved' && (
        <button onClick={viewCurrent}>View solution</button>
      )}
      {fresh && check.kind === 'done' && check.result.status === 'aborted' && (
        <button onClick={retryWithLargerCap}>Retry ×10 cap</button>
      )}
      <span className="dim grow-left counts">
        <span className="count-pieces">{doc.pieces.length} pieces</span>
        {analysis && (
          <span>
            {analysis.voxels} voxels · {analysis.holes} holes
          </span>
        )}
      </span>
    </div>
  );
}

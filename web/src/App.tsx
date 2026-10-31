// The application shell: the tabs, the name and saving of the edited puzzle, the toast and the
// keyboard shortcuts of the editor.
import { useEffect, useState } from 'react';
import { editorKey } from './actions';
import { Editor } from './components/Editor';
import { ExportDialog } from './components/ExportDialog';
import { Generator } from './components/Generator';
import { Library } from './components/Library';
import { Viewer } from './components/Viewer';
import { toDoc } from './core/doc';
import { editDoc, getState, notify, saveDoc, setState, type Tab, useStore } from './store';
import type { PuzzleDoc } from './types';
import { errorMessage } from './wasm';

const TABS: [Tab, string][] = [
  ['library', 'Library'],
  ['editor', 'Editor'],
  ['viewer', 'Viewer'],
  ['generator', 'Generator'],
];

const save = () => {
  saveDoc().catch((e) => notify(errorMessage(e)));
};

/** Keys typed into these go to the field, not to the shortcuts. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range'].includes(target.type);
}

function DocTitle() {
  const name = useStore((s) => s.doc.name);
  const dirty = useStore((s) => s.dirty);
  const [exporting, setExporting] = useState<PuzzleDoc | null>(null);
  const commit = (value: string) => {
    const v = value.trim();
    if (v && v !== getState().doc.name) {
      editDoc((d) => {
        d.name = v;
      });
    }
  };
  return (
    <div className="doc-title">
      <input
        key={name}
        defaultValue={name}
        aria-label="Puzzle name"
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {dirty && <span title="Unsaved changes">•</span>}
      <button className="primary" onClick={save} title="Save to the library (Ctrl+S)">
        Save
      </button>
      <button onClick={() => setExporting(toDoc(getState().doc))} title="JSON, BurrTools or STL">
        Export…
      </button>
      {exporting && <ExportDialog doc={exporting} onClose={() => setExporting(null)} />}
    </div>
  );
}

function Toast() {
  const message = useStore((s) => s.message);
  useEffect(() => {
    if (!message) return;
    // Long messages (import warnings) stay longer.
    const timer = setTimeout(() => setState({ message: null }), Math.min(15000, 3000 + 40 * message.length));
    return () => clearTimeout(timer);
  }, [message]);
  if (!message) return null;
  return (
    <div className="toast" onClick={() => setState({ message: null })}>
      {message}
    </div>
  );
}

export function App() {
  const tab = useStore((s) => s.tab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      if (s.tab === 'editor' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
        return;
      }
      if (typing(e.target)) return;
      if (s.tab === 'editor' && editorKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-name">Puzzle Generator</span>
        <nav className="tabs">
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setState({ tab: t })}>
              {label}
            </button>
          ))}
        </nav>
        {tab === 'editor' && <DocTitle />}
      </header>
      <main className="app-main">
        {tab === 'library' && <Library />}
        {tab === 'editor' && <Editor />}
        {tab === 'viewer' && <Viewer />}
        {tab === 'generator' && <Generator />}
      </main>
      <Toast />
    </div>
  );
}

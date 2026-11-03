// The draft (SPEC §9.2): the edited document, the open tab and the editor's view are kept in the
// browser's storage whenever the page is hidden, so a mobile browser that reloads the page on
// return (after discarding it in the background) reopens them as they were.
import { toDoc } from './core/doc';
import { getState, openDoc, setState, type State, viewDoc } from './store';
import type { PuzzleDoc } from './types';

const KEY = 'puzzle-generator:draft';

const VIEW = ['tool', 'paintState', 'targetKind', 'showTarget', 'showLayers', 'hideOptional', 'axis', 'slice', 'current'] as const;

type Draft = Pick<State, 'tab' | 'libraryId' | 'dirty' | (typeof VIEW)[number]> & { doc: PuzzleDoc; viewerDoc: PuzzleDoc | null };

function saveDraft(): void {
  const s = getState();
  const draft: Draft = {
    ...Object.fromEntries(VIEW.map((k) => [k, s[k]])),
    tab: s.tab,
    libraryId: s.libraryId,
    dirty: s.dirty,
    doc: toDoc(s.doc),
    viewerDoc: s.viewer?.doc ?? null,
  } as Draft;
  try {
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the draft is only a convenience.
  }
}

function restoreDraft(): void {
  let draft: Draft;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    draft = JSON.parse(raw);
    openDoc(draft.doc, draft.libraryId);
  } catch {
    return;
  }
  setState({ ...Object.fromEntries(VIEW.map((k) => [k, draft[k]])), tab: draft.tab, dirty: draft.dirty });
  const { doc, current, slice, axis } = getState();
  setState({ current: Math.min(current, Math.max(0, doc.pieces.length - 1)), slice: Math.min(slice, doc.grid[axis] - 1) });
  if (draft.tab === 'viewer') {
    if (draft.viewerDoc) void viewDoc(draft.viewerDoc);
    else setState({ tab: 'editor' });
  }
}

/** Restores the draft of the last visit, then saves it each time the page is hidden or closed. */
export function keepDraft(): void {
  restoreDraft();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraft();
  });
  window.addEventListener('pagehide', saveDraft);
}

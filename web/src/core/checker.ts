// The live check (SPEC §3.4): solves the fixed voxels in a worker, debounced, and only when they
// changed. A newer request terminates a busy worker and starts a new one.
import type { PuzzleDoc, SolveResult } from '../types';
import type { CheckRequest, CheckResponse } from '../workers/check.worker';

export type CheckState =
  | { kind: 'idle' }
  | { kind: 'computing'; signature: string }
  | { kind: 'invalid'; signature: string; message: string }
  | { kind: 'done'; signature: string; result: SolveResult; maxStates: number | null };

const DEBOUNCE_MS = 250;

function spawn(): Worker {
  return new Worker(new URL('../workers/check.worker.ts', import.meta.url), { type: 'module' });
}

export class Checker {
  private worker: Worker | null = null;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;
  private lastSignature = '';
  /** What the request in flight was for. */
  private pending: { signature: string; maxStates: number | null } = { signature: '', maxStates: null };
  private onUpdate: (state: CheckState) => void;

  constructor(onUpdate: (state: CheckState) => void) {
    this.onUpdate = onUpdate;
  }

  /** Checks after a pause in the edits. */
  schedule(signature: string, doc: () => PuzzleDoc): void {
    clearTimeout(this.timer);
    if (signature === this.lastSignature) return;
    this.timer = setTimeout(() => this.run(signature, doc()), DEBOUNCE_MS);
  }

  /** Checks now; `force` re-runs an unchanged puzzle (with another cap). */
  run(signature: string, doc: PuzzleDoc, maxStates: number | null = null, force = false): void {
    clearTimeout(this.timer);
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;
    if (this.busy) this.worker?.terminate();
    if (this.busy || !this.worker) this.worker = this.listen(spawn());
    this.busy = true;
    const id = ++this.requestId;
    this.onUpdate({ kind: 'computing', signature });
    this.pending = { signature, maxStates };
    this.worker.postMessage({ id, doc, maxStates } satisfies CheckRequest);
  }

  private listen(worker: Worker): Worker {
    worker.onmessage = (e: MessageEvent<CheckResponse>) => {
      if (e.data.id !== this.requestId) return;
      this.busy = false;
      const { signature, maxStates } = this.pending;
      this.onUpdate(
        'error' in e.data
          ? { kind: 'invalid', signature, message: e.data.error }
          : { kind: 'done', signature, result: e.data.result, maxStates },
      );
    };
    return worker;
  }

  /** Forgets the last signature, so the next schedule checks again. */
  reset(): void {
    clearTimeout(this.timer);
    this.lastSignature = '';
    if (this.busy) {
      this.worker?.terminate();
      this.worker = null;
      this.busy = false;
    }
  }
}

/** Solves once in a dedicated worker (the viewer opened from the library). */
export function solveInWorker(doc: PuzzleDoc, maxStates: number | null = null): Promise<SolveResult> {
  return new Promise((resolve, reject) => {
    const worker = spawn();
    worker.onmessage = (e: MessageEvent<CheckResponse>) => {
      worker.terminate();
      if ('error' in e.data) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ id: 0, doc, maxStates } satisfies CheckRequest);
  });
}

export function checkText(check: CheckState): string {
  switch (check.kind) {
    case 'idle':
      return '';
    case 'computing':
      return 'computing…';
    case 'invalid':
      return check.message;
    case 'done': {
      const { result } = check;
      if (result.status === 'solved') return `Solvable — level ${result.solution!.level_string}`;
      if (result.status === 'unsolvable') return 'Not solvable';
      return 'Gave up (cap)';
    }
  }
}

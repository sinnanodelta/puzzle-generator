// Runs the uniqueness checks (SPEC §5) off the main thread, one document at a time. A check that is no
// longer wanted is cancelled by terminating the worker.
import { assemble, errorMessage, initWasm } from '../wasm';
import type { AssembleResult, PuzzleDoc } from '../types';

export interface AssembleRequest {
  id: number;
  doc: PuzzleDoc;
}

export type AssembleResponse = { id: number; result: AssembleResult } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<AssembleRequest>) => {
  const { id, doc } = e.data;
  await initWasm();
  let response: AssembleResponse;
  try {
    response = { id, result: assemble(doc) };
  } catch (err) {
    response = { id, error: errorMessage(err) };
  }
  self.postMessage(response);
};

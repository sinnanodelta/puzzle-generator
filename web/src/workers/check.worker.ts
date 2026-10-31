// Solves documents off the main thread (SPEC §3.4). A request that is no longer wanted is cancelled
// by terminating the worker.
import { defaultMaxStates, errorMessage, initWasm, solve } from '../wasm';
import type { PuzzleDoc, SolveResult } from '../types';

export interface CheckRequest {
  id: number;
  doc: PuzzleDoc;
  maxStates: number | null;
}

export type CheckResponse = { id: number; result: SolveResult } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<CheckRequest>) => {
  const { id, doc, maxStates } = e.data;
  await initWasm();
  let response: CheckResponse;
  try {
    response = { id, result: solve(doc, maxStates ?? defaultMaxStates()) };
  } catch (err) {
    response = { id, error: errorMessage(err) };
  }
  self.postMessage(response);
};

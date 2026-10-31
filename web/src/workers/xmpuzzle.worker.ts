// Imports a BurrTools problem (SPEC §2.3) off the main thread: without a solution in the file, the
// assembler places the pieces.
import { errorMessage, importXmpuzzle, initWasm, type XmpuzzleImport } from '../wasm';

export interface XmpuzzleRequest {
  id: number;
  bytes: Uint8Array;
  problem: number;
  fallbackName: string;
}

export type XmpuzzleResponse = { id: number; result: XmpuzzleImport } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<XmpuzzleRequest>) => {
  const { id, bytes, problem, fallbackName } = e.data;
  await initWasm();
  let response: XmpuzzleResponse;
  try {
    response = { id, result: importXmpuzzle(bytes, problem, fallbackName) };
  } catch (err) {
    response = { id, error: errorMessage(err) };
  }
  self.postMessage(response);
};

// One generator run (SPEC §4.3): steps the generator in chunks of about CHUNK_MS and posts a report
// after each, until the worker is terminated.
import type { GeneratorOptions, PuzzleDoc, StepReport } from '../types';
import { errorMessage, type GeneratorRun, initWasm, newGenerator } from '../wasm';

export interface GeneratorRequest {
  doc: PuzzleDoc;
  options: GeneratorOptions;
}

export type GeneratorResponse = { report: StepReport } | { error: string };

const CHUNK_MS = 100;

function post(response: GeneratorResponse): void {
  self.postMessage(response);
}

self.onmessage = async (e: MessageEvent<GeneratorRequest>) => {
  await initWasm();
  let generator: GeneratorRun;
  try {
    generator = newGenerator(e.data.doc, e.data.options);
  } catch (err) {
    post({ error: errorMessage(err) });
    return;
  }
  let checks = 10;
  const chunk = () => {
    let report: StepReport;
    const start = performance.now();
    try {
      report = generator.step(checks);
    } catch (err) {
      post({ error: errorMessage(err) });
      return;
    }
    // Aim the next chunk at CHUNK_MS, growing at most fourfold.
    const elapsed = Math.max(performance.now() - start, 1);
    checks = Math.max(1, Math.min(checks * 4, Math.round((checks * CHUNK_MS) / elapsed)));
    post({ report });
    setTimeout(chunk, 0);
  };
  chunk();
};

// Typed access to puzzle-wasm. Documents cross the boundary as JSON strings.
import init, * as wasm from '../../crates/puzzle-wasm/pkg/puzzle_wasm.js';
import type { Analysis, AssembleResult, GeneratorOptions, KnownBurrInfo, PuzzleDoc, SolveResult, StepReport, Target } from './types';

let ready: Promise<unknown> | null = null;

/** Loads the WASM module once; every other function needs it. */
export function initWasm(): Promise<unknown> {
  ready ??= init();
  return ready;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The validation error of a document (SPEC §2.1), or null when it is valid. */
export function checkDocument(doc: PuzzleDoc): string | null {
  try {
    wasm.checkDocument(JSON.stringify(doc));
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

export function defaultMaxStates(): number {
  return wasm.defaultMaxStates();
}

/** Solves the fixed voxels of a document; throws when they do not form a valid puzzle. */
export function solve(doc: PuzzleDoc, maxStates = defaultMaxStates()): SolveResult {
  return JSON.parse(wasm.solve(JSON.stringify(doc), maxStates));
}

export function analyze(doc: PuzzleDoc): Analysis {
  return JSON.parse(wasm.analyze(JSON.stringify(doc)));
}

export function burrTemplate(length: number): PuzzleDoc {
  return JSON.parse(wasm.burrTemplate(length));
}

export function knownBurrs(): KnownBurrInfo[] {
  return JSON.parse(wasm.knownBurrs());
}

export function knownBurr(key: string): PuzzleDoc {
  return JSON.parse(wasm.knownBurr(key));
}

/** The standard burr target of a document, or null when it is not a six-stick burr. */
export function burrTarget(doc: PuzzleDoc): Target | null {
  return JSON.parse(wasm.burrTarget(JSON.stringify(doc)));
}

export function defaultCheckStates(): number {
  return wasm.defaultCheckStates();
}

export interface GeneratorRun {
  /** Runs `maxChecks` more checks (at least one). */
  step(maxChecks: number): StepReport;
  free(): void;
}

/** Starts a generator run on a base (SPEC §4); throws when the base cannot be generated from. */
export function newGenerator(doc: PuzzleDoc, options: GeneratorOptions): GeneratorRun {
  const generator = new wasm.Generator(JSON.stringify(doc), JSON.stringify(options));
  return {
    step: (maxChecks) => JSON.parse(generator.step(maxChecks)),
    free: () => generator.free(),
  };
}

export function defaultMaxAssemblies(): number {
  return wasm.defaultMaxAssemblies();
}

/** Counts the assemblies of a document into its target and solves each one (SPEC §5); throws without a target. */
export function assemble(doc: PuzzleDoc, maxStates = defaultMaxStates(), maxAssemblies = defaultMaxAssemblies()): AssembleResult {
  return JSON.parse(wasm.assemble(JSON.stringify(doc), maxStates, maxAssemblies));
}

/** A problem of a BurrTools file, for the problem picker. */
export interface XmpuzzleProblem {
  index: number;
  name: string;
  /** Number of pieces, counting every copy. */
  pieces: number;
  solutions: number;
}

/** The problems of a `.xmpuzzle` file (gzip-compressed or plain XML); throws when it cannot be read. */
export function xmpuzzleProblems(bytes: Uint8Array): XmpuzzleProblem[] {
  return JSON.parse(wasm.xmpuzzleProblems(bytes));
}

export interface XmpuzzleImport {
  document: PuzzleDoc;
  /** What the import could not keep or had to decide (SPEC §2.3). */
  warnings: string[];
}

/**
 * Imports problem `problem` of a `.xmpuzzle` file (SPEC §2.3), named `fallbackName` when the file
 * names neither the puzzle nor the problem. Without a usable solution in the file, the assembler
 * places the pieces, which may take seconds: call it from a worker.
 */
export function importXmpuzzle(
  bytes: Uint8Array,
  problem: number,
  fallbackName: string,
  maxStates = defaultMaxStates(),
  maxAssemblies = defaultMaxAssemblies(),
): XmpuzzleImport {
  return JSON.parse(wasm.importXmpuzzle(bytes, problem, fallbackName, maxStates, maxAssemblies));
}

/** A document as a gzip-compressed `.xmpuzzle` file (SPEC §2.3). */
export function exportXmpuzzle(doc: PuzzleDoc): Uint8Array {
  return wasm.exportXmpuzzle(JSON.stringify(doc));
}

/** STL export options (SPEC §2.4), in millimetres. */
export interface StlOptions {
  /** Side of a voxel. */
  unit: number;
  /** Removed from every outer face of a piece. */
  clearance: number;
  /** Size of the 45° chamfer of the convex edges; 0 for none. */
  chamfer: number;
}

/** A zip with one binary STL per piece (SPEC §2.4); throws on invalid options. */
export function stlZip(doc: PuzzleDoc, options: StlOptions): Uint8Array {
  return wasm.stlZip(JSON.stringify(doc), JSON.stringify(options));
}

/** The STL file name of every piece, in piece order. */
export function stlFileNames(doc: PuzzleDoc): string[] {
  return JSON.parse(wasm.stlFileNames(JSON.stringify(doc)));
}

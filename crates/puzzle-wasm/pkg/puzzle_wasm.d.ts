/* tslint:disable */
/* eslint-disable */

/**
 * A generator run on a base document (SPEC §4), advanced by `step` so that a worker can report
 * progress and be stopped between steps.
 */
export class Generator {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `options_json` is a `GeneratorOptions`; missing fields take their default. Fails when the
     * base cannot be generated from, with the reason.
     */
    constructor(doc_json: string, options_json: string);
    /**
     * Runs `max_checks` more checks (at least one) and returns a `StepReport`.
     */
    step(max_checks: number): string;
}

/**
 * Shape checks of the fixed voxels of each piece of a document (SPEC §1.4, §7.4).
 */
export function analyze(doc_json: string): string;

/**
 * Counts the assemblies of the fixed voxels of a document's pieces into its target and solves
 * each one (SPEC §5), with at most `max_states` states per solve and `max_assemblies` distinct
 * assemblies. Pieces that, as placed, leave required cells empty (`holes`) or stick out of the
 * target (`outside`) are counted into their own shape instead (`fit_target`). Returns an
 * `AssembleResult` with `holes` and `outside`; errors when the document has no target.
 */
export function assemble(doc_json: string, max_states: number, max_assemblies: number): string;

/**
 * The standard burr target for a document (SPEC §5.1) as a `Target`, or `null` when the document
 * is not a six-stick burr.
 */
export function burrTarget(doc_json: string): string;

/**
 * The parametric burr template with sticks of length `length` (SPEC §8), as a document.
 */
export function burrTemplate(length: number): string;

/**
 * Parses and validates a document (SPEC §2.1); the error says what is wrong.
 */
export function checkDocument(doc_json: string): void;

/**
 * The default state cap of a generator check (SPEC §4).
 */
export function defaultCheckStates(): number;

/**
 * The default cap on the distinct assemblies of `assemble` (SPEC §5).
 */
export function defaultMaxAssemblies(): number;

/**
 * The default state cap of a solve (SPEC §3).
 */
export function defaultMaxStates(): number;

/**
 * A document as a gzip-compressed `.xmpuzzle` file (SPEC §2.3).
 */
export function exportXmpuzzle(doc_json: string): Uint8Array;

/**
 * Imports problem `problem` of a `.xmpuzzle` file (SPEC §2.3) as `{document, warnings}`.
 * `fallback_name` names the document when neither the file's comment nor the problem does (the
 * file name without its extension; "BurrTools puzzle" when blank). When the file has no usable
 * solution, our assembler (SPEC §5) places the pieces, with the same caps as `assemble`; it can
 * take long, so call this from a worker.
 */
export function importXmpuzzle(bytes: Uint8Array, problem: number, fallback_name: string, max_states: number, max_assemblies: number): string;

/**
 * A known burr as a document (SPEC §8).
 */
export function knownBurr(key: string): string;

/**
 * The known burrs offered as templates (SPEC §8), sorted by key.
 */
export function knownBurrs(): string;

/**
 * Solves the puzzle made of the fixed voxels of a document (SPEC §3), exploring at most
 * `max_states` states. Returns a `SolveResult`.
 */
export function solve(doc_json: string, max_states: number): string;

/**
 * The STL file name of every piece, in piece order, as a JSON array of strings: safe characters
 * only, unique ignoring case, ending in `.stl`.
 */
export function stlFileNames(doc_json: string): string;

/**
 * The binary STL of piece `piece_index` in its placed orientation (SPEC §2.4).
 */
export function stlPiece(doc_json: string, piece_index: number, options_json: string): Uint8Array;

/**
 * A zip with one binary STL per non-empty piece (SPEC §2.4), named as by `stlFileNames`.
 */
export function stlZip(doc_json: string, options_json: string): Uint8Array;

/**
 * The problems of a `.xmpuzzle` file (SPEC §2.3) as `[{index, name, pieces, solutions}]`.
 */
export function xmpuzzleProblems(bytes: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_generator_free: (a: number, b: number) => void;
    readonly analyze: (a: number, b: number) => [number, number, number, number];
    readonly assemble: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly burrTarget: (a: number, b: number) => [number, number, number, number];
    readonly burrTemplate: (a: number) => [number, number, number, number];
    readonly checkDocument: (a: number, b: number) => [number, number];
    readonly defaultCheckStates: () => number;
    readonly defaultMaxAssemblies: () => number;
    readonly defaultMaxStates: () => number;
    readonly exportXmpuzzle: (a: number, b: number) => [number, number, number, number];
    readonly generator_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly generator_step: (a: number, b: number) => [number, number];
    readonly importXmpuzzle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly knownBurr: (a: number, b: number) => [number, number, number, number];
    readonly knownBurrs: () => [number, number];
    readonly solve: (a: number, b: number, c: number) => [number, number, number, number];
    readonly stlFileNames: (a: number, b: number) => [number, number, number, number];
    readonly stlPiece: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly stlZip: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly xmpuzzleProblems: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

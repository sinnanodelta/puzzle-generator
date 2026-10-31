//! WebAssembly bindings of puzzle-core for the web app. Documents and results cross the boundary as
//! JSON strings; numbers are `f64` because JavaScript has no 64-bit integers.

use puzzle_core::stl::{self, StlOptions};
use puzzle_core::templates;
use puzzle_core::xmpuzzle;
use puzzle_core::{Document, GeneratorOptions, SolveOptions, enclosed_holes, is_connected, is_millable, is_notchable};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("results always serialize")
}

/// Parses and validates a document (SPEC §2.1); the error says what is wrong.
#[wasm_bindgen(js_name = checkDocument)]
pub fn check_document(doc_json: &str) -> Result<(), JsError> {
    Document::from_json(doc_json)?;
    Ok(())
}

/// The default state cap of a solve (SPEC §3).
#[wasm_bindgen(js_name = defaultMaxStates)]
pub fn default_max_states() -> f64 {
    puzzle_core::solver::DEFAULT_MAX_STATES as f64
}

/// Solves the puzzle made of the fixed voxels of a document (SPEC §3), exploring at most
/// `max_states` states. Returns a `SolveResult`.
#[wasm_bindgen]
pub fn solve(doc_json: &str, max_states: f64) -> Result<String, JsError> {
    let puzzle = Document::from_json(doc_json)?.to_puzzle()?;
    let options = SolveOptions { max_states: max_states as u64 };
    Ok(to_json(&puzzle_core::solve(&puzzle, &options)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PieceAnalysis {
    notchable: bool,
    millable: bool,
    connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Analysis {
    pieces: Vec<PieceAnalysis>,
    /// Fixed voxels of all pieces.
    voxels: usize,
    /// Empty cells closed in by the fixed voxels.
    holes: usize,
}

/// Shape checks of the fixed voxels of each piece of a document (SPEC §1.4, §7.4).
#[wasm_bindgen]
pub fn analyze(doc_json: &str) -> Result<String, JsError> {
    let doc = Document::from_json(doc_json)?;
    let fixed: Vec<Vec<_>> = doc.pieces.iter().map(|p| p.fixed.clone()).collect();
    let analysis = Analysis {
        pieces: fixed
            .iter()
            .map(|v| PieceAnalysis { notchable: is_notchable(v), millable: is_millable(v), connected: is_connected(v) })
            .collect(),
        voxels: fixed.iter().map(Vec::len).sum(),
        holes: enclosed_holes(&fixed),
    };
    Ok(to_json(&analysis))
}

/// The parametric burr template with sticks of length `length` (SPEC §8), as a document.
#[wasm_bindgen(js_name = burrTemplate)]
pub fn burr_template(length: i32) -> Result<String, JsError> {
    Ok(templates::burr_template(length)?.to_json())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownBurr {
    key: String,
    name: String,
    designer: Option<String>,
    stick_length: u32,
    level_string: String,
}

/// The known burrs offered as templates (SPEC §8), sorted by key.
#[wasm_bindgen(js_name = knownBurrs)]
pub fn known_burrs() -> String {
    let list: Vec<KnownBurr> = templates::known_burrs()
        .into_iter()
        .map(|(key, f)| KnownBurr {
            key,
            name: f.name,
            designer: f.designer,
            stick_length: f.stick_length,
            level_string: f.computed.level_string,
        })
        .collect();
    to_json(&list)
}

/// A known burr as a document (SPEC §8).
#[wasm_bindgen(js_name = knownBurr)]
pub fn known_burr(key: &str) -> Result<String, JsError> {
    Ok(templates::known_burr(key)?.to_json())
}

/// The standard burr target for a document (SPEC §5.1) as a `Target`, or `null` when the document
/// is not a six-stick burr.
#[wasm_bindgen(js_name = burrTarget)]
pub fn burr_target(doc_json: &str) -> Result<String, JsError> {
    Ok(to_json(&templates::burr_target(&Document::from_json(doc_json)?)))
}

/// The default state cap of a generator check (SPEC §4).
#[wasm_bindgen(js_name = defaultCheckStates)]
pub fn default_check_states() -> f64 {
    puzzle_core::generator::DEFAULT_CHECK_STATES as f64
}

/// The default cap on the distinct assemblies of `assemble` (SPEC §5).
#[wasm_bindgen(js_name = defaultMaxAssemblies)]
pub fn default_max_assemblies() -> f64 {
    puzzle_core::assembler::DEFAULT_MAX_ASSEMBLIES as f64
}

/// Counts the assemblies of the fixed voxels of a document's pieces into its target and solves
/// each one (SPEC §5), with at most `max_states` states per solve and `max_assemblies` distinct
/// assemblies. Returns an `AssembleResult`; errors when the document has no target.
#[wasm_bindgen]
pub fn assemble(doc_json: &str, max_states: f64, max_assemblies: f64) -> Result<String, JsError> {
    let doc = Document::from_json(doc_json)?;
    let target = doc.target.as_ref().ok_or_else(|| JsError::new("the document has no target"))?;
    let pieces: Vec<Vec<_>> = doc.pieces.iter().map(|p| p.fixed.clone()).collect();
    let options = puzzle_core::AssembleOptions { max_states: max_states as u64, max_assemblies: max_assemblies as u64 };
    Ok(to_json(&puzzle_core::assemble(&pieces, target, &options)?))
}

/// A generator run on a base document (SPEC §4), advanced by `step` so that a worker can report
/// progress and be stopped between steps.
#[wasm_bindgen]
pub struct Generator(puzzle_core::Generator);

#[wasm_bindgen]
impl Generator {
    /// `options_json` is a `GeneratorOptions`; missing fields take their default. Fails when the
    /// base cannot be generated from, with the reason.
    #[wasm_bindgen(constructor)]
    pub fn new(doc_json: &str, options_json: &str) -> Result<Generator, JsError> {
        let doc = Document::from_json(doc_json)?;
        let options: GeneratorOptions = serde_json::from_str(options_json)?;
        Ok(Self(puzzle_core::Generator::new(&doc, options)?))
    }

    /// Runs `max_checks` more checks (at least one) and returns a `StepReport`.
    pub fn step(&mut self, max_checks: f64) -> String {
        to_json(&self.0.step(max_checks as u64))
    }
}

/// The problems of a `.xmpuzzle` file (SPEC §2.3) as `[{index, name, pieces, solutions}]`.
#[wasm_bindgen(js_name = xmpuzzleProblems)]
pub fn xmpuzzle_problems(bytes: &[u8]) -> Result<String, JsError> {
    Ok(to_json(&xmpuzzle::list_problems(bytes)?))
}

/// Imports problem `problem` of a `.xmpuzzle` file (SPEC §2.3) as `{document, warnings}`.
/// `fallback_name` names the document when neither the file's comment nor the problem does (the
/// file name without its extension; "BurrTools puzzle" when blank). When the file has no usable
/// solution, our assembler (SPEC §5) places the pieces, with the same caps as `assemble`; it can
/// take long, so call this from a worker.
#[wasm_bindgen(js_name = importXmpuzzle)]
pub fn import_xmpuzzle(
    bytes: &[u8],
    problem: u32,
    fallback_name: &str,
    max_states: f64,
    max_assemblies: f64,
) -> Result<String, JsError> {
    let placed = match xmpuzzle::import(bytes, problem as usize, fallback_name)? {
        xmpuzzle::Import::Placed(placed) => placed,
        xmpuzzle::Import::Unplaced(unplaced) => {
            let options =
                puzzle_core::AssembleOptions { max_states: max_states as u64, max_assemblies: max_assemblies as u64 };
            xmpuzzle::place(&unplaced, &options)?
        }
    };
    Ok(to_json(&placed))
}

/// A document as a gzip-compressed `.xmpuzzle` file (SPEC §2.3).
#[wasm_bindgen(js_name = exportXmpuzzle)]
pub fn export_xmpuzzle(doc_json: &str) -> Result<Vec<u8>, JsError> {
    Ok(xmpuzzle::export(&Document::from_json(doc_json)?)?)
}

/// Parses STL options (SPEC §2.4): `{"unit": 10, "clearance": 0.1, "chamfer": 0.5}`.
fn stl_options(options_json: &str) -> Result<StlOptions, JsError> {
    serde_json::from_str(options_json).map_err(|e| JsError::new(&format!("invalid STL options: {e}")))
}

/// The binary STL of piece `piece_index` in its placed orientation (SPEC §2.4).
#[wasm_bindgen(js_name = stlPiece)]
pub fn stl_piece(doc_json: &str, piece_index: u32, options_json: &str) -> Result<Vec<u8>, JsError> {
    let doc = Document::from_json(doc_json)?;
    Ok(stl::piece_stl(&doc, piece_index as usize, &stl_options(options_json)?)?)
}

/// A zip with one binary STL per non-empty piece (SPEC §2.4), named as by `stlFileNames`.
#[wasm_bindgen(js_name = stlZip)]
pub fn stl_zip(doc_json: &str, options_json: &str) -> Result<Vec<u8>, JsError> {
    let doc = Document::from_json(doc_json)?;
    Ok(stl::stl_zip(&doc, &stl_options(options_json)?)?)
}

/// The STL file name of every piece, in piece order, as a JSON array of strings: safe characters
/// only, unique ignoring case, ending in `.stl`.
#[wasm_bindgen(js_name = stlFileNames)]
pub fn stl_file_names(doc_json: &str) -> Result<String, JsError> {
    Ok(to_json(&stl::stl_file_names(&Document::from_json(doc_json)?)))
}

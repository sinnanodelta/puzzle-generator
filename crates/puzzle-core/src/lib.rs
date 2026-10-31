//! Core of the puzzle generator: voxel puzzle model, disassembly solver, shape checks, canonical
//! keys, templates, generator, assembler, BurrTools import/export and STL export (SPEC.md §1–§5,
//! §8). Pure Rust with no WASM dependency, so tests and benchmarks run natively.

pub mod assembler;
pub mod canonical;
mod collision;
pub mod fixtures;
pub mod generator;
pub mod hash;
pub mod model;
pub mod rng;
pub mod shape;
pub mod solver;
pub mod stl;
pub mod templates;
pub mod xmpuzzle;

pub use assembler::{AssembleOptions, AssembleResult, AssembleStatus, all_optional, assemble};
pub use canonical::canonical_key;
pub use generator::{Entry, Generator, GeneratorError, GeneratorOptions, Score, StepReport};
pub use model::{Document, DocumentError, ModelError, Puzzle, Voxel};
pub use shape::{enclosed_holes, is_connected, is_millable, is_notchable, notch_closure};
pub use solver::{Dir, Move, Node, Solution, SolveOptions, SolveResult, Status, solve};

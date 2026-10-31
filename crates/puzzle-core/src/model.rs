//! Puzzle model (SPEC §1) and the native JSON document (SPEC §2.1).

use std::fmt;

use serde::{Deserialize, Serialize};

/// A cell of the assembly grid, as `[x, y, z]`.
pub type Voxel = [i32; 3];

/// Largest grid side, in cells.
pub const MAX_GRID: i32 = 32;
/// Largest number of pieces: groups of pieces are `u32` bitmasks.
pub const MAX_PIECES: usize = 32;

fn grid_ok(grid: [i32; 3]) -> bool {
    grid.iter().all(|g| (1..=MAX_GRID).contains(g))
}

fn in_grid(grid: [i32; 3], v: Voxel) -> bool {
    (0..3).all(|a| (0..grid[a]).contains(&v[a]))
}

pub(crate) fn cell_index(grid: [i32; 3], v: Voxel) -> usize {
    (v[0] + grid[0] * (v[1] + grid[1] * v[2])) as usize
}

/// An assembled puzzle: each piece is a set of cells of the shared grid, in its assembled position.
/// Voxels are sorted and deduplicated; pieces are non-empty, inside the grid and disjoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Puzzle {
    grid: [i32; 3],
    pieces: Vec<Vec<Voxel>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelError {
    GridSize([i32; 3]),
    PieceCount(usize),
    EmptyPiece(usize),
    OutOfGrid { piece: usize, voxel: Voxel },
    Overlap { voxel: Voxel, pieces: [usize; 2] },
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GridSize(g) => write!(f, "grid {g:?} must be 1..={MAX_GRID} cells per side"),
            Self::PieceCount(n) => write!(f, "{n} pieces, expected 2..={MAX_PIECES}"),
            Self::EmptyPiece(p) => write!(f, "piece {p} has no voxel"),
            Self::OutOfGrid { piece, voxel } => write!(f, "piece {piece}: voxel {voxel:?} is outside the grid"),
            Self::Overlap { voxel, pieces: [a, b] } => write!(f, "pieces {a} and {b} both fill {voxel:?}"),
        }
    }
}

impl std::error::Error for ModelError {}

impl Puzzle {
    pub fn new(grid: [i32; 3], mut pieces: Vec<Vec<Voxel>>) -> Result<Self, ModelError> {
        if !grid_ok(grid) {
            return Err(ModelError::GridSize(grid));
        }
        if !(2..=MAX_PIECES).contains(&pieces.len()) {
            return Err(ModelError::PieceCount(pieces.len()));
        }
        let mut owner = vec![usize::MAX; (grid[0] * grid[1] * grid[2]) as usize];
        for (p, voxels) in pieces.iter_mut().enumerate() {
            voxels.sort_unstable();
            voxels.dedup();
            if voxels.is_empty() {
                return Err(ModelError::EmptyPiece(p));
            }
            for &v in voxels.iter() {
                if !in_grid(grid, v) {
                    return Err(ModelError::OutOfGrid { piece: p, voxel: v });
                }
                let cell = &mut owner[cell_index(grid, v)];
                if *cell != usize::MAX {
                    return Err(ModelError::Overlap { voxel: v, pieces: [*cell, p] });
                }
                *cell = p;
            }
        }
        Ok(Self { grid, pieces })
    }

    pub fn grid(&self) -> [i32; 3] {
        self.grid
    }

    pub fn pieces(&self) -> &[Vec<Voxel>] {
        &self.pieces
    }
}

pub const FORMAT: &str = "puzzle-generator";
pub const VERSION: u32 = 1;

/// The native JSON document (SPEC §2.1): the editor's view of a puzzle, with optional cells,
/// target and metadata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub format: String,
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub grid: [i32; 3],
    pub pieces: Vec<DocumentPiece>,
    /// `None` when no target is painted, which disables the uniqueness check.
    #[serde(default)]
    pub target: Option<Target>,
    #[serde(default)]
    pub meta: Meta,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentPiece {
    pub id: String,
    pub name: String,
    pub color: String,
    /// "Must stay notchable" (SPEC §1.4).
    #[serde(default)]
    pub notchable: bool,
    pub fixed: Vec<Voxel>,
    #[serde(default)]
    pub optional: Vec<Voxel>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub required: Vec<Voxel>,
    #[serde(default)]
    pub variable: Vec<Voxel>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub designer: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
}

#[derive(Debug)]
pub enum DocumentError {
    Json(serde_json::Error),
    Format(String),
    Version(u32),
    GridSize([i32; 3]),
    OutOfGrid { piece: usize, voxel: Voxel },
    TargetOutOfGrid(Voxel),
    FixedTwice { voxel: Voxel, pieces: [usize; 2] },
    FixedAndOptional { voxel: Voxel, fixed: usize, optional: usize },
}

impl fmt::Display for DocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(e) => write!(f, "invalid JSON: {e}"),
            Self::Format(s) => write!(f, "format is {s:?}, expected {FORMAT:?}"),
            Self::Version(v) => write!(f, "unsupported version {v}, expected {VERSION}"),
            Self::GridSize(g) => write!(f, "grid {g:?} must be 1..={MAX_GRID} cells per side"),
            Self::OutOfGrid { piece, voxel } => write!(f, "piece {piece}: cell {voxel:?} is outside the grid"),
            Self::TargetOutOfGrid(v) => write!(f, "target cell {v:?} is outside the grid"),
            Self::FixedTwice { voxel, pieces: [a, b] } => write!(f, "cell {voxel:?} is fixed for pieces {a} and {b}"),
            Self::FixedAndOptional { voxel, fixed, optional } => {
                write!(f, "cell {voxel:?} is fixed for piece {fixed} and optional for piece {optional}")
            }
        }
    }
}

impl std::error::Error for DocumentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl Document {
    /// Parses and validates a document.
    pub fn from_json(json: &str) -> Result<Self, DocumentError> {
        let doc: Self = serde_json::from_str(json).map_err(DocumentError::Json)?;
        doc.validate()?;
        Ok(doc)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("a document always serializes")
    }

    /// Checks the rules of SPEC §1.3 and §2.1. Piece counts are not checked: the editor may save a
    /// puzzle that is still being built.
    pub fn validate(&self) -> Result<(), DocumentError> {
        if self.format != FORMAT {
            return Err(DocumentError::Format(self.format.clone()));
        }
        if self.version != VERSION {
            return Err(DocumentError::Version(self.version));
        }
        if !grid_ok(self.grid) {
            return Err(DocumentError::GridSize(self.grid));
        }
        let grid = self.grid;
        let mut fixed_by = vec![usize::MAX; (grid[0] * grid[1] * grid[2]) as usize];
        for (p, piece) in self.pieces.iter().enumerate() {
            for &v in piece.fixed.iter().chain(&piece.optional) {
                if !in_grid(grid, v) {
                    return Err(DocumentError::OutOfGrid { piece: p, voxel: v });
                }
            }
            for &v in &piece.fixed {
                let cell = &mut fixed_by[cell_index(grid, v)];
                if *cell != usize::MAX && *cell != p {
                    return Err(DocumentError::FixedTwice { voxel: v, pieces: [*cell, p] });
                }
                *cell = p;
            }
        }
        for (p, piece) in self.pieces.iter().enumerate() {
            for &v in &piece.optional {
                let owner = fixed_by[cell_index(grid, v)];
                if owner != usize::MAX && owner != p {
                    return Err(DocumentError::FixedAndOptional { voxel: v, fixed: owner, optional: p });
                }
            }
        }
        if let Some(target) = &self.target
            && let Some(&v) = target.required.iter().chain(&target.variable).find(|&&v| !in_grid(grid, v))
        {
            return Err(DocumentError::TargetOutOfGrid(v));
        }
        Ok(())
    }

    /// The puzzle made of the fixed voxels, as the solver and the live check see it.
    pub fn to_puzzle(&self) -> Result<Puzzle, ModelError> {
        Puzzle::new(self.grid, self.pieces.iter().map(|p| p.fixed.clone()).collect())
    }
}

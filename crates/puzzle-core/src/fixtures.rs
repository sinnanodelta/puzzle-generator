//! Reader for `fixtures/burrs.json`: known puzzles with their BurrTools results (SPEC Appendix A).

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::model::{ModelError, Puzzle, Voxel};

/// `fixtures/burrs.json`, built in: the known burrs offered as templates (SPEC §8).
pub const KNOWN_BURRS: &str = include_str!("../../../fixtures/burrs.json");

#[derive(Clone, Debug, Deserialize)]
pub struct Fixture {
    pub name: String,
    pub designer: Option<String>,
    pub source_url: Option<String>,
    pub stick_length: u32,
    pub grid: [i32; 3],
    pub pieces: Vec<FixturePiece>,
    pub computed: FixtureComputed,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FixturePiece {
    pub name: String,
    pub label: Option<String>,
    pub voxels: Vec<Voxel>,
}

/// Values computed by BurrTools.
#[derive(Clone, Debug, Deserialize)]
pub struct FixtureComputed {
    pub level_string: String,
    pub first_split_moves: u32,
    pub total_moves: u32,
    pub unique: Option<bool>,
    pub assemblies: Option<u32>,
    pub solutions: Option<u32>,
    /// Assemblies and solutions with every target cell optional (SPEC §5).
    pub assemblies_all_optional: Option<u32>,
    pub solutions_all_optional: Option<u32>,
    /// Order of the rotation group of the target.
    pub symmetry_group_order: Option<u32>,
    /// Empty cells closed in by the assembly.
    pub holes: Option<u32>,
}

/// Fixtures by key, in key order. Unknown fields are ignored.
pub fn parse_fixtures(json: &str) -> serde_json::Result<BTreeMap<String, Fixture>> {
    serde_json::from_str(json)
}

impl Fixture {
    pub fn puzzle(&self) -> Result<Puzzle, ModelError> {
        Puzzle::new(self.grid, self.pieces.iter().map(|p| p.voxels.clone()).collect())
    }
}

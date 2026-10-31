//! Starting documents (SPEC §8): the parametric six-piece burr and the known burrs of
//! `fixtures/burrs.json`, each with the standard burr target (SPEC §5.1).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use crate::fixtures::{Fixture, KNOWN_BURRS, parse_fixtures};
use crate::model::{Document, DocumentPiece, FORMAT, MAX_GRID, Meta, Target, VERSION, Voxel};
use crate::shape::{bounds, cells};

/// Piece colours, by piece index (cycled).
pub const PALETTE: [&str; 12] = [
    "#e6194b", "#4363d8", "#3cb44b", "#f58231", "#911eb4", "#ffe119", "#42d4f4", "#f032e6", "#bfef45", "#469990",
    "#9a6324", "#fabed4",
];

pub fn piece_color(index: usize) -> &'static str {
    PALETTE[index % PALETTE.len()]
}

/// A box of cells, as (min, max) inclusive.
pub type Cuboid = (Voxel, Voxel);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TemplateError {
    StickLength(i32),
    UnknownBurr(String),
}

impl fmt::Display for TemplateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StickLength(l) => write!(f, "stick length {l} must be even and in 6..={MAX_GRID}"),
            Self::UnknownBurr(key) => write!(f, "no known burr {key:?}"),
        }
    }
}

impl std::error::Error for TemplateError {}

/// The six 2×2×L stick envelopes of the standard burr layout (SPEC A.1), in the order X1, X2, Y1,
/// Y2, Z1, Z2. A stick along axis a spans the grid along a, the two central cells along the next
/// axis (a + 1) and one half of the central four cells along the axis after (a + 2).
pub fn standard_envelopes(length: i32) -> [Cuboid; 6] {
    let o = (length - 4) / 2;
    std::array::from_fn(|i| {
        let (axis, half) = (i / 2, (i % 2) as i32);
        let (common, split) = ((axis + 1) % 3, (axis + 2) % 3);
        let (mut lo, mut hi) = ([0; 3], [0; 3]);
        (lo[axis], hi[axis]) = (0, length - 1);
        (lo[common], hi[common]) = (o + 1, o + 2);
        (lo[split], hi[split]) = (o + 2 * half, o + 2 * half + 1);
        (lo, hi)
    })
}

/// How many envelopes cover each cell.
fn coverage(envelopes: &[Cuboid]) -> HashMap<Voxel, usize> {
    let mut count = HashMap::new();
    for &envelope in envelopes {
        for v in cells(envelope) {
            *count.entry(v).or_insert(0) += 1;
        }
    }
    count
}

/// The target of an assembly of sticks (SPEC §5.1): the cells covered by one envelope are
/// required, the cells shared by several are variable. Sorted.
pub fn envelope_target(envelopes: &[Cuboid]) -> Target {
    let (mut required, mut variable) = (Vec::new(), Vec::new());
    for (v, n) in coverage(envelopes) {
        if n == 1 { required.push(v) } else { variable.push(v) }
    }
    required.sort_unstable();
    variable.sort_unstable();
    Target { required, variable }
}

fn new_document(name: String, grid: [i32; 3], pieces: Vec<DocumentPiece>, target: Target, meta: Meta) -> Document {
    Document {
        format: FORMAT.to_string(),
        version: VERSION,
        name,
        description: String::new(),
        grid,
        pieces,
        target: Some(target),
        meta,
    }
}

/// The parametric burr (SPEC §8): six 2×2×L sticks in the standard layout. Each cell of a single
/// envelope is fixed for its stick; each shared cell is optional for every stick sharing it.
pub fn burr_template(length: i32) -> Result<Document, TemplateError> {
    if !(6..=MAX_GRID).contains(&length) || length % 2 != 0 {
        return Err(TemplateError::StickLength(length));
    }
    let envelopes = standard_envelopes(length);
    let count = coverage(&envelopes);
    let pieces = envelopes
        .iter()
        .enumerate()
        .map(|(i, &envelope)| {
            let (mut fixed, mut optional): (Vec<Voxel>, Vec<Voxel>) = cells(envelope).partition(|v| count[v] == 1);
            fixed.sort_unstable();
            optional.sort_unstable();
            DocumentPiece {
                id: format!("p{i}"),
                name: format!("{}{}", ["X", "Y", "Z"][i / 2], i % 2 + 1),
                color: piece_color(i).to_string(),
                notchable: false,
                fixed,
                optional,
            }
        })
        .collect();
    let meta = Meta { source: "template".to_string(), ..Meta::default() };
    Ok(new_document(format!("Burr {length}"), [length; 3], pieces, envelope_target(&envelopes), meta))
}

/// The known burrs of `fixtures/burrs.json`, by key.
pub fn known_burrs() -> BTreeMap<String, Fixture> {
    parse_fixtures(KNOWN_BURRS).expect("the built-in fixtures parse")
}

pub fn known_burr(key: &str) -> Result<Document, TemplateError> {
    known_burrs().get(key).map(fixture_document).ok_or_else(|| TemplateError::UnknownBurr(key.to_string()))
}

/// A known burr as a document (SPEC §8): its cells are fixed, and the empty cells of each stick's
/// envelope (the bounding box of the piece) are optional for that stick. The target is the
/// standard burr target of these envelopes, so both chiralities of the layout work.
pub fn fixture_document(fixture: &Fixture) -> Document {
    let envelopes: Vec<Cuboid> =
        fixture.pieces.iter().map(|p| bounds(&p.voxels).expect("fixture pieces are not empty")).collect();
    let filled: HashSet<Voxel> = fixture.pieces.iter().flat_map(|p| p.voxels.iter().copied()).collect();
    let pieces = fixture
        .pieces
        .iter()
        .zip(&envelopes)
        .enumerate()
        .map(|(i, (piece, &envelope))| {
            let mut fixed = piece.voxels.clone();
            fixed.sort_unstable();
            let mut optional: Vec<Voxel> = cells(envelope).filter(|v| !filled.contains(v)).collect();
            optional.sort_unstable();
            DocumentPiece {
                id: format!("p{i}"),
                name: piece.label.clone().unwrap_or_else(|| piece.name.clone()),
                color: piece_color(i).to_string(),
                notchable: false,
                fixed,
                optional,
            }
        })
        .collect();
    let meta = Meta {
        designer: fixture.designer.clone().unwrap_or_default(),
        source: fixture.source_url.clone().unwrap_or_else(|| "fixtures/burrs.json".to_string()),
        ..Meta::default()
    };
    new_document(fixture.name.clone(), fixture.grid, pieces, envelope_target(&envelopes), meta)
}

/// The standard burr target for a document (SPEC §5.1): from the pieces' envelopes when there are
/// six pieces whose cells (fixed and optional) span 2×2×L sticks, else from the standard layout of
/// a cubic grid of even side L ≥ 6. `None` when neither applies.
pub fn burr_target(doc: &Document) -> Option<Target> {
    let envelopes: Option<Vec<Cuboid>> = doc
        .pieces
        .iter()
        .map(|p| {
            let all: Vec<Voxel> = p.fixed.iter().chain(&p.optional).copied().collect();
            let (lo, hi) = bounds(&all)?;
            let mut sides = [0, 1, 2].map(|a| hi[a] - lo[a] + 1);
            sides.sort_unstable();
            (sides[0] == 2 && sides[1] == 2 && sides[2] >= 6).then_some((lo, hi))
        })
        .collect();
    match envelopes {
        Some(envelopes) if envelopes.len() == 6 => Some(envelope_target(&envelopes)),
        _ => {
            let [l, ly, lz] = doc.grid;
            (l == ly && l == lz && l >= 6 && l % 2 == 0).then(|| envelope_target(&standard_envelopes(l)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shape::{enclosed_holes, is_connected};

    fn required_cells(length: i32) -> usize {
        (24 * (length - 4) + 24) as usize
    }

    #[test]
    fn burr_template_counts() {
        for (length, fixed) in [(6, 12), (8, 20), (10, 28)] {
            let doc = burr_template(length).unwrap();
            doc.validate().unwrap();
            assert_eq!(Document::from_json(&doc.to_json()).unwrap(), doc);
            assert_eq!(doc.grid, [length; 3]);
            let names: Vec<&str> = doc.pieces.iter().map(|p| p.name.as_str()).collect();
            assert_eq!(names, ["X1", "X2", "Y1", "Y2", "Z1", "Z2"]);
            // Each stick has Rob's 12 removable cubies (SPEC §8) as optional cells.
            for piece in &doc.pieces {
                assert_eq!((piece.fixed.len(), piece.optional.len()), (fixed, 12), "L={length} {}", piece.name);
            }
            let shared: HashSet<Voxel> = doc.pieces.iter().flat_map(|p| p.optional.iter().copied()).collect();
            let target = doc.target.as_ref().unwrap();
            assert_eq!(shared.len(), 32);
            assert_eq!((target.required.len(), target.variable.len()), (required_cells(length), 32));
            assert!(target.variable.iter().all(|v| shared.contains(v)));
            doc.to_puzzle().unwrap();
        }
    }

    #[test]
    fn burr_template_rejects_bad_lengths() {
        for length in [-2, 0, 4, 5, 7, 34] {
            assert_eq!(burr_template(length), Err(TemplateError::StickLength(length)));
        }
        assert!(burr_template(32).is_ok());
    }

    #[test]
    fn standard_envelopes_match_the_layout() {
        // SPEC A.1 for L = 8 (o = 2): the X sticks share y ∈ {3, 4} and split z into {2, 3} / {4, 5}.
        let e = standard_envelopes(8);
        assert_eq!(e[0], ([0, 3, 2], [7, 4, 3]));
        assert_eq!(e[1], ([0, 3, 4], [7, 4, 5]));
        assert_eq!(e[2], ([2, 0, 3], [3, 7, 4]));
        assert_eq!(e[5], ([3, 4, 0], [4, 5, 7]));
    }

    #[test]
    fn known_burrs_become_documents() {
        let fixtures = known_burrs();
        assert_eq!(fixtures.len(), 12);
        for (key, fixture) in &fixtures {
            let doc = known_burr(key).unwrap();
            doc.validate().unwrap_or_else(|e| panic!("{key}: {e}"));
            assert_eq!(doc.to_puzzle().unwrap(), fixture.puzzle().unwrap(), "{key}");
            let filled: HashSet<Voxel> = doc.pieces.iter().flat_map(|p| p.fixed.iter().copied()).collect();
            for (piece, fixture_piece) in doc.pieces.iter().zip(&fixture.pieces) {
                let (lo, hi) = bounds(&fixture_piece.voxels).unwrap();
                assert!(piece.optional.iter().all(|v| !filled.contains(v)), "{key}");
                assert!(piece.optional.iter().all(|v| (0..3).all(|a| (lo[a]..=hi[a]).contains(&v[a]))), "{key}");
                assert!(is_connected(&piece.fixed), "{key} {}", piece.name);
            }
            let target = doc.target.as_ref().unwrap();
            let length = fixture.stick_length as i32;
            assert_eq!((target.required.len(), target.variable.len()), (required_cells(length), 32), "{key}");
            assert_eq!(burr_target(&doc).as_ref(), Some(target), "{key}");
            let pieces: Vec<Vec<Voxel>> = fixture.pieces.iter().map(|p| p.voxels.clone()).collect();
            assert_eq!(Some(enclosed_holes(&pieces) as u32), fixture.computed.holes, "{key}");
        }
        assert_eq!(known_burr("nope"), Err(TemplateError::UnknownBurr("nope".to_string())));
    }

    #[test]
    fn burr_target_falls_back_to_the_grid() {
        let mut doc = burr_template(8).unwrap();
        let target = doc.target.take().unwrap();
        assert_eq!(burr_target(&doc), Some(target.clone()));
        doc.pieces.truncate(5);
        assert_eq!(burr_target(&doc), Some(target));
        doc.grid = [8, 8, 9];
        assert_eq!(burr_target(&doc), None);
    }
}

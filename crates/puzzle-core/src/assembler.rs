//! Assembler (SPEC §5): every way to pack the pieces into a target, counted with identical pieces
//! interchangeable and up to the rotations of the target, and which of these assemblies the solver
//! takes apart.
//!
//! The packings are the exact covers of a matrix with one row per placement of a piece (Knuth's
//! Algorithm X with dancing links): the required cells and the pieces are primary columns, the
//! variable cells secondary ones.

use std::collections::BTreeSet;
use std::ops::Range;

use serde::Serialize;

use crate::canonical::rotations;
use crate::hash::FxHashMap;
use crate::model::{MAX_GRID, MAX_PIECES, ModelError, Puzzle, Target, Voxel};
use crate::shape;
use crate::solver::{DEFAULT_MAX_STATES, SolveOptions, Status, solve};

/// Default cap on the distinct assemblies.
pub const DEFAULT_MAX_ASSEMBLIES: u64 = 10_000;

/// No cell, placement or row.
const NONE: u32 = u32::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssembleOptions {
    /// State cap of the solve of each assembly (SPEC §3).
    pub max_states: u64,
    /// Cap on the distinct assemblies: finding one more aborts the count.
    pub max_assemblies: u64,
}

impl Default for AssembleOptions {
    fn default() -> Self {
        Self { max_states: DEFAULT_MAX_STATES, max_assemblies: DEFAULT_MAX_ASSEMBLIES }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssembleStatus {
    /// Every assembly was found.
    Complete,
    /// The assembly cap was reached first: the counts are lower bounds.
    Aborted,
}

/// The assemblies of a puzzle (SPEC §5). Serialized with camelCase field names, for the web app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleResult {
    pub status: AssembleStatus,
    /// M: the distinct assemblies.
    pub assemblies: u64,
    /// N: the assemblies the solver takes apart.
    pub solutions: u64,
    /// Assemblies whose solve reached the state cap: counted in M but not in N.
    pub undecided: u64,
    /// Exactly one disassemblable assembly: N = 1, with a complete count and no undecided solve.
    pub unique: bool,
    /// Order of the rotation group of the target.
    pub symmetry_order: u32,
    /// The first disassemblable assembly, in a fixed order: the pieces in input order, each placed
    /// in target coordinates (sorted voxels).
    pub first_solution: Option<Vec<Vec<Voxel>>>,
}

impl AssembleResult {
    fn none(symmetry_order: u32) -> Self {
        Self {
            status: AssembleStatus::Complete,
            assemblies: 0,
            solutions: 0,
            undecided: 0,
            unique: false,
            symmetry_order,
            first_solution: None,
        }
    }
}

/// The target with every cell variable: the pieces may leave any cell empty.
pub fn all_optional(target: &Target) -> Target {
    let mut variable: Vec<Voxel> = target.required.iter().chain(&target.variable).copied().collect();
    variable.sort_unstable();
    variable.dedup();
    Target { required: Vec::new(), variable }
}

/// Counts the assemblies of `pieces` (any position and orientation) into `target` (SPEC §5) and
/// solves each one (SPEC §3) to find the disassemblable ones.
///
/// - Each piece is placed in its 24 rotations (no mirrors) at every translation inside the target.
/// - Pieces that are the same up to rotation are interchangeable.
/// - Assemblies related by a symmetry of the target count once. A symmetry is a rotation that maps
///   the required cells onto the required cells and the variable cells onto the variable cells.
/// - A cell listed both as required and as variable is required.
/// - Each assembly is solved in the bounding box of the target.
///
/// Errors on fewer than 2 or more than `MAX_PIECES` pieces, an empty piece, or a target whose
/// bounding box exceeds `MAX_GRID` cells per side. An empty target has no assembly.
pub fn assemble(
    pieces: &[Vec<Voxel>],
    target: &Target,
    options: &AssembleOptions,
) -> Result<AssembleResult, ModelError> {
    if !(2..=MAX_PIECES).contains(&pieces.len()) {
        return Err(ModelError::PieceCount(pieces.len()));
    }
    // The rotations of each piece, or `None` when it cannot fit in any target.
    let mut shapes = Vec::with_capacity(pieces.len());
    for (p, voxels) in pieces.iter().enumerate() {
        let (lo, hi) = shape::bounds(voxels).ok_or(ModelError::EmptyPiece(p))?;
        let fits = (0..3).all(|a| i64::from(hi[a]) - i64::from(lo[a]) < i64::from(MAX_GRID));
        shapes.push(fits.then(|| orientations(&normalized(voxels.clone()))));
    }
    let Some(target) = TargetCells::new(target)? else {
        return Ok(AssembleResult::none(24));
    };
    let group = symmetries(&target);
    let mut result = AssembleResult::none(group.len() as u32);
    let Some(shapes) = shapes.into_iter().collect::<Option<Vec<_>>>() else {
        return Ok(result);
    };
    let volume: usize = shapes.iter().map(|rotations| rotations[0].len()).sum();
    if volume < target.required || volume > target.cells.len() {
        return Ok(result);
    }

    // Kinds of pieces (the same up to rotation), in order of first appearance. The pieces sorted by
    // kind are the piece columns ("copies"), so the copies of a kind are contiguous.
    let mut kinds: Vec<&Vec<Vec<Voxel>>> = Vec::new();
    let kind_of: Vec<usize> = shapes
        .iter()
        .map(|s| {
            kinds.iter().position(|k| k[0] == s[0]).unwrap_or_else(|| {
                kinds.push(s);
                kinds.len() - 1
            })
        })
        .collect();
    let mut copies: Vec<usize> = (0..pieces.len()).collect();
    copies.sort_by_key(|&p| kind_of[p]);
    let same_kind: Vec<Range<usize>> = copies
        .iter()
        .map(|&p| {
            let start = copies.iter().position(|&q| kind_of[q] == kind_of[p]).unwrap_or(0);
            start..start + kind_of.iter().filter(|&&k| k == kind_of[p]).count()
        })
        .collect();

    let placements = Placements::new(&kinds, &target);
    // Each symmetry as a permutation of the placements.
    let images: Vec<Vec<u32>> = group
        .iter()
        .map(|g| {
            placements
                .cells
                .iter()
                .zip(&placements.kind)
                .map(|(cells, &k)| {
                    let mut image: Vec<u32> = cells.iter().map(|&c| g[c as usize]).collect();
                    image.sort_unstable();
                    *placements.lookup[k].get(&image).expect("a symmetry of the target maps placements to placements")
                })
                .collect()
        })
        .collect();

    let (required, variable) = (target.required, target.cells.len() - target.required);
    let mut links = Links::new(required + copies.len(), variable);
    let cell_column = |c: u32| if (c as usize) < required { c as usize } else { c as usize + copies.len() };
    let mut rows = Vec::new();
    for (copy, &piece) in copies.iter().enumerate() {
        for p in placements.ranges[kind_of[piece]].clone() {
            let columns: Vec<usize> = std::iter::once(required + copy)
                .chain(placements.cells[p as usize].iter().map(|&c| cell_column(c)))
                .collect();
            links.add_row(rows.len(), &columns);
            rows.push((copy, p));
        }
    }
    let mut search = Search {
        links,
        rows,
        same_kind,
        assigned: vec![NONE; copies.len()],
        images: &images,
        found: BTreeSet::new(),
        max_assemblies: options.max_assemblies,
        aborted: false,
    };
    search.run();
    if search.aborted {
        result.status = AssembleStatus::Aborted;
    }
    result.assemblies = search.found.len() as u64;

    let solve_options = SolveOptions { max_states: options.max_states };
    for assembly in &search.found {
        // The sorted placements group by kind in kind order, like the copies.
        let mut placed = vec![Vec::new(); pieces.len()];
        for (&piece, &p) in copies.iter().zip(assembly) {
            placed[piece] = placements.cells[p as usize].iter().map(|&c| target.cells[c as usize]).collect();
        }
        let puzzle = Puzzle::new(target.size, placed)?;
        match solve(&puzzle, &solve_options).status {
            Status::Solved => {
                result.solutions += 1;
                if result.first_solution.is_none() {
                    let origin = target.origin;
                    let moved =
                        puzzle.pieces().iter().map(|p| p.iter().map(|v| [0, 1, 2].map(|a| v[a] + origin[a])).collect());
                    result.first_solution = Some(moved.collect());
                }
            }
            Status::Unsolvable => {}
            Status::Aborted => result.undecided += 1,
        }
    }
    result.unique = result.status == AssembleStatus::Complete && result.solutions == 1 && result.undecided == 0;
    Ok(result)
}

/// The piece moved to the origin, sorted and deduplicated. Its extent must fit in an `i32`.
fn normalized(mut voxels: Vec<Voxel>) -> Vec<Voxel> {
    let lo = [0, 1, 2].map(|a| voxels.iter().map(|v| v[a]).min().unwrap_or(0));
    for v in &mut voxels {
        *v = [0, 1, 2].map(|a| v[a] - lo[a]);
    }
    voxels.sort_unstable();
    voxels.dedup();
    voxels
}

/// The distinct rotations of a piece, each moved to the origin, sorted: the first one is the same
/// for every rotation of the piece.
fn orientations(piece: &[Voxel]) -> Vec<Vec<Voxel>> {
    let mut all: Vec<Vec<Voxel>> = rotations()
        .map(|(perm, signs)| normalized(piece.iter().map(|v| [0, 1, 2].map(|a| signs[a] * v[perm[a]])).collect()))
        .collect();
    all.sort_unstable();
    all.dedup();
    all
}

/// The target cells, required first, in local coordinates: from the corner of their bounding box.
struct TargetCells {
    /// The corner of the bounding box, in target coordinates.
    origin: Voxel,
    size: [i32; 3],
    cells: Vec<Voxel>,
    /// The first `required` cells are required, the others variable.
    required: usize,
    /// The cell at each point of the bounding box (x fastest), or `NONE`.
    index: Vec<u32>,
}

impl TargetCells {
    /// `None` for an empty target.
    fn new(target: &Target) -> Result<Option<Self>, ModelError> {
        let mut required = target.required.clone();
        required.sort_unstable();
        required.dedup();
        let mut variable: Vec<Voxel> =
            target.variable.iter().filter(|v| required.binary_search(v).is_err()).copied().collect();
        variable.sort_unstable();
        variable.dedup();
        let all = [required.as_slice(), variable.as_slice()].concat();
        let Some((lo, hi)) = shape::bounds(&all) else { return Ok(None) };
        let sides = [0, 1, 2].map(|a| i64::from(hi[a]) - i64::from(lo[a]) + 1);
        if sides.iter().any(|&s| s > i64::from(MAX_GRID)) {
            return Err(ModelError::GridSize(sides.map(|s| s.min(i64::from(i32::MAX)) as i32)));
        }
        let size = sides.map(|s| s as i32);
        let cells: Vec<Voxel> = all.iter().map(|v| [0, 1, 2].map(|a| v[a] - lo[a])).collect();
        let mut index = vec![NONE; (size[0] * size[1] * size[2]) as usize];
        for (i, v) in cells.iter().enumerate() {
            index[(v[0] + size[0] * (v[1] + size[1] * v[2])) as usize] = i as u32;
        }
        Ok(Some(Self { origin: lo, size, cells, required: required.len(), index }))
    }

    /// The cell at a point in local coordinates.
    fn find(&self, v: Voxel) -> Option<u32> {
        if (0..3).any(|a| !(0..self.size[a]).contains(&v[a])) {
            return None;
        }
        let i = self.index[(v[0] + self.size[0] * (v[1] + self.size[1] * v[2])) as usize];
        (i != NONE).then_some(i)
    }
}

/// The rotations mapping the target onto itself, required cells onto required cells and variable
/// cells onto variable cells, each as a permutation of the cells. The identity comes first.
fn symmetries(target: &TargetCells) -> Vec<Vec<u32>> {
    rotations()
        .filter_map(|(perm, signs)| {
            let rotated: Vec<Voxel> = target.cells.iter().map(|v| [0, 1, 2].map(|a| signs[a] * v[perm[a]])).collect();
            let lo = [0, 1, 2].map(|a| rotated.iter().map(|v| v[a]).min().unwrap_or(0));
            rotated
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    let j = target.find([0, 1, 2].map(|a| v[a] - lo[a]))?;
                    ((i < target.required) == ((j as usize) < target.required)).then_some(j)
                })
                .collect()
        })
        .collect()
}

/// The placements of each kind of piece in the target.
struct Placements {
    /// The cells of each placement, sorted. The placements of a kind are contiguous, in kind order.
    cells: Vec<Vec<u32>>,
    /// The kind of each placement.
    kind: Vec<usize>,
    /// The placements of each kind.
    ranges: Vec<Range<u32>>,
    /// The placement of each set of cells, for each kind.
    lookup: Vec<FxHashMap<Vec<u32>, u32>>,
}

impl Placements {
    /// `kinds` holds the distinct rotations of each kind, at the origin.
    fn new(kinds: &[&Vec<Vec<Voxel>>], target: &TargetCells) -> Self {
        let mut this = Self { cells: Vec::new(), kind: Vec::new(), ranges: Vec::new(), lookup: Vec::new() };
        for (k, rotations) in kinds.iter().enumerate() {
            let start = this.cells.len() as u32;
            let mut lookup = FxHashMap::default();
            for piece in rotations.iter() {
                let last = [0, 1, 2].map(|a| target.size[a] - 1 - piece.iter().map(|v| v[a]).max().unwrap_or(0));
                if last.iter().any(|&t| t < 0) {
                    continue;
                }
                for t in shape::cells(([0; 3], last)) {
                    let placed: Option<Vec<u32>> =
                        piece.iter().map(|v| target.find([0, 1, 2].map(|a| v[a] + t[a]))).collect();
                    let Some(mut placed) = placed else { continue };
                    placed.sort_unstable();
                    lookup.entry(placed.clone()).or_insert_with(|| {
                        this.cells.push(placed);
                        this.kind.push(k);
                        (this.cells.len() - 1) as u32
                    });
                }
            }
            this.ranges.push(start..this.cells.len() as u32);
            this.lookup.push(lookup);
        }
        this
    }
}

/// Dancing links (Knuth, "Dancing Links", 2000). Node 0 is the root and nodes `1..=columns` are the
/// column headers; the row nodes follow. The primary columns are linked to the root, the secondary
/// ones only to themselves, so a cover never needs them but they still exclude each other's rows.
struct Links {
    left: Vec<usize>,
    right: Vec<usize>,
    up: Vec<usize>,
    down: Vec<usize>,
    /// The header of each node.
    column: Vec<usize>,
    /// The row of each node (`NONE` for headers).
    row: Vec<u32>,
    /// The rows left in each column, by header.
    size: Vec<usize>,
}

impl Links {
    fn new(primary: usize, secondary: usize) -> Self {
        let headers = 1 + primary + secondary;
        let mut links = Self {
            left: (0..headers).collect(),
            right: (0..headers).collect(),
            up: (0..headers).collect(),
            down: (0..headers).collect(),
            column: (0..headers).collect(),
            row: vec![NONE; headers],
            size: vec![0; headers],
        };
        let ring = primary + 1;
        for i in 0..ring {
            links.right[i] = (i + 1) % ring;
            links.left[(i + 1) % ring] = i;
        }
        links
    }

    /// Appends a row with a node in each of `columns` (column numbers, from 0).
    fn add_row(&mut self, row: usize, columns: &[usize]) {
        let first = self.left.len();
        let n = columns.len();
        for (k, &c) in columns.iter().enumerate() {
            let (node, header) = (first + k, c + 1);
            self.left.push(if k == 0 { first + n - 1 } else { node - 1 });
            self.right.push(if k + 1 == n { first } else { node + 1 });
            let last = self.up[header];
            self.up.push(last);
            self.down.push(header);
            self.down[last] = node;
            self.up[header] = node;
            self.column.push(header);
            self.row.push(row as u32);
            self.size[header] += 1;
        }
    }

    fn cover(&mut self, c: usize) {
        let (l, r) = (self.left[c], self.right[c]);
        self.right[l] = r;
        self.left[r] = l;
        let mut i = self.down[c];
        while i != c {
            let mut j = self.right[i];
            while j != i {
                let (u, d) = (self.up[j], self.down[j]);
                self.down[u] = d;
                self.up[d] = u;
                self.size[self.column[j]] -= 1;
                j = self.right[j];
            }
            i = self.down[i];
        }
    }

    fn uncover(&mut self, c: usize) {
        let mut i = self.up[c];
        while i != c {
            let mut j = self.left[i];
            while j != i {
                self.size[self.column[j]] += 1;
                let (u, d) = (self.up[j], self.down[j]);
                self.down[u] = j;
                self.up[d] = j;
                j = self.left[j];
            }
            i = self.up[i];
        }
        let (l, r) = (self.left[c], self.right[c]);
        self.right[l] = c;
        self.left[r] = c;
    }
}

/// Algorithm X over the placement rows, keeping each assembly once.
struct Search<'a> {
    links: Links,
    /// The (copy, placement) of each row.
    rows: Vec<(usize, u32)>,
    /// The copies of the kind of each copy.
    same_kind: Vec<Range<usize>>,
    /// The placement of each copy, or `NONE`.
    assigned: Vec<u32>,
    /// Each symmetry of the target as a permutation of the placements.
    images: &'a [Vec<u32>],
    /// The assemblies found, each as the smallest of its images: sorted placements.
    found: BTreeSet<Vec<u32>>,
    max_assemblies: u64,
    aborted: bool,
}

impl Search<'_> {
    fn run(&mut self) {
        if self.links.right[0] == 0 {
            self.record();
            return;
        }
        // The primary column with the fewest rows.
        let (mut c, mut best) = (self.links.right[0], 0);
        let mut fewest = usize::MAX;
        while c != 0 {
            if self.links.size[c] < fewest {
                (best, fewest) = (c, self.links.size[c]);
            }
            c = self.links.right[c];
        }
        if fewest == 0 {
            return;
        }
        self.links.cover(best);
        let mut r = self.links.down[best];
        while r != best && !self.aborted {
            let (copy, placement) = self.rows[self.links.row[r] as usize];
            if self.in_order(copy, placement) {
                self.assigned[copy] = placement;
                let mut j = self.links.right[r];
                while j != r {
                    self.links.cover(self.links.column[j]);
                    j = self.links.right[j];
                }
                self.run();
                let mut j = self.links.left[r];
                while j != r {
                    self.links.uncover(self.links.column[j]);
                    j = self.links.left[j];
                }
                self.assigned[copy] = NONE;
            }
            r = self.links.down[r];
        }
        self.links.uncover(best);
    }

    /// Identical pieces are interchangeable: their copies take increasing placements, so each set
    /// of placements is found once.
    fn in_order(&self, copy: usize, placement: u32) -> bool {
        self.same_kind[copy].clone().all(|other| {
            let p = self.assigned[other];
            p == NONE || (other < copy) == (p < placement)
        })
    }

    fn record(&mut self) {
        let canonical = self
            .images
            .iter()
            .map(|image| {
                let mut mapped: Vec<u32> = self.assigned.iter().map(|&p| image[p as usize]).collect();
                mapped.sort_unstable();
                mapped
            })
            .min()
            .unwrap_or_default();
        if self.found.contains(&canonical) {
            return;
        }
        if self.found.len() as u64 >= self.max_assemblies {
            self.aborted = true;
            return;
        }
        self.found.insert(canonical);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_cover_and_uncover_restore_the_matrix() {
        // Knuth's example matrix (6 rows over 7 columns), whose exact cover is rows 0, 3 and 4.
        let rows: [&[usize]; 6] = [&[2, 4, 5], &[0, 3, 6], &[1, 2, 5], &[0, 3], &[1, 6], &[3, 4, 6]];
        let mut links = Links::new(7, 0);
        for (r, columns) in rows.iter().enumerate() {
            links.add_row(r, columns);
        }
        let before =
            (links.left.clone(), links.right.clone(), links.up.clone(), links.down.clone(), links.size.clone());
        links.cover(1);
        links.cover(4);
        links.uncover(4);
        links.uncover(1);
        assert_eq!(before, (links.left, links.right, links.up, links.down, links.size));
    }

    #[test]
    fn orientations_of_a_cube_and_an_l() {
        assert_eq!(orientations(&[[0, 0, 0]]).len(), 1);
        assert_eq!(orientations(&[[0, 0, 0], [1, 0, 0]]).len(), 3);
        assert_eq!(orientations(&[[0, 0, 0], [1, 0, 0], [0, 1, 0]]).len(), 12);
        assert_eq!(orientations(&[[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0]]).len(), 24);
    }
}

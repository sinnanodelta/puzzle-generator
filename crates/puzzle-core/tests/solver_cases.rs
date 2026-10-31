//! Hand-built puzzles with known disassemblies, shape checks, validation and canonical keys.

use std::collections::BTreeMap;

use puzzle_core::fixtures::parse_fixtures;
use puzzle_core::{
    Dir, ModelError, Move, Node, Puzzle, Solution, SolveOptions, Status, Voxel, canonical_key, is_millable,
    is_notchable, notch_closure, solve,
};

const FIXTURES: &str = include_str!("../../../fixtures/burrs.json");

/// The cells of the box `lo..=hi`.
fn cuboid(lo: Voxel, hi: Voxel) -> Vec<Voxel> {
    (lo[2]..=hi[2]).flat_map(|z| (lo[1]..=hi[1]).flat_map(move |y| (lo[0]..=hi[0]).map(move |x| [x, y, z]))).collect()
}

fn minus(cells: Vec<Voxel>, holes: &[Voxel]) -> Vec<Voxel> {
    cells.into_iter().filter(|v| !holes.contains(v)).collect()
}

fn solved(puzzle: &Puzzle) -> Solution {
    let result = solve(puzzle, &SolveOptions::default());
    assert_eq!(result.status, Status::Solved);
    result.solution.expect("a solved puzzle has a solution")
}

fn slide(pieces: u32, dir: Dir, dist: u32) -> Move {
    Move { pieces, dir, dist: Some(dist) }
}

fn away(pieces: u32, dir: Dir) -> Move {
    Move { pieces, dir, dist: None }
}

fn leaf(pieces: u32, moves: Vec<Move>, removed: u32) -> Node {
    Node { pieces, moves, removed, remaining: None, removed_tree: None }
}

#[test]
fn two_cubes_separate_at_once() {
    let puzzle = Puzzle::new([2, 1, 1], vec![vec![[0, 0, 0]], vec![[1, 0, 0]]]).unwrap();
    let s = solved(&puzzle);
    assert_eq!((s.level, s.level_string.as_str(), s.total_moves), (1, "1", 1));
    assert_eq!(s.tree, leaf(0b11, vec![away(0b10, Dir::PosX)], 0b10));
}

#[test]
fn bar_slides_to_the_opening_then_out() {
    // A closed box with a 3×2 cavity in its middle layer and one opening at (3, 3, 1); the bar
    // fills the left column of the cavity.
    let cavity = cuboid([1, 1, 1], [3, 2, 1]);
    let shell = minus(cuboid([0, 0, 0], [4, 3, 2]), &[cavity, vec![[3, 3, 1]]].concat());
    let bar = vec![[1, 1, 1], [1, 2, 1]];
    let s = solved(&Puzzle::new([5, 4, 3], vec![shell, bar]).unwrap());
    assert_eq!(s.tree.moves, vec![slide(0b10, Dir::PosX, 2), away(0b10, Dir::PosY)]);
    assert_eq!((s.level, s.level_string.as_str(), s.total_moves), (2, "2", 2));
}

#[test]
fn group_leaves_together_then_splits() {
    // The cavity opens on +x. Piece 2, a U, holds piece 1 against the floor: neither moves alone,
    // both slide out together, then piece 2 lifts off piece 1.
    let shell = minus(cuboid([0, 0, 0], [4, 3, 2]), &cuboid([1, 1, 1], [4, 2, 1]));
    let inner = vec![[2, 1, 1], [3, 1, 1]];
    let u = vec![[1, 1, 1], [1, 2, 1], [2, 2, 1], [3, 2, 1], [4, 2, 1], [4, 1, 1]];
    let s = solved(&Puzzle::new([5, 4, 3], vec![shell, inner, u]).unwrap());
    let expected = Node {
        removed_tree: Some(Box::new(leaf(0b110, vec![away(0b100, Dir::PosY)], 0b100))),
        ..leaf(0b111, vec![away(0b110, Dir::PosX)], 0b110)
    };
    assert_eq!(s.tree, expected);
    assert_eq!((s.level, s.level_string.as_str(), s.total_moves), (1, "1", 2));
}

#[test]
fn enclosed_cube_is_unsolvable() {
    let shell = minus(cuboid([0, 0, 0], [2, 2, 2]), &[[1, 1, 1]]);
    let result = solve(&Puzzle::new([3, 3, 3], vec![shell, vec![[1, 1, 1]]]).unwrap(), &SolveOptions::default());
    assert_eq!((result.status, result.states, result.solution), (Status::Unsolvable, 1, None));
}

#[test]
fn separation_with_an_interlocked_part_is_unsolvable() {
    // Pieces 1 and 2 slide off piece 0 together, but piece 2 is sealed inside piece 1.
    let cube = vec![[0, 0, 0]];
    let shell = minus(cuboid([1, 0, 0], [3, 2, 2]), &[[2, 1, 1]]);
    let puzzle = Puzzle::new([4, 3, 3], vec![cube, shell, vec![[2, 1, 1]]]).unwrap();
    let result = solve(&puzzle, &SolveOptions::default());
    assert_eq!((result.status, result.solution), (Status::Unsolvable, None));
}

#[test]
fn state_cap_aborts() {
    let fixtures = parse_fixtures(FIXTURES).unwrap();
    let result = solve(&fixtures["piston"].puzzle().unwrap(), &SolveOptions { max_states: 10 });
    assert_eq!((result.status, result.solution), (Status::Aborted, None));
    assert!(result.states > 10);
}

#[test]
fn shapes() {
    let stick = cuboid([0, 0, 0], [1, 1, 5]);
    assert!(is_notchable(&stick) && is_millable(&stick));

    // A missing inner corner: not a notch, and no cutter reaches it.
    let cube = cuboid([0, 0, 0], [1, 1, 1]);
    let dented = minus(cube.clone(), &[[1, 1, 1]]);
    assert!(!is_notchable(&dented) && !is_millable(&dented));
    let mut closure_want = cube;
    closure_want.sort_unstable();
    assert_eq!(notch_closure(&dented), closure_want);

    let ring = minus(cuboid([0, 0, 0], [2, 2, 0]), &[[1, 1, 0]]);
    assert!(is_notchable(&ring) && is_millable(&ring));

    let tromino = vec![[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    assert!(is_notchable(&tromino));
    assert!(is_notchable(&[]) && is_millable(&[]));
}

#[test]
fn invalid_puzzles_are_rejected() {
    let cube = vec![[0, 0, 0]];
    assert_eq!(
        Puzzle::new([2, 1, 1], vec![cube.clone(), vec![[1, 0, 0], [0, 0, 0]]]),
        Err(ModelError::Overlap { voxel: [0, 0, 0], pieces: [0, 1] })
    );
    assert_eq!(
        Puzzle::new([2, 1, 1], vec![cube.clone(), vec![[2, 0, 0]]]),
        Err(ModelError::OutOfGrid { piece: 1, voxel: [2, 0, 0] })
    );
    assert_eq!(Puzzle::new([2, 1, 1], vec![cube.clone(), vec![]]), Err(ModelError::EmptyPiece(1)));
    assert_eq!(Puzzle::new([2, 1, 1], vec![cube.clone()]), Err(ModelError::PieceCount(1)));
    assert_eq!(Puzzle::new([33, 1, 1], vec![cube.clone(), cube]), Err(ModelError::GridSize([33, 1, 1])));
}

#[test]
fn canonical_key_ignores_rotation_translation_and_order() {
    let fixtures = parse_fixtures(FIXTURES).unwrap();
    let piston = fixtures["piston"].puzzle().unwrap();
    // A quarter turn about z, then a half turn about the x = z diagonal: both proper rotations.
    let rotate = |v: &Voxel| {
        let quarter = [-v[1], v[0], v[2]];
        [quarter[2], -quarter[1], quarter[0]]
    };
    let mut pieces: Vec<Vec<Voxel>> = piston.pieces().iter().map(|p| p.iter().map(rotate).collect()).collect();
    let lo = [0, 1, 2].map(|a| pieces.iter().flatten().map(|v| v[a]).min().unwrap());
    for v in pieces.iter_mut().flatten() {
        *v = [0, 1, 2].map(|a| v[a] - lo[a] + [3, 1, 4][a]);
    }
    pieces.reverse();
    pieces.swap(1, 3);
    let moved = Puzzle::new([32; 3], pieces).unwrap();
    assert_eq!(canonical_key(&moved), canonical_key(&piston));

    let mut by_key: BTreeMap<Vec<u8>, Vec<&str>> = BTreeMap::new();
    for (name, f) in &fixtures {
        by_key.entry(canonical_key(&f.puzzle().unwrap())).or_default().push(name);
    }
    // The legacy sample is Mega Six (the same six Rob's-page pieces), assembled in another
    // orientation and piece order; every other fixture is a distinct puzzle.
    let shared: Vec<&Vec<&str>> = by_key.values().filter(|names| names.len() > 1).collect();
    assert_eq!(shared, [&vec!["legacy_sample", "mega_six"]]);
}

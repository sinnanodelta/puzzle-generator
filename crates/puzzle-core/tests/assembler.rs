//! The assembler (SPEC §5) against BurrTools on the known puzzles of `fixtures/burrs.json`
//! (SPEC Appendix A), and on small hand-made cases.

use puzzle_core::fixtures::parse_fixtures;
use puzzle_core::model::Target;
use puzzle_core::templates::known_burr;
use puzzle_core::{
    AssembleOptions, AssembleResult, AssembleStatus, Fit, ModelError, Puzzle, Voxel, all_optional, assemble,
    canonical_key, fit_target,
};

const FIXTURES: &str = include_str!("../../../fixtures/burrs.json");

fn cuboid(lo: Voxel, hi: Voxel) -> Vec<Voxel> {
    (lo[2]..=hi[2]).flat_map(|z| (lo[1]..=hi[1]).flat_map(move |y| (lo[0]..=hi[0]).map(move |x| [x, y, z]))).collect()
}

fn required(cells: Vec<Voxel>) -> Target {
    Target { required: cells, variable: Vec::new() }
}

fn run(pieces: &[Vec<Voxel>], target: &Target) -> AssembleResult {
    assemble(pieces, target, &AssembleOptions::default()).expect("valid input")
}

/// (assemblies, solutions, unique, symmetry order) of a result.
fn counts(result: &AssembleResult) -> (u64, u64, bool, u32) {
    (result.assemblies, result.solutions, result.unique, result.symmetry_order)
}

#[test]
fn fixtures_match_burrtools() {
    let fixtures = parse_fixtures(FIXTURES).expect("fixtures parse");
    assert_eq!(fixtures.len(), 12);
    let mut failures = Vec::new();
    for (key, fixture) in &fixtures {
        let target = known_burr(key).expect("known burr").target.expect("burr target");
        let pieces: Vec<Vec<Voxel>> = fixture.pieces.iter().map(|p| p.voxels.clone()).collect();
        let want = &fixture.computed;
        // Every fixture records both pairs of counts; legacy_sample has no symmetry order.
        let order = want.symmetry_group_order;
        let cases = [
            ("standard", target.clone(), want.assemblies, want.solutions, want.unique),
            ("all optional", all_optional(&target), want.assemblies_all_optional, want.solutions_all_optional, None),
        ];
        for (name, target, assemblies, solutions, unique) in cases {
            let (Some(assemblies), Some(solutions)) = (assemblies, solutions) else {
                failures.push(format!("{key} ({name}): no BurrTools counts"));
                continue;
            };
            let result = run(&pieces, &target);
            let got = counts(&result);
            let expected =
                (u64::from(assemblies), u64::from(solutions), unique.unwrap_or(solutions == 1), order.unwrap_or(got.3));
            if result.status != AssembleStatus::Complete || result.undecided != 0 || got != expected {
                failures.push(format!(
                    "{key} ({name}): {:?}, {} undecided, (assemblies, solutions, unique, order) = {got:?}, \
                     expected {expected:?}",
                    result.status, result.undecided
                ));
            }
            // A unique puzzle's only disassemblable assembly is the puzzle itself.
            if result.unique {
                let first = result.first_solution.clone().expect("a solution");
                let found = Puzzle::new(fixture.grid, first).map(|p| canonical_key(&p));
                let own = fixture.puzzle().map(|p| canonical_key(&p));
                if found.is_err() || found != own {
                    failures.push(format!("{key} ({name}): the solution is not the fixture's assembly"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn assembly_cap_aborts() {
    let fixtures = parse_fixtures(FIXTURES).expect("fixtures parse");
    let fixture = &fixtures["loves_dozen"];
    let target = known_burr("loves_dozen").expect("known burr").target.expect("burr target");
    let pieces: Vec<Vec<Voxel>> = fixture.pieces.iter().map(|p| p.voxels.clone()).collect();
    let options = AssembleOptions { max_assemblies: 5, ..AssembleOptions::default() };
    let result = assemble(&pieces, &target, &options).expect("valid input");
    assert_eq!(result.status, AssembleStatus::Aborted);
    assert_eq!(result.assemblies, 5);
    assert!(result.solutions <= 5);
    assert!(!result.unique);
}

#[test]
fn state_cap_leaves_assemblies_undecided() {
    let fixtures = parse_fixtures(FIXTURES).expect("fixtures parse");
    let fixture = &fixtures["piston"];
    let target = known_burr("piston").expect("known burr").target.expect("burr target");
    let pieces: Vec<Vec<Voxel>> = fixture.pieces.iter().map(|p| p.voxels.clone()).collect();
    let options = AssembleOptions { max_states: 1, ..AssembleOptions::default() };
    let result = assemble(&pieces, &target, &options).expect("valid input");
    assert_eq!((result.status, result.assemblies), (AssembleStatus::Complete, 10));
    assert!(result.undecided > 0);
    assert!(result.solutions + result.undecided <= result.assemblies);
    assert!(!result.unique);
}

#[test]
fn two_dominoes_in_a_square() {
    let domino = vec![[0, 0, 0], [1, 0, 0]];
    // Away from the origin: the solution is in target coordinates.
    let mut square = cuboid([3, 4, 5], [4, 5, 5]);
    let result = run(&[domino.clone(), domino], &required(square.clone()));
    assert_eq!(counts(&result), (1, 1, true, 8));
    assert_eq!(result.status, AssembleStatus::Complete);
    let mut first = result.first_solution.expect("a solution").concat();
    first.sort_unstable();
    square.sort_unstable();
    assert_eq!(first, square);
}

#[test]
fn cube_and_domino_in_a_line() {
    let pieces = [vec![[5, 5, 5]], vec![[0, 0, 0], [0, 0, 1]]];
    let line = cuboid([0, 0, 0], [2, 0, 0]);
    assert_eq!(counts(&run(&pieces, &required(line.clone()))), (1, 1, true, 8));
    // A variable cell at one end breaks the flip: the cube at either end is another assembly.
    let target = Target { required: line, variable: vec![[3, 0, 0]] };
    assert_eq!(counts(&run(&pieces, &target)), (2, 2, false, 4));
}

#[test]
fn identical_cubes_count_once() {
    let cube = vec![[0, 0, 0]];
    let result = run(&[cube.clone(), cube.clone(), cube], &required(cuboid([0, 0, 0], [2, 0, 0])));
    assert_eq!(counts(&result), (1, 1, true, 8));
}

#[test]
fn enclosed_piece_is_an_unsolvable_assembly() {
    let shell: Vec<Voxel> = cuboid([0, 0, 0], [2, 2, 2]).into_iter().filter(|&v| v != [1, 1, 1]).collect();
    let result = run(&[shell, vec![[0, 0, 0]]], &required(cuboid([0, 0, 0], [2, 2, 2])));
    assert_eq!(counts(&result), (1, 0, false, 24));
    assert_eq!(result.first_solution, None);
}

#[test]
fn optional_cells_may_stay_empty() {
    let domino = vec![[0, 0, 0], [1, 0, 0]];
    // Two dominoes are two disjoint edges of the 2×2×2 cube, up to its 24 rotations: on one face,
    // parallel across the diagonal, or skew in either handedness (mirror images are distinct).
    let target = all_optional(&required(cuboid([0, 0, 0], [1, 1, 1])));
    assert_eq!(counts(&run(&[domino.clone(), domino], &target)), (4, 4, false, 24));
}

#[test]
fn empty_target_and_impossible_volumes() {
    let domino = vec![[0, 0, 0], [1, 0, 0]];
    let pieces = [domino.clone(), domino];
    let empty = run(&pieces, &required(Vec::new()));
    assert_eq!((empty.status, counts(&empty)), (AssembleStatus::Complete, (0, 0, false, 24)));
    // Too few cells, then too many required cells.
    assert_eq!(run(&pieces, &required(cuboid([0, 0, 0], [2, 0, 0]))).assemblies, 0);
    assert_eq!(run(&pieces, &required(cuboid([0, 0, 0], [4, 0, 0]))).assemblies, 0);
}

#[test]
fn invalid_input_is_an_error() {
    let options = AssembleOptions::default();
    let target = required(cuboid([0, 0, 0], [1, 0, 0]));
    assert_eq!(assemble(&[vec![[0, 0, 0]]], &target, &options), Err(ModelError::PieceCount(1)));
    assert_eq!(assemble(&[vec![[0, 0, 0]], Vec::new()], &target, &options), Err(ModelError::EmptyPiece(1)));
    let wide = required(vec![[0, 0, 0], [40, 0, 0]]);
    assert_eq!(assemble(&[vec![[0, 0, 0]], vec![[0, 0, 0]]], &wide, &options), Err(ModelError::GridSize([41, 1, 1])));
}

#[test]
fn pieces_that_do_not_fit_count_in_their_own_shape() {
    // A domino and a cube leave a hole in a 2×2 square: no assembly fills it, but the L they form
    // has the pieces' own assembly.
    let pieces = [vec![[0, 0, 0], [1, 0, 0]], vec![[0, 1, 0]]];
    let square = required(cuboid([0, 0, 0], [1, 1, 0]));
    assert_eq!(run(&pieces, &square).assemblies, 0);
    let fit = fit_target(&pieces, &square);
    assert_eq!((fit.holes, fit.outside), (1, 0));
    assert_eq!(fit.target, required(vec![[0, 0, 0], [1, 0, 0], [0, 1, 0]]));
    assert_eq!(counts(&run(&pieces, &fit.target)), (1, 1, true, 2));

    // A voxel outside the target becomes a required cell of the shape; a hole also listed as
    // variable stays empty.
    let target = Target { required: vec![[0, 0, 0], [1, 0, 0], [1, 1, 0]], variable: vec![[1, 1, 0], [0, 1, 0]] };
    let pieces = [vec![[0, 0, 0], [1, 0, 0]], vec![[0, 1, 0], [0, 2, 0]]];
    let fit = fit_target(&pieces, &target);
    assert_eq!((fit.holes, fit.outside), (1, 1));
    assert_eq!(fit.target, Target { required: vec![[0, 0, 0], [1, 0, 0], [0, 2, 0]], variable: vec![[0, 1, 0]] });
    assert!(run(&pieces, &fit.target).assemblies >= 1);

    // Pieces that fit keep the target.
    let pieces = [vec![[0, 0, 0], [1, 0, 0]], vec![[0, 1, 0], [1, 1, 0]]];
    assert_eq!(fit_target(&pieces, &square), Fit { target: square, holes: 0, outside: 0 });
}

#[test]
fn all_optional_merges_the_cells() {
    let target = Target { required: vec![[1, 0, 0], [0, 0, 0]], variable: vec![[0, 0, 0], [2, 0, 0]] };
    assert_eq!(all_optional(&target), Target { required: Vec::new(), variable: cuboid([0, 0, 0], [2, 0, 0]) });
}

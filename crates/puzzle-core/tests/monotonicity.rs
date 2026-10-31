//! SPEC §1.2: adding a voxel never makes an unsolvable puzzle solvable and never lowers the level.

use puzzle_core::fixtures::parse_fixtures;
use puzzle_core::rng::SplitMix64;
use puzzle_core::{Puzzle, SolveOptions, Status, Voxel, solve};

const FIXTURES: &str = include_str!("../../../fixtures/burrs.json");

/// Adds to a random piece a random free cell of its bounding box (the holes the generator fills).
fn add_random_voxel(puzzle: &Puzzle, rng: &mut SplitMix64) -> Option<Puzzle> {
    let pieces = puzzle.pieces();
    let filled: std::collections::HashSet<Voxel> = pieces.iter().flatten().copied().collect();
    let mut order: Vec<usize> = (0..pieces.len()).collect();
    rng.shuffle(&mut order);
    for p in order {
        let lo = [0, 1, 2].map(|a| pieces[p].iter().map(|v| v[a]).min().unwrap());
        let hi = [0, 1, 2].map(|a| pieces[p].iter().map(|v| v[a]).max().unwrap());
        let free: Vec<Voxel> = (lo[2]..=hi[2])
            .flat_map(|z| (lo[1]..=hi[1]).flat_map(move |y| (lo[0]..=hi[0]).map(move |x| [x, y, z])))
            .filter(|v| !filled.contains(v))
            .collect();
        if free.is_empty() {
            continue;
        }
        let mut next = pieces.to_vec();
        next[p].push(free[rng.below(free.len() as u64) as usize]);
        return Some(Puzzle::new(puzzle.grid(), next).expect("a free cell keeps the puzzle valid"));
    }
    None
}

#[test]
fn adding_voxels_never_lowers_the_level() {
    let fixtures = parse_fixtures(FIXTURES).unwrap();
    let options = SolveOptions::default();
    let mut checked = 0;
    for (seed, key) in [(1, "legacy_sample"), (2, "abad_level_9"), (3, "abad_4_8")] {
        let mut rng = SplitMix64::new(seed);
        let mut puzzle = fixtures[key].puzzle().unwrap();
        let mut result = solve(&puzzle, &options);
        for step in 0..10 {
            let Some(next) = add_random_voxel(&puzzle, &mut rng) else { break };
            let next_result = solve(&next, &options);
            assert_ne!(next_result.status, Status::Aborted, "{key} step {step}");
            match (&result.solution, &next_result.solution) {
                (None, Some(_)) => panic!("{key} step {step}: a voxel made an unsolvable puzzle solvable"),
                (Some(before), Some(after)) => {
                    assert!(after.level >= before.level, "{key} step {step}: level {} -> {}", before.level, after.level)
                }
                _ => {}
            }
            (puzzle, result) = (next, next_result);
            checked += 1;
        }
    }
    assert!(checked >= 20, "only {checked} additions");
}

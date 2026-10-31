//! Solver and assembler timings on the fixtures, printed as Markdown tables for BENCH.md.
//!
//! `cargo run --release --example bench`

use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

use puzzle_core::fixtures::{Fixture, parse_fixtures};
use puzzle_core::templates::known_burr;
use puzzle_core::{AssembleOptions, Puzzle, SolveOptions, Status, Voxel, all_optional, assemble, solve};

const FIXTURES: &str = include_str!("../../../fixtures/burrs.json");

/// Each measurement repeats until this much time has passed (at least 3 runs, at most 50).
const BUDGET: Duration = Duration::from_secs(2);

fn main() {
    let fixtures = parse_fixtures(FIXTURES).expect("fixtures parse");
    fixture_table(&fixtures);
    println!();
    variant_table(&fixtures);
    println!();
    assembler_table(&fixtures);
}

/// Solves each fixture as given.
fn fixture_table(fixtures: &BTreeMap<String, Fixture>) {
    println!("| Fixture | Level string | Total moves | States | Runs | Median | Min |");
    println!("|---|---|---:|---:|---:|---:|---:|");
    for (key, fixture) in fixtures {
        let puzzle = fixture.puzzle().expect("valid fixture");
        let result = solve(&puzzle, &SolveOptions::default());
        let times = runs(|| {
            solve(&puzzle, &SolveOptions::default());
        });
        let (level_string, total) = result
            .solution
            .as_ref()
            .map_or((format!("{:?}", result.status), 0), |s| (s.level_string.clone(), s.total_moves));
        println!(
            "| {key} | {level_string} | {total} | {} | {} | {:.3} ms | {:.3} ms |",
            result.states,
            times.len(),
            ms(times[times.len() / 2]),
            ms(times[0])
        );
    }
}

/// Solves every one-voxel extension of each fixture: the kind of check the generator repeats.
fn variant_table(fixtures: &BTreeMap<String, Fixture>) {
    println!(
        "| Fixture | Variants | Solved | Unsolvable | Highest level | States per check | Median per check | Checks/s |"
    );
    println!("|---|---:|---:|---:|---:|---:|---:|---:|");
    for (key, fixture) in fixtures {
        let variants = one_voxel_variants(&fixture.puzzle().expect("valid fixture"));
        if variants.is_empty() {
            println!("| {key} | 0 | | | | | | |");
            continue;
        }
        let results: Vec<_> = variants.iter().map(|p| solve(p, &SolveOptions::default())).collect();
        let count = |status| results.iter().filter(|r| r.status == status).count();
        let highest = results.iter().filter_map(|r| r.solution.as_ref().map(|s| s.level)).max();
        let states: u64 = results.iter().map(|r| r.states).sum();
        let times = runs(|| {
            for p in &variants {
                solve(p, &SolveOptions::default());
            }
        });
        let per_check = times[times.len() / 2] / variants.len() as u32;
        println!(
            "| {key} | {} | {} | {} | {} | {:.0} | {:.3} ms | {:.0} |",
            variants.len(),
            count(Status::Solved),
            count(Status::Unsolvable),
            highest.map_or("-".to_string(), |l| l.to_string()),
            states as f64 / variants.len() as f64,
            ms(per_check),
            1.0 / per_check.as_secs_f64()
        );
    }
}

/// Counts and solves the assemblies of each fixture (SPEC §5), into its standard burr target and
/// into the same target with every cell optional.
fn assembler_table(fixtures: &BTreeMap<String, Fixture>) {
    println!("| Fixture | Target | Symmetries | Assemblies | Solutions | Runs | Median | Min |");
    println!("|---|---|---:|---:|---:|---:|---:|---:|");
    for (key, fixture) in fixtures {
        let target = known_burr(key).expect("known burr").target.expect("burr target");
        let pieces: Vec<Vec<Voxel>> = fixture.pieces.iter().map(|p| p.voxels.clone()).collect();
        for (name, target) in [("standard", target.clone()), ("all optional", all_optional(&target))] {
            let options = AssembleOptions::default();
            let result = assemble(&pieces, &target, &options).expect("valid fixture");
            let times = runs(|| {
                assemble(&pieces, &target, &options).expect("valid fixture");
            });
            println!(
                "| {key} | {name} | {} | {} | {} | {} | {:.3} ms | {:.3} ms |",
                result.symmetry_order,
                result.assemblies,
                result.solutions,
                times.len(),
                ms(times[times.len() / 2]),
                ms(times[0])
            );
        }
    }
}

/// Every puzzle made by adding to one piece one empty cell of its bounding box.
fn one_voxel_variants(puzzle: &Puzzle) -> Vec<Puzzle> {
    let pieces = puzzle.pieces();
    let filled: HashSet<Voxel> = pieces.iter().flatten().copied().collect();
    let mut variants = Vec::new();
    for (p, piece) in pieces.iter().enumerate() {
        let lo = [0, 1, 2].map(|a| piece.iter().map(|v| v[a]).min().unwrap());
        let hi = [0, 1, 2].map(|a| piece.iter().map(|v| v[a]).max().unwrap());
        for z in lo[2]..=hi[2] {
            for y in lo[1]..=hi[1] {
                for x in lo[0]..=hi[0] {
                    if !filled.contains(&[x, y, z]) {
                        let mut next = pieces.to_vec();
                        next[p].push([x, y, z]);
                        variants.push(Puzzle::new(puzzle.grid(), next).expect("an empty cell keeps the puzzle valid"));
                    }
                }
            }
        }
    }
    variants
}

/// Durations of repeated runs of `f`, sorted.
fn runs(mut f: impl FnMut()) -> Vec<Duration> {
    let mut times = Vec::new();
    let start = Instant::now();
    while times.len() < 3 || (times.len() < 50 && start.elapsed() < BUDGET) {
        let t = Instant::now();
        f();
        times.push(t.elapsed());
    }
    times.sort_unstable();
    times
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

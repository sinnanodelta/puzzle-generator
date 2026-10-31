//! The solver against BurrTools on the known puzzles of `fixtures/burrs.json` (SPEC Appendix A).

use puzzle_core::fixtures::parse_fixtures;
use puzzle_core::{SolveOptions, Status, solve};

const FIXTURES: &str = include_str!("../../../fixtures/burrs.json");

/// Fixtures where our result differs from BurrTools for a justified reason:
/// (key, our level string, our total moves, reason).
const KNOWN_DIFFERENCES: &[(&str, &str, u32, &str)] = &[];

#[test]
fn fixtures_match_burrtools() {
    let fixtures = parse_fixtures(FIXTURES).expect("fixtures parse");
    assert_eq!(fixtures.len(), 12);
    let mut failures = Vec::new();
    for (key, fixture) in &fixtures {
        let puzzle = fixture.puzzle().unwrap_or_else(|e| panic!("{key}: {e}"));
        let result = solve(&puzzle, &SolveOptions::default());
        let (Status::Solved, Some(solution)) = (result.status, &result.solution) else {
            failures.push(format!("{key}: {:?} after {} states", result.status, result.states));
            continue;
        };
        let want = &fixture.computed;
        let (level_string, total_moves) = KNOWN_DIFFERENCES
            .iter()
            .find(|d| d.0 == key)
            .map_or((want.level_string.as_str(), want.total_moves), |d| (d.1, d.2));
        let got = (solution.level, solution.level_string.as_str(), solution.total_moves);
        let expected = (want.first_split_moves, level_string, total_moves);
        if got != expected {
            failures.push(format!("{key}: (level, level string, total) = {got:?}, expected {expected:?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

//! SPEC §4: the generator only adds optional cells, keeps the puzzle solvable and the flagged pieces
//! notchable, records distinct connected puzzles with their true score, and is reproducible.

use std::collections::HashSet;

use puzzle_core::model::DocumentPiece;
use puzzle_core::templates::burr_template;
use puzzle_core::{
    Document, Generator, GeneratorError, GeneratorOptions, ModelError, SolveOptions, Status, Voxel, is_connected,
    is_notchable, solve,
};

fn template(notchable: bool) -> Document {
    let mut doc = burr_template(6).unwrap();
    for piece in &mut doc.pieces {
        piece.notchable = notchable;
    }
    doc
}

fn options(seed: u64) -> GeneratorOptions {
    GeneratorOptions { seed, ..GeneratorOptions::default() }
}

fn piece(id: &str, fixed: Vec<Voxel>, optional: Vec<Voxel>) -> DocumentPiece {
    DocumentPiece { id: id.into(), name: id.into(), color: "#888888".into(), notchable: false, fixed, optional }
}

/// A document on a 3×3×3 grid with the given pieces.
fn small(pieces: Vec<DocumentPiece>) -> Document {
    let mut doc = burr_template(6).unwrap();
    doc.grid = [3, 3, 3];
    doc.target = None;
    doc.pieces = pieces;
    doc
}

fn all_cells() -> impl Iterator<Item = Voxel> {
    (0..27).map(|i| [i % 3, i / 3 % 3, i / 9])
}

/// Checks every leaderboard entry of a run on `base`.
fn check_board(base: &Document, generator: &Generator, notchable: bool) {
    let board = generator.board();
    assert!(!board.is_empty());
    let keys: HashSet<&str> = board.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(keys.len(), board.len(), "duplicate keys");
    assert!(board.windows(2).all(|w| w[0].score >= w[1].score), "not best first");
    for entry in board {
        let doc = &entry.document;
        doc.validate().unwrap();
        let result = solve(&doc.to_puzzle().unwrap(), &SolveOptions::default());
        assert_eq!(result.status, Status::Solved, "{}", entry.level_string);
        let solution = result.solution.unwrap();
        assert_eq!((solution.level, solution.total_moves), (entry.score.level, entry.score.total_moves));
        assert_eq!(solution.level_string, entry.level_string);
        assert!(doc.name.ends_with(&format!("(level {})", entry.level_string)), "{}", doc.name);
        let filled: HashSet<Voxel> = doc.pieces.iter().flat_map(|p| p.fixed.iter().copied()).collect();
        let required = base.target.iter().flat_map(|t| &t.required);
        assert_eq!(entry.holes, required.filter(|&v| !filled.contains(v)).count(), "holes");
        for (p, (piece, base_piece)) in doc.pieces.iter().zip(&base.pieces).enumerate() {
            assert!(is_connected(&piece.fixed), "piece {p} disconnected");
            assert_eq!(piece.notchable, notchable);
            if notchable {
                assert!(is_notchable(&piece.fixed), "piece {p} not notchable");
            }
            let fixed: HashSet<Voxel> = piece.fixed.iter().copied().collect();
            assert!(base_piece.fixed.iter().all(|v| fixed.contains(v)), "piece {p} lost a fixed voxel");
            let allowed: HashSet<Voxel> = base_piece.fixed.iter().chain(&base_piece.optional).copied().collect();
            assert!(fixed.iter().all(|v| allowed.contains(v)), "piece {p} gained a cell not optional for it");
            // Cells it filled are no longer optional, and no cell another piece filled is.
            assert!(piece.optional.iter().all(|v| !doc.pieces.iter().any(|q| q.fixed.contains(v))));
        }
    }
}

#[test]
fn entries_are_valid_and_scored() {
    for notchable in [false, true] {
        let base = template(notchable);
        for seed in 1..=3 {
            let mut generator = Generator::new(&base, options(seed)).unwrap();
            let report = generator.step(10_000);
            assert_eq!(report.checks, 10_001);
            assert_eq!(report.best, generator.board().first().map(|e| e.score));
            check_board(&base, &generator, notchable);
        }
    }
}

#[test]
fn runs_do_not_depend_on_steps() {
    let base = template(true);
    let mut whole = Generator::new(&base, options(7)).unwrap();
    let mut pieces = Generator::new(&base, options(7)).unwrap();
    let report = whole.step(3_000);
    let mut last = None;
    let mut entries = 0;
    for _ in 0..3_000 {
        let r = pieces.step(1);
        entries += r.entries.len();
        last = Some(r);
    }
    let last = last.unwrap();
    assert_eq!(whole.board(), pieces.board());
    assert!(entries >= pieces.board().len());
    assert_eq!(
        (report.checks, report.aborted, report.passes, report.restarts, report.current, report.best),
        (last.checks, last.aborted, last.passes, last.restarts, last.current, last.best)
    );
    let other = Generator::new(&base, options(8)).unwrap().step(3_000);
    assert!(!report.entries.is_empty());
    assert_ne!(other.entries, report.entries, "seeds 7 and 8 gave the same run");
}

#[test]
fn reports_new_entries_once() {
    let mut generator = Generator::new(&template(false), options(2)).unwrap();
    let mut seen = HashSet::new();
    for _ in 0..20 {
        for entry in generator.step(500).entries {
            assert!(seen.insert(entry.key.clone()), "entry reported twice");
            assert!(generator.board().iter().any(|e| e.key == entry.key), "reported entry not on the board");
        }
    }
    assert!(generator.board().iter().all(|e| seen.contains(&e.key)));
}

#[test]
fn keep_bounds_the_board() {
    let options = GeneratorOptions { keep: 3, ..options(1) };
    let mut generator = Generator::new(&template(true), options).unwrap();
    generator.step(10_000);
    assert_eq!(generator.board().len(), 3);
    let options = GeneratorOptions { keep: 0, ..GeneratorOptions::default() };
    let mut generator = Generator::new(&template(true), options).unwrap();
    assert!(generator.step(2_000).entries.is_empty());
}

#[test]
fn raises_the_level_of_the_template() {
    let base = template(false);
    let base_level = solve(&base.to_puzzle().unwrap(), &SolveOptions::default()).solution.unwrap().level;
    let mut generator = Generator::new(&base, options(1)).unwrap();
    let best = generator.step(10_000).best.expect("a connected puzzle");
    assert!(best.level >= 3 && best.level > base_level, "best level {} (base {base_level})", best.level);
}

#[test]
fn restarts_after_stale_passes() {
    let options = GeneratorOptions { restart_after: 5, ..options(3) };
    let report = Generator::new(&template(false), options).unwrap().step(5_000);
    assert!(report.restarts > 0);
    let options = GeneratorOptions { restart_after: 0, ..options };
    assert_eq!(Generator::new(&template(false), options).unwrap().step(5_000).restarts, 0);
}

#[test]
fn rejects_bad_bases() {
    let err = |doc: &Document| Generator::new(doc, GeneratorOptions::default()).err().expect("an error");

    let one = small(vec![piece("a", vec![[0, 0, 0]], vec![[1, 0, 0]])]);
    assert!(matches!(err(&one), GeneratorError::Model(ModelError::PieceCount(1))));

    let empty = small(vec![piece("a", vec![[0, 0, 0]], vec![]), piece("b", vec![], vec![[2, 2, 2]])]);
    assert!(matches!(err(&empty), GeneratorError::Model(ModelError::EmptyPiece(1))));

    let clash = small(vec![piece("a", vec![[0, 0, 0]], vec![]), piece("b", vec![[2, 2, 2]], vec![[0, 0, 0]])]);
    assert!(matches!(err(&clash), GeneratorError::Document(_)));

    // A cell walled in on all six sides.
    let walls: Vec<Voxel> = all_cells().filter(|&v| v != [1, 1, 1]).collect();
    let locked = small(vec![piece("a", vec![[1, 1, 1]], vec![]), piece("b", walls, vec![])]);
    assert!(matches!(err(&locked), GeneratorError::BaseUnsolvable));

    // A 2×2×2 cube less a corner: its notch closure is the whole cube.
    let corner: Vec<Voxel> = all_cells().filter(|v| v.iter().all(|&c| c < 2) && *v != [1, 1, 1]).collect();
    let mut notched = small(vec![piece("a", corner, vec![]), piece("b", vec![[2, 2, 2]], vec![[2, 2, 1]])]);
    notched.pieces[0].notchable = true;
    assert!(matches!(err(&notched), GeneratorError::NotNotchable(0)));

    let bare = small(vec![piece("a", vec![[0, 0, 0]], vec![]), piece("b", vec![[2, 2, 2]], vec![])]);
    assert!(matches!(err(&bare), GeneratorError::NoCandidate));
}

#[test]
fn notchable_pieces_grow_by_closures() {
    // Piece a is an L in the plane z = 0 with [0, 1, 1] on top. [1, 1, 1] touches it, and the notch
    // closure of the piece plus [1, 1, 1] also holds [1, 1, 0], the corner of the L.
    let doc = |notchable: bool, optional: Vec<Voxel>| {
        let mut doc = small(vec![
            piece("a", vec![[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 1]], optional),
            piece("b", vec![[2, 2, 2]], vec![]),
        ]);
        doc.pieces[0].notchable = notchable;
        doc
    };
    for seed in 1..=4 {
        let mut generator = Generator::new(&doc(true, vec![[1, 1, 0], [1, 1, 1]]), options(seed)).unwrap();
        generator.step(50);
        let board = generator.board();
        assert_eq!(board.len(), 1);
        let fixed = &board[0].document.pieces[0].fixed;
        assert_eq!(fixed, &vec![[0, 0, 0], [0, 1, 0], [0, 1, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], "seed {seed}");
        assert!(board[0].document.pieces[0].optional.is_empty());
    }

    // Without [1, 1, 0], [1, 1, 1] cannot be added to the notchable piece: nothing can.
    let err = Generator::new(&doc(true, vec![[1, 1, 1]]), options(4)).err();
    assert!(matches!(err, Some(GeneratorError::NoCandidate)));
    assert!(Generator::new(&doc(false, vec![[1, 1, 1]]), options(4)).is_ok());
}

/// The burr template with the whole burr required, so that the shared cells left empty are holes.
fn solid_template() -> Document {
    let mut base = template(false);
    let target = base.target.as_mut().unwrap();
    let variable = std::mem::take(&mut target.variable);
    target.required.extend(variable);
    base
}

#[test]
fn keeps_the_best_puzzles_without_holes() {
    let base = solid_template();
    let keep = 4;
    for fill_target in [false, true] {
        for seed in 1..=2 {
            let options = GeneratorOptions { seed, keep, fill_target, ..GeneratorOptions::default() };
            let mut generator = Generator::new(&base, options).unwrap();
            let report = generator.step(10_000);
            check_board(&base, &generator, false);
            let board = generator.board();
            let filled: Vec<_> = board.iter().filter(|e| e.holes == 0).collect();
            assert!(board.iter().any(|e| e.holes > 0), "nothing to leave out");
            assert!(!filled.is_empty() && filled.len() <= keep, "{} without holes", filled.len());
            // Past the `keep` best, only the best without holes stay.
            assert!(board.iter().skip(keep).all(|e| e.holes == 0));
            assert_eq!(report.best, board.first().map(|e| e.score));
            assert_eq!(report.best_filled, filled.first().map(|e| e.score));
        }
    }
}

#[test]
fn fill_target_finds_more_puzzles_without_holes() {
    let base = solid_template();
    let found = |fill_target: bool| -> usize {
        (1..=3)
            .map(|seed| {
                let options = GeneratorOptions { seed, fill_target, ..GeneratorOptions::default() };
                let mut generator = Generator::new(&base, options).unwrap();
                (0..20).flat_map(|_| generator.step(250).entries).filter(|e| e.holes == 0).count()
            })
            .sum()
    };
    let (without, with) = (found(false), found(true));
    assert!(with > without, "{with} with fill_target, {without} without");
}

#[test]
fn pieces_grow_by_touching_cells() {
    // [2, 0, 2] never touches piece a; [1, 1, 1] touches it once [1, 1, 0] is in, whichever comes
    // first in the order.
    let a = vec![[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    let base =
        small(vec![piece("a", a.clone(), vec![[2, 0, 2], [1, 1, 1], [1, 1, 0]]), piece("b", vec![[2, 2, 2]], vec![])]);
    for seed in 1..=8 {
        let mut generator = Generator::new(&base, options(seed)).unwrap();
        generator.step(20);
        check_board(&base, &generator, false);
        let fixed = &generator.board()[0].document.pieces[0].fixed;
        assert_eq!(fixed, &vec![[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], "seed {seed}");
    }

    // A cell that touches no piece is no candidate yet.
    let base = small(vec![piece("a", a, vec![[2, 0, 2]]), piece("b", vec![[2, 2, 2]], vec![])]);
    assert!(matches!(Generator::new(&base, options(1)).err(), Some(GeneratorError::NoCandidate)));
}

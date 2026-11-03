//! Generator (SPEC §4): adds optional voxels to a base while it stays solvable, to maximize the
//! level, by iterated local search over greedy passes.
//!
//! A pass tries the candidates (optional cells of pieces) in a shuffled order, and keeps each one
//! that leaves the puzzle solvable. A piece only grows by cells that touch it, so that it stays in
//! one part; a candidate that does not touch its piece yet waits, and the pass sweeps the waiting
//! candidates again while the previous sweep added something. A candidate rejected once would be
//! rejected again later in the pass: adding voxels never makes an unsolvable puzzle solvable (SPEC
//! §1.2), and the notch closure only grows with the piece. So a pass ends with a maximal solvable
//! set. Growing by touching cells loses no connected result: a connected piece grows from its base
//! one touching cell at a time, through subsets of a solvable puzzle, which are solvable. The next
//! pass starts from the accepted result less a few random added voxels, with the added voxels that
//! only they linked to their piece; removing voxels keeps a puzzle solvable. The search goes back to
//! the base after a number of passes without improvement or, with `auto`, after a stall that grows
//! with the length of the climb (`restart_due`). A check that reaches the state cap proves nothing
//! and counts as a rejection.
//!
//! Pass results compare the number of parts first: a puzzle with a piece in several parts cannot be
//! made or recorded, so it ranks below every puzzle that can, whatever its level, and fewer parts
//! lead the search towards one (a template base starts with pieces in two parts). At the end of a
//! pass, each piece still in several parts is joined, when the puzzle stays solvable, by a cheapest
//! bridge of cells optional for it: empty cells, or voxels other pieces added if they don't split.
//! With
//! `fill_target`, the holes come next: required cells of the target that no piece fills. The
//! leaderboard keeps the best puzzles, and also the best puzzles without holes, which may rank
//! lower.
//!
//! The generator is a state machine advanced by `step`, which returns after a number of checks, so
//! that a worker can report progress and be stopped between steps. A run depends only on the base,
//! the options and the seed, not on how it is cut into steps.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fmt;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::canonical::canonical_key;
use crate::model::{Document, DocumentError, ModelError, Puzzle, Voxel, cell_index};
use crate::rng::SplitMix64;
use crate::shape::{is_notchable, notch_closure, parts};
use crate::solver::{SolveOptions, Status, solve};

/// Default state cap of one check: generated puzzles solve in far fewer states, and a check that
/// needs more is better rejected than waited for.
pub const DEFAULT_CHECK_STATES: u64 = 100_000;

/// `owner` of a cell no piece fills.
const FREE: u8 = u8::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GeneratorOptions {
    pub seed: u64,
    /// State cap of each check.
    pub max_states: u64,
    /// The search sets the perturbations and the restarts itself (see `AUTO_REMOVED` and
    /// `Generator::restart_due`); `max_removed` and `restart_after` are then unused.
    pub auto: bool,
    /// A perturbation removes 1 to `max_removed` added voxels (R).
    pub max_removed: u32,
    /// Restart from the base after this many passes without improvement (N); 0 never restarts.
    pub restart_after: u32,
    /// Size of the leaderboard, and of its part that fills the target.
    pub keep: usize,
    /// Fewer holes rank before a higher level: the search heads for puzzles that fill the target.
    pub fill_target: bool,
}

impl Default for GeneratorOptions {
    fn default() -> Self {
        Self {
            seed: 0,
            max_states: DEFAULT_CHECK_STATES,
            auto: true,
            max_removed: 10,
            restart_after: 100,
            keep: 20,
            fill_target: false,
        }
    }
}

/// With `auto`, a perturbation removes 1 to this many added voxels.
const AUTO_REMOVED: u64 = 12;

/// With `auto`, the stall before a restart, in multiples of the checks the climb took to reach its
/// last improvement, and at least in passes from the base (`Generator::restart_due`).
const AUTO_PATIENCE: u64 = 2;
const AUTO_MIN_PASSES: u64 = 2;

/// What the generator maximizes: the level, then the total moves (SPEC §4.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct Score {
    pub level: u32,
    pub total_moves: u32,
}

/// A recorded puzzle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Entry {
    /// `canonical_key`, in hexadecimal.
    pub key: String,
    pub score: Score,
    pub level_string: String,
    /// Holes: required cells of the target that no piece fills; 0 without a target.
    pub holes: usize,
    /// The base with the added voxels fixed. Optional cells that no piece fills stay optional.
    pub document: Document,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StepReport {
    /// Totals since the start of the run.
    pub checks: u64,
    /// Checks that reached the state cap.
    pub aborted: u64,
    pub passes: u64,
    pub restarts: u64,
    /// Score of the accepted state, from which the passes start.
    pub current: Score,
    /// Best recorded score.
    pub best: Option<Score>,
    /// Best recorded score without holes.
    pub best_filled: Option<Score>,
    /// Leaderboard entries recorded since the previous report.
    pub entries: Vec<Entry>,
}

#[derive(Debug)]
pub enum GeneratorError {
    Document(DocumentError),
    Model(ModelError),
    NotNotchable(usize),
    BaseUnsolvable,
    BaseAborted(u64),
    NoCandidate,
}

impl fmt::Display for GeneratorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Document(e) => e.fmt(f),
            Self::Model(e) => e.fmt(f),
            Self::NotNotchable(p) => write!(f, "piece {p} must stay notchable, but its fixed voxels are not notchable"),
            Self::BaseUnsolvable => write!(f, "the base (fixed voxels) cannot be taken apart"),
            Self::BaseAborted(cap) => write!(f, "checking the base needs more than {cap} states"),
            Self::NoCandidate => write!(f, "no optional cell can be added to the base"),
        }
    }
}

impl std::error::Error for GeneratorError {}

/// The pieces of a puzzle being built, the piece filling each cell, and the score.
#[derive(Clone, Debug)]
struct State {
    pieces: Vec<Vec<Voxel>>,
    owner: Vec<u8>,
    score: Score,
    level_string: String,
    /// Parts of the pieces beyond one per piece, 0 when every piece is face-connected; set at the
    /// end of a pass.
    extra_parts: usize,
    /// Required cells of the target that no piece fills; set at the end of a pass.
    holes: usize,
}

impl State {
    fn rank(&self, fill_target: bool) -> (Reverse<usize>, Reverse<usize>, Score) {
        (Reverse(self.extra_parts), Reverse(if fill_target { self.holes } else { 0 }), self.score)
    }
}

fn extra_parts(pieces: &[Vec<Voxel>]) -> usize {
    pieces.iter().map(|p| parts(p).saturating_sub(1)).sum()
}

fn holes(required: &[usize], owner: &[u8]) -> usize {
    required.iter().filter(|&&c| owner[c] == FREE).count()
}

enum Check {
    Solved(Score, String),
    Unsolvable,
    Aborted,
}

/// What adding a candidate to a state does.
enum Addition {
    /// Adds these voxels to the piece.
    Adds(Vec<Voxel>),
    /// Nothing yet: the cell does not touch the piece, but may once the piece has grown.
    NotYet,
    /// Nothing in this pass: the cell is filled, or the notch closure of a notchable piece needs a
    /// cell that is filled or not optional for it.
    Never,
}

fn check(grid: [i32; 3], pieces: &[Vec<Voxel>], max_states: u64) -> Check {
    let puzzle = Puzzle::new(grid, pieces.to_vec()).expect("the generator keeps the pieces valid");
    let result = solve(&puzzle, &SolveOptions { max_states });
    match (result.status, result.solution) {
        (Status::Solved, Some(s)) => {
            Check::Solved(Score { level: s.level, total_moves: s.total_moves }, s.level_string)
        }
        (Status::Aborted, _) => Check::Aborted,
        _ => Check::Unsolvable,
    }
}

pub struct Generator {
    doc: Document,
    options: GeneratorOptions,
    grid: [i32; 3],
    rng: SplitMix64,
    /// Per cell: the pieces it is optional for, as a bitmask.
    optional: Vec<u32>,
    notchable: Vec<bool>,
    /// Per cell: the piece it is fixed for, or `FREE`.
    base_owner: Vec<u8>,
    /// The required cells of the target.
    required: Vec<usize>,
    base: State,
    /// (cell, piece) pairs where the cell is optional for the piece and fixed for none.
    candidates: Vec<(Voxel, usize)>,
    accepted: State,
    current: State,
    /// The candidate order of the sweep, and the next one to try; `None` between passes.
    order: Vec<usize>,
    next: Option<usize>,
    /// Candidates of the sweep that did not touch their piece, for the next sweep.
    deferred: Vec<usize>,
    /// The sweep added a candidate.
    grew: bool,
    /// The next pass starts from the base, not from a perturbation of the accepted state.
    from_base: bool,
    /// Passes since the accepted score last improved.
    stale: u32,
    /// `checks` at the last restart (or the start), and at the last improvement since.
    restarted_at: u64,
    improved_at: u64,
    /// `checks` at the start of the pass, and whether it started from the base.
    pass_start: u64,
    pass_from_base: bool,
    /// Checks of the last pass from the base: the cost of a fresh start.
    base_checks: u64,
    checks: u64,
    aborted: u64,
    passes: u64,
    restarts: u64,
    /// The `keep` best entries and the `keep` best without holes, best first; equal scores in the
    /// order recorded.
    board: Vec<Entry>,
    /// Keys recorded since the last report.
    fresh: Vec<String>,
}

impl Generator {
    /// Prepares a run on a base document: its fixed voxels must form a solvable puzzle, and at
    /// least one optional cell must be addable.
    pub fn new(doc: &Document, options: GeneratorOptions) -> Result<Self, GeneratorError> {
        doc.validate().map_err(GeneratorError::Document)?;
        let puzzle = doc.to_puzzle().map_err(GeneratorError::Model)?;
        if let Some(p) = doc.pieces.iter().position(|p| p.notchable && !is_notchable(&p.fixed)) {
            return Err(GeneratorError::NotNotchable(p));
        }
        let grid = doc.grid;
        let n_cells = (grid[0] * grid[1] * grid[2]) as usize;
        let mut base_owner = vec![FREE; n_cells];
        for (p, piece) in puzzle.pieces().iter().enumerate() {
            for &v in piece {
                base_owner[cell_index(grid, v)] = p as u8;
            }
        }
        let mut optional = vec![0u32; n_cells];
        let mut candidates = Vec::new();
        for (p, piece) in doc.pieces.iter().enumerate() {
            let mut cells = piece.optional.clone();
            cells.sort_unstable();
            cells.dedup();
            for v in cells {
                let i = cell_index(grid, v);
                optional[i] |= 1 << p;
                if base_owner[i] == FREE {
                    candidates.push((v, p));
                }
            }
        }
        let mut required: Vec<usize> =
            doc.target.iter().flat_map(|t| &t.required).map(|&v| cell_index(grid, v)).collect();
        required.sort_unstable();
        required.dedup();
        let (score, level_string) = match check(grid, puzzle.pieces(), options.max_states) {
            Check::Solved(score, level_string) => (score, level_string),
            Check::Unsolvable => return Err(GeneratorError::BaseUnsolvable),
            Check::Aborted => return Err(GeneratorError::BaseAborted(options.max_states)),
        };
        let base = State {
            extra_parts: extra_parts(puzzle.pieces()),
            holes: holes(&required, &base_owner),
            pieces: puzzle.pieces().to_vec(),
            owner: base_owner.clone(),
            score,
            level_string,
        };
        let generator = Self {
            doc: doc.clone(),
            grid,
            rng: SplitMix64::new(options.seed),
            options,
            optional,
            notchable: doc.pieces.iter().map(|p| p.notchable).collect(),
            base_owner,
            required,
            accepted: base.clone(),
            current: base.clone(),
            base,
            candidates,
            order: Vec::new(),
            next: None,
            deferred: Vec::new(),
            grew: false,
            from_base: true,
            stale: 0,
            restarted_at: 0,
            improved_at: 0,
            pass_start: 0,
            pass_from_base: false,
            base_checks: 0,
            checks: 1,
            aborted: 0,
            passes: 0,
            restarts: 0,
            board: Vec::new(),
            fresh: Vec::new(),
        };
        // Whether a candidate can be added does not depend on the order until one is added.
        if !(0..generator.candidates.len()).any(|i| matches!(generator.addition(&generator.base, i), Addition::Adds(_)))
        {
            return Err(GeneratorError::NoCandidate);
        }
        Ok(generator)
    }

    /// Runs until `max_checks` more checks are done (at least one) and reports.
    pub fn step(&mut self, max_checks: u64) -> StepReport {
        // Every pass checks at least once: a pass from the base tries an addable candidate (`new`
        // makes sure there is one), and a pass from a perturbation checks its start.
        let stop = self.checks + max_checks.max(1);
        while self.checks < stop {
            match self.next {
                None => self.start_pass(),
                Some(i) if i < self.order.len() => {
                    self.next = Some(i + 1);
                    self.try_candidate(self.order[i]);
                }
                Some(_) if self.grew && !self.deferred.is_empty() => {
                    self.order = std::mem::take(&mut self.deferred);
                    self.grew = false;
                    self.next = Some(0);
                }
                Some(_) => {
                    let mut state = std::mem::replace(&mut self.current, self.base.clone());
                    self.join_parts(&mut state);
                    self.end_pass(Some(state));
                }
            }
        }
        let fresh = std::mem::take(&mut self.fresh);
        StepReport {
            checks: self.checks,
            aborted: self.aborted,
            passes: self.passes,
            restarts: self.restarts,
            current: self.accepted.score,
            best: self.board.first().map(|e| e.score),
            best_filled: self.board.iter().find(|e| e.holes == 0).map(|e| e.score),
            entries: self.board.iter().filter(|e| fresh.contains(&e.key)).cloned().collect(),
        }
    }

    /// The leaderboard, best first.
    pub fn board(&self) -> &[Entry] {
        &self.board
    }

    fn check(&mut self, pieces: &[Vec<Voxel>]) -> Option<(Score, String)> {
        self.checks += 1;
        match check(self.grid, pieces, self.options.max_states) {
            Check::Solved(score, level_string) => Some((score, level_string)),
            Check::Unsolvable => None,
            Check::Aborted => {
                self.aborted += 1;
                None
            }
        }
    }

    fn start_pass(&mut self) {
        self.pass_start = self.checks;
        self.pass_from_base = self.from_base;
        if self.from_base {
            self.from_base = false;
            self.current = self.base.clone();
        } else {
            let mut state = self.accepted.clone();
            self.perturb(&mut state);
            let Some((score, level_string)) = self.check(&state.pieces) else {
                // Only the cap can stop a check of a subset of a solvable puzzle.
                self.end_pass(None);
                return;
            };
            (state.score, state.level_string) = (score, level_string);
            self.current = state;
        }
        self.order = (0..self.candidates.len()).collect();
        self.rng.shuffle(&mut self.order);
        self.deferred.clear();
        self.grew = false;
        self.next = Some(0);
    }

    fn end_pass(&mut self, result: Option<State>) {
        self.passes += 1;
        self.next = None;
        if self.pass_from_base {
            self.base_checks = self.checks - self.pass_start;
        }
        match result {
            Some(mut state) => {
                state.extra_parts = extra_parts(&state.pieces);
                state.holes = holes(&self.required, &state.owner);
                self.record(&state);
                let (rank, accepted) =
                    (state.rank(self.options.fill_target), self.accepted.rank(self.options.fill_target));
                if rank > accepted {
                    self.stale = 0;
                    self.improved_at = self.checks;
                } else {
                    self.stale += 1;
                }
                if rank >= accepted {
                    self.accepted = state;
                }
            }
            None => self.stale += 1,
        }
        if self.restart_due() {
            self.restarts += 1;
            self.stale = 0;
            self.restarted_at = self.checks;
            self.improved_at = self.checks;
            self.accepted = self.base.clone();
            self.from_base = true;
        }
    }

    /// Whether the search goes back to the base. With `auto`, a climb may go without improvement for
    /// `AUTO_PATIENCE` times the checks it took to reach its last improvement, and for at least
    /// `AUTO_MIN_PASSES` passes from the base: a climb that kept improving (sparse designs) has
    /// shown it can go further and seldom restarts, and one that stalls early (dense targets) soon
    /// does. The rule counts checks, so it depends neither on pass lengths nor on `step` sizes.
    fn restart_due(&self) -> bool {
        if !self.options.auto {
            return self.options.restart_after > 0 && self.stale >= self.options.restart_after;
        }
        let climb = self.improved_at - self.restarted_at;
        self.checks - self.improved_at >= (AUTO_PATIENCE * climb).max(AUTO_MIN_PASSES * self.base_checks)
    }

    /// What adding candidate `i` to `state` does.
    fn addition(&self, state: &State, i: usize) -> Addition {
        let (cell, p) = self.candidates[i];
        if state.owner[cell_index(self.grid, cell)] != FREE {
            return Addition::Never;
        }
        if !self.neighbours(cell).any(|n| state.owner[cell_index(self.grid, n)] == p as u8) {
            return Addition::NotYet;
        }
        if !self.notchable[p] {
            return Addition::Adds(vec![cell]);
        }
        let mut grown = state.pieces[p].clone();
        grown.push(cell);
        let mut added = notch_closure(&grown);
        added.retain(|&v| state.owner[cell_index(self.grid, v)] != p as u8);
        let free = added.iter().all(|&v| {
            let c = cell_index(self.grid, v);
            state.owner[c] == FREE && self.optional[c] >> p & 1 == 1
        });
        if free { Addition::Adds(added) } else { Addition::Never }
    }

    /// The cells of the grid that share a face with `v`.
    fn neighbours(&self, v: Voxel) -> impl Iterator<Item = Voxel> + '_ {
        (0..3).flat_map(move |a| {
            [-1, 1].into_iter().filter_map(move |s| {
                let mut n = v;
                n[a] += s;
                (0..self.grid[a]).contains(&n[a]).then_some(n)
            })
        })
    }

    fn try_candidate(&mut self, i: usize) {
        let added = match self.addition(&self.current, i) {
            Addition::Adds(added) => added,
            Addition::NotYet => {
                self.deferred.push(i);
                return;
            }
            Addition::Never => return,
        };
        let p = self.candidates[i].1;
        let len = self.current.pieces[p].len();
        self.current.pieces[p].extend_from_slice(&added);
        let pieces = std::mem::take(&mut self.current.pieces);
        let checked = self.check(&pieces);
        self.current.pieces = pieces;
        match checked {
            Some((score, level_string)) => {
                (self.current.score, self.current.level_string) = (score, level_string);
                for &v in &added {
                    self.current.owner[cell_index(self.grid, v)] = p as u8;
                }
                self.grew = true;
            }
            None => self.current.pieces[p].truncate(len),
        }
    }

    /// Removes 1 to R (`AUTO_REMOVED` with `auto`) added voxels at random. From a notchable piece,
    /// the whole line of the piece through the voxel goes, along an axis where that line has no
    /// fixed voxel: what is left is still notchable (any cell of its closure lies in the piece, off
    /// that line). From another piece, the added voxels that no longer link to its base voxels go
    /// too.
    fn perturb(&mut self, state: &mut State) {
        let max_removed = if self.options.auto { AUTO_REMOVED } else { u64::from(self.options.max_removed.max(1)) };
        let r = 1 + self.rng.below(max_removed);
        for _ in 0..r {
            let added: Vec<(usize, Voxel)> = (0..state.pieces.len())
                .flat_map(|p| state.pieces[p].iter().map(move |&v| (p, v)))
                .filter(|&(p, v)| self.base_owner[cell_index(self.grid, v)] != p as u8)
                .collect();
            if added.is_empty() {
                return;
            }
            let (p, v) = added[self.rng.below(added.len() as u64) as usize];
            let removed: Vec<Voxel> = if self.notchable[p] {
                let line =
                    |a: usize| state.pieces[p].iter().copied().filter(move |w| (0..3).all(|b| b == a || w[b] == v[b]));
                let axes: Vec<usize> =
                    (0..3).filter(|&a| line(a).all(|w| self.base_owner[cell_index(self.grid, w)] != p as u8)).collect();
                if axes.is_empty() {
                    continue;
                }
                line(axes[self.rng.below(axes.len() as u64) as usize]).collect()
            } else {
                vec![v]
            };
            for &w in &removed {
                state.owner[cell_index(self.grid, w)] = FREE;
            }
            state.pieces[p].retain(|w| !removed.contains(w));
            if !self.notchable[p] {
                self.drop_unlinked(state, p);
            }
        }
    }

    /// Joins the parts of each split piece that is not notchable with a cheapest bridge of cells
    /// optional for it (see `bridge`), taken from other pieces only when those do not split. A
    /// bridge stays when the puzzle is still solvable.
    fn join_parts(&mut self, state: &mut State) {
        for p in 0..state.pieces.len() {
            if self.notchable[p] {
                continue;
            }
            while parts(&state.pieces[p]) > 1 {
                let Some(bridge) = self.bridge(state, p) else {
                    break;
                };
                let mut next = state.clone();
                for &v in &bridge {
                    let c = cell_index(self.grid, v);
                    if next.owner[c] != FREE {
                        next.pieces[next.owner[c] as usize].retain(|&w| w != v);
                    }
                    next.owner[c] = p as u8;
                    next.pieces[p].push(v);
                }
                if (0..next.pieces.len()).any(|q| q != p && parts(&next.pieces[q]) > parts(&state.pieces[q])) {
                    break;
                }
                let Some((score, level_string)) = self.check(&next.pieces) else {
                    break;
                };
                (next.score, next.level_string) = (score, level_string);
                *state = next;
            }
        }
    }

    /// The cells of a cheapest path, through cells optional for piece `p`, from the part of its
    /// first voxel to another of its parts. An empty cell costs 1, and a voxel another piece added
    /// costs 2 (base voxels are never optional for another piece). At the end of a pass, an empty
    /// cell touching the piece was already rejected, so most bridges take voxels of other pieces.
    fn bridge(&self, state: &State, p: usize) -> Option<Vec<Voxel>> {
        let piece: HashSet<Voxel> = state.pieces[p].iter().copied().collect();
        let mut part = vec![state.pieces[p][0]];
        let mut in_part: HashSet<Voxel> = part.iter().copied().collect();
        let mut k = 0;
        while k < part.len() {
            for n in self.neighbours(part[k]) {
                if piece.contains(&n) && in_part.insert(n) {
                    part.push(n);
                }
            }
            k += 1;
        }
        // Dijkstra: the cost of each cell reached, and the cell it was reached from.
        let mut best: HashMap<Voxel, (u32, Voxel)> = HashMap::new();
        let mut heap: BinaryHeap<Reverse<(u32, Voxel)>> = part.iter().map(|&v| Reverse((0, v))).collect();
        while let Some(Reverse((d, v))) = heap.pop() {
            if best.get(&v).is_some_and(|&(e, _)| e < d) {
                continue;
            }
            for n in self.neighbours(v) {
                if in_part.contains(&n) {
                    continue;
                }
                if piece.contains(&n) {
                    let mut path = Vec::new();
                    let mut w = v;
                    while !in_part.contains(&w) {
                        path.push(w);
                        w = best[&w].1;
                    }
                    return Some(path);
                }
                let c = cell_index(self.grid, n);
                if self.optional[c] >> p & 1 == 0 {
                    continue;
                }
                let e = d + if state.owner[c] == FREE { 1 } else { 2 };
                if best.get(&n).is_none_or(|&(f, _)| e < f) {
                    best.insert(n, (e, v));
                    heap.push(Reverse((e, n)));
                }
            }
        }
        None
    }

    /// Removes the voxels of piece `p` that no face-connected path within the piece links to one of
    /// its base voxels.
    fn drop_unlinked(&self, state: &mut State, p: usize) {
        let piece: HashSet<Voxel> = state.pieces[p].iter().copied().collect();
        let mut stack: Vec<Voxel> =
            state.pieces[p].iter().copied().filter(|&v| self.base_owner[cell_index(self.grid, v)] == p as u8).collect();
        let mut linked: HashSet<Voxel> = stack.iter().copied().collect();
        while let Some(v) = stack.pop() {
            for n in self.neighbours(v) {
                if piece.contains(&n) && linked.insert(n) {
                    stack.push(n);
                }
            }
        }
        for &v in &state.pieces[p] {
            if !linked.contains(&v) {
                state.owner[cell_index(self.grid, v)] = FREE;
            }
        }
        state.pieces[p].retain(|v| linked.contains(v));
    }

    /// Adds a pass result to the leaderboard when its pieces are connected and it is among the best
    /// distinct puzzles, or among the best distinct puzzles without holes.
    fn record(&mut self, state: &State) {
        let keep = self.options.keep;
        if state.extra_parts > 0 {
            return;
        }
        let at = self.board.partition_point(|e| e.score >= state.score);
        if at >= keep && (state.holes > 0 || self.board[..at].iter().filter(|e| e.holes == 0).count() >= keep) {
            return;
        }
        let puzzle = Puzzle::new(self.grid, state.pieces.clone()).expect("the generator keeps the pieces valid");
        let key = canonical_key(&puzzle).iter().fold(String::new(), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        });
        if self.board.iter().any(|e| e.key == key) {
            return;
        }
        let entry = Entry {
            key: key.clone(),
            score: state.score,
            level_string: state.level_string.clone(),
            holes: state.holes,
            document: self.document(state),
        };
        self.board.insert(at, entry);
        let (mut all, mut filled) = (0, 0);
        self.board.retain(|e| {
            let kept = all < keep || (e.holes == 0 && filled < keep);
            all += 1;
            filled += usize::from(e.holes == 0);
            kept
        });
        self.fresh.push(key);
    }

    fn document(&self, state: &State) -> Document {
        let mut doc = self.doc.clone();
        for (p, piece) in doc.pieces.iter_mut().enumerate() {
            piece.fixed = state.pieces[p].clone();
            piece.fixed.sort_unstable();
            piece.optional.retain(|&v| state.owner[cell_index(self.grid, v)] == FREE);
        }
        doc.name = format!("{} (level {})", self.doc.name, state.level_string);
        doc.meta.source = format!("generated from {:?}, seed {}", self.doc.name, self.options.seed);
        doc.meta.created.clear();
        doc.meta.updated.clear();
        doc
    }
}

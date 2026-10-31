//! Disassembly solver (SPEC §3.1).
//!
//! Breadth-first search over the relative offsets of the pieces of a part. The first piece of a
//! part never moves: sliding a group is the same as sliding its complement the other way, so only
//! groups without the first piece are moved, and states need no other normalization. At each
//! separation, both halves are solved recursively. If one of them cannot be taken apart, neither
//! can the puzzle: solvability passes to any subset of the pieces left in place (a disassembly of
//! the whole, restricted to the subset, is one of the subset), and every move can be undone, so
//! all states of the search are equally solvable. The search then stops.
//!
//! Moves are tried in the order of the reference solver: groups as ascending bitmasks, then
//! +x, −x, +y, −y, +z, −z, then distances ascending; at a separation the part keeping the first
//! piece is solved before the removed part. This fixes how ties between equally short
//! disassemblies are broken.

use serde::Serialize;

use crate::collision::{CollisionCache, INF};
use crate::hash::{FxHashMap, hash_i16s};
use crate::model::Puzzle;

/// Default cap on the number of states explored by one `solve` (SPEC §3.3).
pub const DEFAULT_MAX_STATES: u64 = 5_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
pub enum Dir {
    #[serde(rename = "+x")]
    PosX,
    #[serde(rename = "-x")]
    NegX,
    #[serde(rename = "+y")]
    PosY,
    #[serde(rename = "-y")]
    NegY,
    #[serde(rename = "+z")]
    PosZ,
    #[serde(rename = "-z")]
    NegZ,
}

impl Dir {
    pub const ALL: [Dir; 6] = [Dir::PosX, Dir::NegX, Dir::PosY, Dir::NegY, Dir::PosZ, Dir::NegZ];

    pub fn axis(self) -> usize {
        self as usize / 2
    }

    pub fn sign(self) -> i32 {
        if (self as usize).is_multiple_of(2) { 1 } else { -1 }
    }

    pub fn vector(self) -> [i32; 3] {
        let mut v = [0; 3];
        v[self.axis()] = self.sign();
        v
    }
}

/// One move: the pieces of `pieces` (bitmask of piece indices) slide together by `dist` cells
/// along `dir`, or away for good when `dist` is `None` (a separation).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Move {
    pub pieces: u32,
    pub dir: Dir,
    pub dist: Option<u32>,
}

/// Disassembly of the part `pieces`: `moves` up to and including the separation that takes away
/// the group `removed`, then the disassemblies of the part left behind and of the removed group
/// (`None` for a single piece).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Node {
    pub pieces: u32,
    pub moves: Vec<Move>,
    pub removed: u32,
    pub remaining: Option<Box<Node>>,
    pub removed_tree: Option<Box<Node>>,
}

impl Node {
    /// BurrTools notation (SPEC §1.2): the moves of this node, then the level strings of the
    /// subtrees that need more than one move somewhere, each after a dot.
    pub fn level_string(&self) -> String {
        let mut s = self.moves.len().to_string();
        for child in [&self.remaining, &self.removed_tree] {
            if let Some(child) = child.as_deref().filter(|c| c.needs_moves()) {
                s.push('.');
                s.push_str(&child.level_string());
            }
        }
        s
    }

    fn needs_moves(&self) -> bool {
        self.moves.len() >= 2
            || [&self.remaining, &self.removed_tree].iter().any(|c| c.as_deref().is_some_and(Node::needs_moves))
    }

    /// Number of moves of the whole disassembly, separations included.
    pub fn total_moves(&self) -> u32 {
        let sub = |c: &Option<Box<Node>>| c.as_deref().map_or(0, Node::total_moves);
        self.moves.len() as u32 + sub(&self.remaining) + sub(&self.removed_tree)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Solution {
    /// Moves up to the first separation.
    pub level: u32,
    pub level_string: String,
    pub total_moves: u32,
    pub tree: Node,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Solved,
    Unsolvable,
    /// The state cap was reached first.
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SolveResult {
    pub status: Status,
    /// States explored, over all sub-problems.
    pub states: u64,
    pub solution: Option<Solution>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SolveOptions {
    /// Cap on the states explored, summed over the recursion. Exceeding it aborts the solve.
    pub max_states: u64,
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self { max_states: DEFAULT_MAX_STATES }
    }
}

/// Finds the shortest disassembly of an assembled puzzle (SPEC §3).
pub fn solve(puzzle: &Puzzle, options: &SolveOptions) -> SolveResult {
    let pieces = puzzle.pieces();
    let mut solver = Solver {
        cache: CollisionCache::new(pieces),
        memo: FxHashMap::default(),
        states: 0,
        max_states: options.max_states,
    };
    let ids: Vec<usize> = (0..pieces.len()).collect();
    let result = solver.solve_part(&ids, &vec![0; 3 * ids.len()]);
    let (status, solution) = match result {
        Ok(Sub::Solved(tree)) => {
            let tree = *tree.expect("a puzzle has at least two pieces");
            let solution = Solution {
                level: tree.moves.len() as u32,
                level_string: tree.level_string(),
                total_moves: tree.total_moves(),
                tree,
            };
            (Status::Solved, Some(solution))
        }
        Ok(Sub::Unsolvable) => (Status::Unsolvable, None),
        Err(Aborted) => (Status::Aborted, None),
    };
    SolveResult { status, states: solver.states, solution }
}

/// The state cap was exceeded.
struct Aborted;

/// Outcome of a sub-problem; `Solved(None)` for a single piece.
#[derive(Clone)]
enum Sub {
    Unsolvable,
    Solved(Option<Box<Node>>),
}

struct Solver {
    cache: CollisionCache,
    /// Sub-problems by (bitmask of pieces, offsets relative to the first piece).
    memo: FxHashMap<(u32, Vec<i16>), Sub>,
    states: u64,
    max_states: u64,
}

/// A step of the search: the state it came from and the move (local group, direction, distance).
struct Step {
    parent: u32,
    group: u32,
    dir: Dir,
    dist: u32,
}

impl Solver {
    fn count_state(&mut self) -> Result<(), Aborted> {
        self.states += 1;
        if self.states > self.max_states { Err(Aborted) } else { Ok(()) }
    }

    /// Solves the part made of pieces `ids` (ascending) at `offs`, three per piece, the first
    /// piece at the origin.
    fn solve_part(&mut self, ids: &[usize], offs: &[i16]) -> Result<Sub, Aborted> {
        if ids.len() == 1 {
            return Ok(Sub::Solved(None));
        }
        let key = (ids.iter().fold(0u32, |mask, &i| mask | 1 << i), offs.to_vec());
        if let Some(sub) = self.memo.get(&key) {
            return Ok(sub.clone());
        }
        let sub = self.search(ids, offs)?;
        self.memo.insert(key, sub.clone());
        Ok(sub)
    }

    fn search(&mut self, ids: &[usize], root: &[i16]) -> Result<Sub, Aborted> {
        let m = ids.len();
        let global = |local: u32| bits(local).fold(0u32, |mask, i| mask | 1 << ids[i]);

        let mut table = StateTable::new(3 * m);
        let mut steps = vec![Step { parent: u32::MAX, group: 0, dir: Dir::PosX, dist: 0 }];
        table.insert(root);
        self.count_state()?;

        let mut dist = vec![0u32; 6 * m * m];
        let mut groups = Groups::default();
        let mut cur = vec![0i16; 3 * m];
        let mut next = vec![0i16; 3 * m];
        let mut s = 0;
        while s < table.len() {
            cur.copy_from_slice(table.get(s));
            self.cache.distances(ids, &cur, &mut dist);
            groups.find(m, &dist);
            for &(group, dir, max) in &groups.moves {
                if max == INF {
                    let Some((remaining, removed_tree)) = self.split(ids, &cur, group)? else {
                        return Ok(Sub::Unsolvable);
                    };
                    let mut moves = Vec::new();
                    let mut t = s;
                    while t != 0 {
                        let step = &steps[t];
                        moves.push(Move { pieces: global(step.group), dir: step.dir, dist: Some(step.dist) });
                        t = step.parent as usize;
                    }
                    moves.reverse();
                    moves.push(Move { pieces: global(group), dir, dist: None });
                    let pieces = ids.iter().fold(0u32, |mask, &i| mask | 1 << i);
                    let node = Node { pieces, moves, removed: global(group), remaining, removed_tree };
                    return Ok(Sub::Solved(Some(Box::new(node))));
                }
                let (axis, sign) = (dir.axis(), dir.sign());
                for k in 1..=max {
                    next.copy_from_slice(&cur);
                    for i in bits(group) {
                        let c = next[3 * i + axis] as i32 + sign * k as i32;
                        debug_assert!(i16::try_from(c).is_ok(), "offset out of range");
                        next[3 * i + axis] = c as i16;
                    }
                    if table.insert(&next) {
                        steps.push(Step { parent: s as u32, group, dir, dist: k });
                        self.count_state()?;
                    }
                }
            }
            s += 1;
        }
        Ok(Sub::Unsolvable)
    }

    /// Solves both parts after the local `group` is taken away from the state `offs`. `None` when
    /// one of them cannot be taken apart.
    #[allow(clippy::type_complexity)]
    fn split(
        &mut self,
        ids: &[usize],
        offs: &[i16],
        group: u32,
    ) -> Result<Option<(Option<Box<Node>>, Option<Box<Node>>)>, Aborted> {
        let mut trees = [None, None];
        for (t, removed) in [false, true].into_iter().enumerate() {
            let members: Vec<usize> = (0..ids.len()).filter(|&i| (group >> i & 1 == 1) == removed).collect();
            let first = members[0];
            let part_ids: Vec<usize> = members.iter().map(|&i| ids[i]).collect();
            let part_offs: Vec<i16> =
                members.iter().flat_map(|&i| (0..3).map(move |c| offs[3 * i + c] - offs[3 * first + c])).collect();
            match self.solve_part(&part_ids, &part_offs)? {
                Sub::Unsolvable => return Ok(None),
                Sub::Solved(tree) => trees[t] = tree,
            }
        }
        let [remaining, removed_tree] = trees;
        Ok(Some((remaining, removed_tree)))
    }
}

/// Indices of the set bits of a mask, ascending.
fn bits(mut mask: u32) -> impl Iterator<Item = usize> {
    std::iter::from_fn(move || {
        (mask != 0).then(|| {
            let i = mask.trailing_zeros() as usize;
            mask &= mask - 1;
            i
        })
    })
}

/// The moves of one state.
#[derive(Default)]
struct Groups {
    /// (local group, direction, largest distance or INF for a separation), sorted by group then
    /// direction.
    moves: Vec<(u32, Dir, u32)>,
    unions: Vec<u32>,
}

impl Groups {
    /// Fills `moves` from the first collision distances of the `m` pieces of a state.
    ///
    /// A group can move by one cell along a direction iff it holds every piece that a member would
    /// push. The groups closed under "pushes" are the unions of the closures of single pieces; the
    /// ones without piece 0 are the movable groups. Groups holding piece 0 are covered by their
    /// complements moving the other way.
    fn find(&mut self, m: usize, dist: &[u32]) {
        self.moves.clear();
        let all = if m == 32 { u32::MAX } else { (1 << m) - 1 };
        for dir in Dir::ALL {
            let d = &dist[dir as usize * m * m..][..m * m];
            let mut reach = [0u32; 32];
            for i in 0..m {
                reach[i] = 1 << i;
                for j in (0..m).filter(|&j| j != i && d[i * m + j] == 1) {
                    reach[i] |= 1 << j;
                }
            }
            for k in 0..m {
                for i in 0..m {
                    if reach[i] >> k & 1 == 1 {
                        reach[i] |= reach[k];
                    }
                }
            }
            self.unions.clear();
            for &closure in &reach[1..m] {
                if closure & 1 != 0 || self.unions.contains(&closure) {
                    continue;
                }
                for u in 0..self.unions.len() {
                    let union = self.unions[u] | closure;
                    self.unions.push(union);
                }
                self.unions.push(closure);
                self.unions.sort_unstable();
                self.unions.dedup();
            }
            for &group in &self.unions {
                let mut first_hit = INF;
                for i in bits(group) {
                    for j in bits(all & !group) {
                        first_hit = first_hit.min(d[i * m + j]);
                    }
                }
                let max = if first_hit == INF { INF } else { first_hit - 1 };
                self.moves.push((group, dir, max));
            }
        }
        self.moves.sort_unstable_by_key(|&(group, dir, _)| (group, dir));
    }
}

/// Insertion-ordered set of states (offset vectors of a fixed length), with open addressing.
struct StateTable {
    stride: usize,
    coords: Vec<i16>,
    /// State index per slot, `EMPTY` when free. The length is a power of two.
    slots: Vec<u32>,
    shift: u32,
}

const EMPTY: u32 = u32::MAX;

impl StateTable {
    const INITIAL_BITS: u32 = 10;

    fn new(stride: usize) -> Self {
        Self { stride, coords: Vec::new(), slots: vec![EMPTY; 1 << Self::INITIAL_BITS], shift: 64 - Self::INITIAL_BITS }
    }

    fn len(&self) -> usize {
        self.coords.len() / self.stride
    }

    fn get(&self, s: usize) -> &[i16] {
        &self.coords[s * self.stride..][..self.stride]
    }

    /// Adds `key` unless present; returns whether it was added.
    fn insert(&mut self, key: &[i16]) -> bool {
        if 2 * (self.len() + 1) > self.slots.len() {
            self.grow();
        }
        let mask = self.slots.len() - 1;
        let mut i = (hash_i16s(key) >> self.shift) as usize;
        loop {
            match self.slots[i] {
                EMPTY => {
                    self.slots[i] = self.len() as u32;
                    self.coords.extend_from_slice(key);
                    return true;
                }
                s if self.get(s as usize) == key => return false,
                _ => i = (i + 1) & mask,
            }
        }
    }

    fn grow(&mut self) {
        self.shift -= 1;
        let mut slots = vec![EMPTY; 2 * self.slots.len()];
        let mask = slots.len() - 1;
        for s in 0..self.len() {
            let mut i = (hash_i16s(self.get(s)) >> self.shift) as usize;
            while slots[i] != EMPTY {
                i = (i + 1) & mask;
            }
            slots[i] = s as u32;
        }
        self.slots = slots;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_table_keeps_insertion_order() {
        let mut table = StateTable::new(3);
        for k in 0..5000i16 {
            assert!(table.insert(&[k, -k, k / 7]));
        }
        for k in 0..5000i16 {
            assert!(!table.insert(&[k, -k, k / 7]));
            assert_eq!(table.get(k as usize), &[k, -k, k / 7]);
        }
        assert_eq!(table.len(), 5000);
    }

    fn leaf(pieces: u32, removed: u32, moves: usize) -> Node {
        let mv = Move { pieces: removed, dir: Dir::PosX, dist: Some(1) };
        Node { pieces, moves: vec![mv; moves], removed, remaining: None, removed_tree: None }
    }

    #[test]
    fn level_string_follows_burrtools() {
        // 4 moves, then the remaining part needs 8, then 1 more whose remaining part needs 2.
        let inner = Node { remaining: Some(Box::new(leaf(0b11, 0b10, 2))), ..leaf(0b111, 0b100, 1) };
        let mid = Node { remaining: Some(Box::new(inner)), ..leaf(0b1111, 0b1000, 8) };
        let root = Node {
            remaining: Some(Box::new(mid)),
            removed_tree: Some(Box::new(leaf(0b110000, 0b100000, 1))),
            ..leaf(0b111111, 0b110000, 4)
        };
        assert_eq!(root.level_string(), "4.8.1.2");
        assert_eq!(root.total_moves(), 16);
    }
}

//! Collision cache (SPEC §3.1).
//!
//! For pieces i < j, the difference set Δ_ij = {b − a : a ∈ V_i, b ∈ V_j} holds every contact:
//! piece i at offset o_i overlaps piece j at offset o_j iff o_i − o_j ∈ Δ_ij. The set is built once
//! per solve and stored as bit rows along each axis, so the first collision distance in a direction
//! is one row lookup, one mask and one bit scan.

use crate::model::Voxel;
use crate::shape::bounds;

/// Distance of a collision that never happens.
pub(crate) const INF: u32 = u32::MAX;

/// The two axes perpendicular to each axis.
const PERP: [(usize, usize); 3] = [(1, 2), (0, 2), (0, 1)];

/// Δ_ij of one pair, inside its bounding box `lo + [0, dims)`.
struct PairDiff {
    lo: [i32; 3],
    dims: [i32; 3],
    /// For axis a with perpendicular axes (p, q): `rows[a][cp + dims[p] * cq]` has bit t set iff the
    /// point with coordinate `lo[a] + t` on a, `lo[p] + cp` on p and `lo[q] + cq` on q is in Δ.
    rows: [Vec<u64>; 3],
}

impl PairDiff {
    fn new(vi: &[Voxel], vj: &[Voxel]) -> Self {
        // Along each axis, Δ spans exactly [min V_j − max V_i, max V_j − min V_i]. Coordinates are
        // in [0, 32), so a span holds at most 63 values and a row fits in a u64.
        let (lo_i, hi_i) = bounds(vi).expect("pieces are not empty");
        let (lo_j, hi_j) = bounds(vj).expect("pieces are not empty");
        let lo = [0, 1, 2].map(|a| lo_j[a] - hi_i[a]);
        let dims = [0, 1, 2].map(|a| hi_j[a] - lo_i[a] - lo[a] + 1);

        // V_j as x-bit rows keyed by (y, z).
        let mut sorted = vj.to_vec();
        sorted.sort_unstable_by_key(|b| (b[2], b[1]));
        let mut rows_j: Vec<(i32, i32, u64)> = Vec::new();
        for b in sorted {
            debug_assert!(b.iter().all(|c| (0..32).contains(c)));
            match rows_j.last_mut() {
                Some((y, z, bits)) if (*y, *z) == (b[1], b[2]) => *bits |= 1 << b[0],
                _ => rows_j.push((b[1], b[2], 1 << b[0])),
            }
        }

        let mut rows = [
            vec![0u64; (dims[1] * dims[2]) as usize],
            vec![0u64; (dims[0] * dims[2]) as usize],
            vec![0u64; (dims[0] * dims[1]) as usize],
        ];
        // Bit t of an x row is the difference lo[0] + t: b − a − lo[0] = (b − lo_j) + (hi_i − a).
        for a in vi {
            for &(y, z, bits) in &rows_j {
                let (ry, rz) = (y - a[1] - lo[1], z - a[2] - lo[2]);
                rows[0][(ry + dims[1] * rz) as usize] |= bits >> lo_j[0] << (hi_i[0] - a[0]);
            }
        }
        for rz in 0..dims[2] {
            for ry in 0..dims[1] {
                let mut m = rows[0][(ry + dims[1] * rz) as usize];
                while m != 0 {
                    let rx = m.trailing_zeros() as i32;
                    m &= m - 1;
                    rows[1][(rx + dims[0] * rz) as usize] |= 1 << ry;
                    rows[2][(rx + dims[0] * ry) as usize] |= 1 << rz;
                }
            }
        }
        Self { lo, dims, rows }
    }

    /// For w = o_i − o_j: the smallest k ≥ 1 with w + k·e_a ∈ Δ (piece i moving +a hits j) and the
    /// smallest k ≥ 1 with w − k·e_a ∈ Δ (i moving −a hits j), INF when there is none.
    fn first_hits(&self, a: usize, w: [i32; 3]) -> (u32, u32) {
        let (p, q) = PERP[a];
        let (cp, cq) = (w[p] - self.lo[p], w[q] - self.lo[q]);
        if cp < 0 || cp >= self.dims[p] || cq < 0 || cq >= self.dims[q] {
            return (INF, INF);
        }
        let bits = self.rows[a][(cp + self.dims[p] * cq) as usize];
        let t0 = w[a] - self.lo[a];

        let start = t0 + 1;
        let up = match start {
            64.. => 0,
            ..=0 => bits,
            _ => bits & (!0u64 << start),
        };
        let up = if up == 0 { INF } else { (up.trailing_zeros() as i32 - t0) as u32 };

        let down = match t0 {
            ..=0 => 0,
            64.. => bits,
            _ => bits & ((1u64 << t0) - 1),
        };
        let down = if down == 0 { INF } else { (t0 - (63 - down.leading_zeros() as i32)) as u32 };
        (up, down)
    }
}

/// Difference sets of every pair of pieces of a puzzle.
pub(crate) struct CollisionCache {
    n: usize,
    pairs: Vec<PairDiff>,
}

impl CollisionCache {
    pub fn new(pieces: &[Vec<Voxel>]) -> Self {
        let n = pieces.len();
        let mut pairs = Vec::with_capacity(n * n.saturating_sub(1) / 2);
        for i in 0..n {
            for j in i + 1..n {
                pairs.push(PairDiff::new(&pieces[i], &pieces[j]));
            }
        }
        Self { n, pairs }
    }

    fn pair(&self, i: usize, j: usize) -> &PairDiff {
        debug_assert!(i < j && j < self.n);
        &self.pairs[i * (2 * self.n - i - 1) / 2 + (j - i - 1)]
    }

    /// First collision distances of a part made of pieces `ids` (ascending) at offsets `offs`
    /// (three per piece). Writes `dist[(dir * m + i) * m + j]` = D_dir(i, j) for local indices
    /// i ≠ j, where m = `ids.len()` and dir is the `Dir` index.
    pub fn distances(&self, ids: &[usize], offs: &[i16], dist: &mut [u32]) {
        let m = ids.len();
        for i in 0..m {
            for j in i + 1..m {
                let pair = self.pair(ids[i], ids[j]);
                let w = [0, 1, 2].map(|c| offs[3 * i + c] as i32 - offs[3 * j + c] as i32);
                for a in 0..3 {
                    let (up, down) = pair.first_hits(a, w);
                    let (pos, neg) = (2 * a * m, (2 * a + 1) * m);
                    dist[(pos + i) * m + j] = up;
                    dist[(neg + i) * m + j] = down;
                    dist[(pos + j) * m + i] = down;
                    dist[(neg + j) * m + i] = up;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::SplitMix64;
    use std::collections::HashSet;

    const DIRS: [[i32; 3]; 6] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

    fn random_piece(rng: &mut SplitMix64, side: u64, count: usize) -> Vec<Voxel> {
        let mut v: Vec<Voxel> = (0..count).map(|_| [0; 3].map(|_| rng.below(side) as i32)).collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// First k ≥ 1 at which piece i, moved by k·d from offset o_i, overlaps piece j at o_j.
    fn brute(vi: &[Voxel], vj: &[Voxel], oi: [i32; 3], oj: [i32; 3], d: [i32; 3]) -> u32 {
        let cells: HashSet<Voxel> = vj.iter().map(|b| [0, 1, 2].map(|c| b[c] + oj[c])).collect();
        (1..200)
            .find(|&k| vi.iter().any(|a| cells.contains(&[0, 1, 2].map(|c| a[c] + oi[c] + k * d[c]))))
            .map_or(INF, |k| k as u32)
    }

    #[test]
    fn distances_match_brute_force() {
        let mut rng = SplitMix64::new(7);
        for round in 0..200 {
            let side = if round % 2 == 0 { 6 } else { 32 };
            let pieces: Vec<Vec<Voxel>> = (0..3)
                .map(|_| {
                    let count = 1 + rng.below(12) as usize;
                    random_piece(&mut rng, side, count)
                })
                .collect();
            let cache = CollisionCache::new(&pieces);
            let offs: Vec<i16> = (0..9).map(|_| rng.below(41) as i16 - 20).collect();
            let mut dist = vec![0; 6 * 9];
            cache.distances(&[0, 1, 2], &offs, &mut dist);
            let at = |p: usize| [0, 1, 2].map(|c| offs[3 * p + c] as i32);
            for (dir, d) in DIRS.iter().enumerate() {
                for i in 0..3 {
                    for j in (0..3).filter(|&j| j != i) {
                        let want = brute(&pieces[i], &pieces[j], at(i), at(j), *d);
                        assert_eq!(dist[(dir * 3 + i) * 3 + j], want, "round {round} dir {dir} pair ({i},{j})");
                    }
                }
            }
        }
    }
}

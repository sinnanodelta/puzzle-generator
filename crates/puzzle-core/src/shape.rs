//! Shape checks: woodworking checks on single pieces (SPEC §1.4), after BurrTools' `isNotchable`
//! and `isMillable`, connectivity, and the holes of an assembly.

use std::collections::HashSet;

use crate::model::Voxel;

/// Bounding box of a non-empty piece, as (min, max) inclusive.
pub(crate) fn bounds(voxels: &[Voxel]) -> Option<(Voxel, Voxel)> {
    let first = *voxels.first()?;
    Some(
        voxels.iter().fold((first, first), |(lo, hi), v| {
            ([0, 1, 2].map(|a| lo[a].min(v[a])), [0, 1, 2].map(|a| hi[a].max(v[a])))
        }),
    )
}

/// The cells of a box given as (min, max) inclusive, z slowest and x fastest.
pub(crate) fn cells((lo, hi): (Voxel, Voxel)) -> impl Iterator<Item = Voxel> {
    (lo[2]..=hi[2]).flat_map(move |z| (lo[1]..=hi[1]).flat_map(move |y| (lo[0]..=hi[0]).map(move |x| [x, y, z])))
}

/// The intersection of the extrusions of the three axis projections of a piece: the smallest
/// notchable piece containing it. Sorted.
pub fn notch_closure(voxels: &[Voxel]) -> Vec<Voxel> {
    let Some(bbox) = bounds(voxels) else { return Vec::new() };
    let xy: HashSet<[i32; 2]> = voxels.iter().map(|v| [v[0], v[1]]).collect();
    let xz: HashSet<[i32; 2]> = voxels.iter().map(|v| [v[0], v[2]]).collect();
    let yz: HashSet<[i32; 2]> = voxels.iter().map(|v| [v[1], v[2]]).collect();
    let mut closure: Vec<Voxel> = cells(bbox)
        .filter(|v| xy.contains(&[v[0], v[1]]) && xz.contains(&[v[0], v[2]]) && yz.contains(&[v[1], v[2]]))
        .collect();
    closure.sort_unstable();
    closure
}

/// Whether the piece equals the intersection of the extrusions of its three axis projections, so
/// it can be cut from a stick by notches only. An empty piece is notchable.
pub fn is_notchable(voxels: &[Voxel]) -> bool {
    let distinct: HashSet<Voxel> = voxels.iter().copied().collect();
    notch_closure(voxels).len() == distinct.len()
}

/// Whether the piece can be milled: no empty cell of its bounding box has a filled neighbour along
/// X, one along Y and one along Z (such an inner corner cannot be reached by a cutter). Cells
/// outside the bounding box count as empty.
pub fn is_millable(voxels: &[Voxel]) -> bool {
    let Some(bbox) = bounds(voxels) else { return true };
    let filled: HashSet<Voxel> = voxels.iter().copied().collect();
    let neighbour_on = |v: Voxel, a: usize| {
        [-1, 1].iter().any(|&s| {
            let mut n = v;
            n[a] += s;
            filled.contains(&n)
        })
    };
    cells(bbox).filter(|v| !filled.contains(v)).all(|v| !(0..3).all(|a| neighbour_on(v, a)))
}

/// Whether the cells of a piece are face-connected. An empty piece is connected.
pub fn is_connected(voxels: &[Voxel]) -> bool {
    parts(voxels) <= 1
}

/// Number of face-connected parts of a piece.
pub fn parts(voxels: &[Voxel]) -> usize {
    let cells: HashSet<Voxel> = voxels.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut count = 0;
    for &start in &cells {
        if !seen.insert(start) {
            continue;
        }
        count += 1;
        let mut stack = vec![start];
        while let Some(v) = stack.pop() {
            for a in 0..3 {
                for s in [-1, 1] {
                    let mut n = v;
                    n[a] += s;
                    if cells.contains(&n) && seen.insert(n) {
                        stack.push(n);
                    }
                }
            }
        }
    }
    count
}

/// Number of empty cells of an assembly that are closed in: not face-connected to the outside of
/// its bounding box through empty cells.
pub fn enclosed_holes(pieces: &[Vec<Voxel>]) -> usize {
    let all: Vec<Voxel> = pieces.iter().flatten().copied().collect();
    let Some((lo, hi)) = bounds(&all) else { return 0 };
    // The bounding box with a margin of one empty cell, so the outside is connected.
    let dims = [0, 1, 2].map(|a| (hi[a] - lo[a] + 3) as usize);
    let index = |v: [usize; 3]| v[0] + dims[0] * (v[1] + dims[1] * v[2]);
    let mut filled = vec![false; dims[0] * dims[1] * dims[2]];
    for v in &all {
        filled[index([0, 1, 2].map(|a| (v[a] - lo[a] + 1) as usize))] = true;
    }
    let empty = filled.iter().filter(|&&f| !f).count();
    let mut outside = vec![false; filled.len()];
    outside[0] = true;
    let mut stack = vec![[0usize; 3]];
    let mut reached = 1;
    while let Some(v) = stack.pop() {
        for a in 0..3 {
            for up in [false, true] {
                let mut n = v;
                if up && n[a] + 1 < dims[a] {
                    n[a] += 1;
                } else if !up && n[a] > 0 {
                    n[a] -= 1;
                } else {
                    continue;
                }
                let i = index(n);
                if !filled[i] && !outside[i] {
                    outside[i] = true;
                    reached += 1;
                    stack.push(n);
                }
            }
        }
    }
    empty - reached
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connectivity() {
        assert!(is_connected(&[]));
        assert!(is_connected(&[[0, 0, 0], [0, 1, 0], [0, 1, 1]]));
        assert!(!is_connected(&[[0, 0, 0], [1, 1, 0]]));
        assert!(!is_connected(&[[0, 0, 0], [0, 0, 2], [0, 0, 1], [5, 5, 5]]));
        assert_eq!(parts(&[]), 0);
        assert_eq!(parts(&[[0, 0, 0], [0, 0, 2], [0, 0, 1], [5, 5, 5]]), 2);
        assert_eq!(parts(&[[0, 0, 0], [1, 1, 0], [2, 2, 0], [1, 0, 0], [1, 0, 0]]), 2);
    }

    #[test]
    fn holes_of_a_hollow_cube() {
        let shell: Vec<Voxel> = cells(([0, 0, 0], [2, 2, 2])).filter(|&v| v != [1, 1, 1]).collect();
        assert_eq!(enclosed_holes(std::slice::from_ref(&shell)), 1);
        // Split across two pieces, the hole is the same.
        let (a, b) = shell.split_at(10);
        assert_eq!(enclosed_holes(&[a.to_vec(), b.to_vec()]), 1);
        // A tunnel to the outside opens it.
        let open: Vec<Voxel> = shell.iter().copied().filter(|&v| v != [1, 1, 0]).collect();
        assert_eq!(enclosed_holes(&[open]), 0);
        assert_eq!(enclosed_holes(&[]), 0);
    }
}

//! Canonical key of an assembly (SPEC §3.2), for deduplicating generated puzzles.

use crate::model::Puzzle;

/// The 24 proper rotations of the cube, as (axis permutation, signs): `v'[a] = sign[a] · v[perm[a]]`.
pub(crate) fn rotations() -> impl Iterator<Item = ([usize; 3], [i32; 3])> {
    const PERMS: [([usize; 3], i32); 6] =
        [([0, 1, 2], 1), ([1, 2, 0], 1), ([2, 0, 1], 1), ([0, 2, 1], -1), ([2, 1, 0], -1), ([1, 0, 2], -1)];
    PERMS.into_iter().flat_map(|(perm, parity)| {
        (0..8)
            .map(|bits| [0, 1, 2].map(|a| if bits >> a & 1 == 1 { -1 } else { 1 }))
            .filter(move |s: &[i32; 3]| s[0] * s[1] * s[2] == parity)
            .map(move |signs| (perm, signs))
    })
}

/// A key that is the same for every rotation (no mirror), translation and relabelling of the
/// pieces of an assembly, and differs otherwise.
///
/// For each rotation, the assembly is moved to the origin and each piece is written as its voxel
/// count (u16, little endian) followed by its sorted voxels (one byte per coordinate); the pieces
/// are sorted and concatenated. The key is the smallest such byte string.
pub fn canonical_key(puzzle: &Puzzle) -> Vec<u8> {
    let mut best: Option<Vec<u8>> = None;
    for (perm, signs) in rotations() {
        let rotated: Vec<Vec<[i32; 3]>> = puzzle
            .pieces()
            .iter()
            .map(|p| p.iter().map(|v| [0, 1, 2].map(|a| signs[a] * v[perm[a]])).collect())
            .collect();
        let lo = [0, 1, 2].map(|a| rotated.iter().flatten().map(|v| v[a]).min().expect("pieces are not empty"));
        let mut encoded: Vec<Vec<u8>> = rotated
            .into_iter()
            .map(|piece| {
                let mut cells: Vec<[u8; 3]> = piece.iter().map(|v| [0, 1, 2].map(|a| (v[a] - lo[a]) as u8)).collect();
                cells.sort_unstable();
                let mut bytes = (cells.len() as u16).to_le_bytes().to_vec();
                bytes.extend(cells.into_iter().flatten());
                bytes
            })
            .collect();
        encoded.sort_unstable();
        let key = encoded.concat();
        if best.as_ref().is_none_or(|b| key < *b) {
            best = Some(key);
        }
    }
    best.expect("24 rotations")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotations_are_24_distinct_proper_rotations() {
        let all: Vec<_> = rotations().collect();
        assert_eq!(all.len(), 24);
        let images: std::collections::HashSet<[[i32; 3]; 3]> = all
            .iter()
            .map(|(perm, signs)| {
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(|e: [i32; 3]| [0, 1, 2].map(|a| signs[a] * e[perm[a]]))
            })
            .collect();
        assert_eq!(images.len(), 24);
        for m in &images {
            let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            assert_eq!(det, 1);
        }
    }
}

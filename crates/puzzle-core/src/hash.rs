//! Fast non-cryptographic hashing (the FxHash algorithm used by rustc), for hash maps keyed by states.

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

#[derive(Clone, Copy, Default)]
pub struct FxHasher {
    hash: u64,
}

impl FxHasher {
    #[inline]
    fn add(&mut self, word: u64) {
        self.hash = (self.hash.rotate_left(5) ^ word).wrapping_mul(SEED);
    }
}

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        let (chunks, rest) = bytes.as_chunks::<8>();
        for &chunk in chunks {
            self.add(u64::from_le_bytes(chunk));
        }
        if !rest.is_empty() {
            let mut word = [0u8; 8];
            word[..rest.len()].copy_from_slice(rest);
            self.add(u64::from_le_bytes(word));
        }
    }

    fn write_u8(&mut self, i: u8) {
        self.add(i as u64);
    }

    fn write_u16(&mut self, i: u16) {
        self.add(i as u64);
    }

    fn write_u32(&mut self, i: u32) {
        self.add(i as u64);
    }

    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }

    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }

    fn finish(&self) -> u64 {
        self.hash
    }
}

pub type FxBuildHasher = BuildHasherDefault<FxHasher>;
pub type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;
pub type FxHashSet<K> = HashSet<K, FxBuildHasher>;

/// Hash of a state key, four coordinates per word. The high bits are the best mixed.
#[inline]
pub fn hash_i16s(key: &[i16]) -> u64 {
    let mut h = FxHasher::default();
    for chunk in key.chunks(4) {
        let mut word = 0u64;
        for (k, &c) in chunk.iter().enumerate() {
            word |= (c as u16 as u64) << (16 * k);
        }
        h.add(word);
    }
    h.hash
}

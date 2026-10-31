// The rating of a generated puzzle (SPEC §4.4), from 0 to 100: half for how balanced the sizes of
// the pieces are, half for how easily the pieces print in 3D without supports.
import type { PuzzleDoc, Vec3 } from '../types';

export interface Rating {
  total: number;
  /** 1 − the coefficient of variation of the piece sizes, at least 0. */
  balance: number;
  /** The mean over the pieces of the share of voxels supported in the best orientation. */
  print: number;
}

/**
 * The share of a piece's voxels that lie on the bed or on another voxel of the piece, with the
 * best of the six faces down.
 */
function printability(voxels: Vec3[]): number {
  if (voxels.length === 0) return 1;
  const has = new Set(voxels.map((v) => v.join()));
  let best = 0;
  for (let a = 0; a < 3; a++) {
    for (const down of [-1, 1]) {
      const bed = down < 0 ? Math.min(...voxels.map((v) => v[a])) : Math.max(...voxels.map((v) => v[a]));
      const supported = voxels.filter((v) => {
        const w = [...v];
        w[a] += down;
        return v[a] === bed || has.has(w.join());
      }).length;
      best = Math.max(best, supported / voxels.length);
    }
  }
  return best;
}

const ratings = new Map<string, Rating>();

/** Rates a puzzle; the result is kept by `key`, the puzzle's canonical key. */
export function rate(key: string, doc: PuzzleDoc): Rating {
  let r = ratings.get(key);
  if (!r) {
    const sizes = doc.pieces.map((p) => p.fixed.length);
    const mean = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length);
    const sd = Math.sqrt(sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sizes.length));
    const balance = mean > 0 ? Math.max(0, 1 - sd / mean) : 0;
    const print = doc.pieces.reduce((a, p) => a + printability(p.fixed), 0) / Math.max(1, doc.pieces.length);
    r = { balance, print, total: Math.round(50 * balance + 50 * print) };
    ratings.set(key, r);
  }
  return r;
}

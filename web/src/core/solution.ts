// A disassembly tree (SPEC §3.2) as a list of animation steps and the piece offsets after each one
// (SPEC §6). The tree is walked depth first: a node's moves, then the part keeping its first piece,
// then the removed group. A separation slides the removed group just clear of the rest, then sets it
// aside in a row of parking slots beside the grid.
import type { Dir, PuzzleDoc, SolveNode, Solution, Vec3 } from '../types';
import { maskNames } from './doc';

export interface Step {
  kind: 'move' | 'separate' | 'aside';
  /** The pieces that move. */
  mask: number;
  /** Move number, counted over the whole tree (asides have none). */
  number: number | null;
  label: string;
  /** Index into `Replay.groups`. */
  group: number;
  /** A move of the root node: the moves up to the first separation. */
  root: boolean;
}

export interface StepGroup {
  title: string;
  root: boolean;
}

export interface Replay {
  steps: Step[];
  /** `frames[k][piece]`: offsets after `k` steps (`frames.length = steps.length + 1`). */
  frames: Vec3[][];
  groups: StepGroup[];
  /** Box holding every piece in every frame, for framing the camera. */
  lo: Vec3;
  hi: Vec3;
}

const DIRS: Record<Dir, { axis: 0 | 1 | 2; sign: 1 | -1; label: string }> = {
  '+x': { axis: 0, sign: 1, label: '+X' },
  '-x': { axis: 0, sign: -1, label: '−X' },
  '+y': { axis: 1, sign: 1, label: '+Y' },
  '-y': { axis: 1, sign: -1, label: '−Y' },
  '+z': { axis: 2, sign: 1, label: '+Z' },
  '-z': { axis: 2, sign: -1, label: '−Z' },
};

/** Empty cells left between a separated group and the rest, and between parking slots. */
const GAP = 1;

export function buildReplay(doc: PuzzleDoc, solution: Solution): Replay {
  const names = doc.pieces.map((p) => p.name);
  const voxels = doc.pieces.map((p) => p.fixed);
  const offsets: Vec3[] = doc.pieces.map(() => [0, 0, 0]);
  const frames: Vec3[][] = [offsets.map((o) => [...o] as Vec3)];
  const steps: Step[] = [];
  const groups: StepGroup[] = [];
  let number = 0;
  let slotX = 0;

  const members = (mask: number) => names.map((_, i) => i).filter((i) => (mask >>> i) & 1);
  const extent = (mask: number) => {
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const i of members(mask)) {
      for (const v of voxels[i]) {
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], v[a] + offsets[i][a]);
          hi[a] = Math.max(hi[a], v[a] + offsets[i][a]);
        }
      }
    }
    return { lo, hi };
  };
  const shift = (mask: number, delta: Vec3) => {
    for (const i of members(mask)) for (let a = 0; a < 3; a++) offsets[i][a] += delta[a];
  };
  const push = (step: Step) => {
    steps.push(step);
    frames.push(offsets.map((o) => [...o] as Vec3));
  };
  const who = (mask: number) => maskNames(names, mask).join('+');

  const visit = (node: SolveNode, root: boolean) => {
    const group = groups.length;
    groups.push({ title: `${maskNames(names, node.pieces).join(' ')} — ${who(node.removed)} comes out`, root });
    for (const move of node.moves) {
      const { axis, sign, label } = DIRS[move.dir];
      number++;
      if (move.dist !== null) {
        const delta: Vec3 = [0, 0, 0];
        delta[axis] = sign * move.dist;
        shift(move.pieces, delta);
        push({ kind: 'move', mask: move.pieces, number, label: `#${number}  ${who(move.pieces)} → ${label} ${move.dist}`, group, root });
        continue;
      }
      // Slide out until clear of the rest of the part, with a gap.
      const moving = extent(move.pieces);
      const rest = extent(node.pieces & ~move.pieces);
      const dist = Math.max(
        1,
        sign > 0 ? rest.hi[axis] - moving.lo[axis] + 1 + GAP : moving.hi[axis] - rest.lo[axis] + 1 + GAP,
      );
      const delta: Vec3 = [0, 0, 0];
      delta[axis] = sign * dist;
      shift(move.pieces, delta);
      push({ kind: 'separate', mask: move.pieces, number, label: `#${number}  ${who(move.pieces)} → ${label} out`, group, root });
      // Park the group in the next slot of a row along +X, below the grid along Y.
      const { lo, hi } = extent(move.pieces);
      shift(move.pieces, [slotX - lo[0], -(GAP + 2) - hi[1], -lo[2]]);
      slotX += hi[0] - lo[0] + 1 + GAP + 1;
      push({ kind: 'aside', mask: move.pieces, number: null, label: `${who(move.pieces)} set aside`, group, root });
    }
    if (node.remaining) visit(node.remaining, false);
    if (node.removed_tree) visit(node.removed_tree, false);
  };
  visit(solution.tree, true);

  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const frame of frames) {
    voxels.forEach((cells, i) => {
      for (const v of cells) {
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], v[a] + frame[i][a]);
          hi[a] = Math.max(hi[a], v[a] + frame[i][a] + 1);
        }
      }
    });
  }
  return { steps, frames, groups, lo, hi };
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/** Offsets of every piece at `step + t` (0 ≤ t ≤ 1), eased between frames. */
export function offsetsAt(replay: Replay, step: number, t: number): Vec3[] {
  const a = replay.frames[Math.min(step, replay.frames.length - 1)];
  const b = replay.frames[Math.min(step + 1, replay.frames.length - 1)];
  const e = ease(Math.min(1, Math.max(0, t)));
  return a.map((o, i) => [0, 1, 2].map((k) => o[k] + (b[i][k] - o[k]) * e) as Vec3);
}

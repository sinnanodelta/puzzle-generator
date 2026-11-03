// The uniqueness badge of a puzzle (SPEC §4.4, §5): `unique`, or `N solutions / M assemblies`. A
// puzzle that does not fit its target is counted in its own shape, and the badge says so.
import type { Uniqueness } from '../core/library';
import type { UniquenessCheck } from '../store';

function count(n: number, one: string, many: string, atLeast: boolean): string {
  return `${atLeast ? '≥ ' : ''}${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** The puzzle leaves required target cells empty or has voxels outside the target. */
export function ownShape(u: Uniqueness): boolean {
  return (u.holes ?? 0) > 0 || (u.outside ?? 0) > 0;
}

export function uniquenessText(u: Uniqueness): string {
  const shape = ownShape(u) ? ' (own shape)' : '';
  if (u.unique) return `unique${shape}`;
  const atLeast = u.status === 'aborted';
  return `${count(u.solutions, 'solution', 'solutions', atLeast)} / ${count(u.assemblies, 'assembly', 'assemblies', atLeast)}${shape}`;
}

function details(u: Uniqueness): string {
  const lines: string[] = [];
  if (ownShape(u)) {
    const misses = [
      (u.holes ?? 0) > 0 && `leaves ${count(u.holes!, 'required cell', 'required cells', false)} of the target empty`,
      (u.outside ?? 0) > 0 && `has ${count(u.outside!, 'voxel', 'voxels', false)} outside the target`,
    ].filter(Boolean);
    lines.push(
      `The puzzle ${misses.join(' and ')}, so no assembly fills the target. Counted in the puzzle's own shape instead: the target without its holes, plus its voxels outside it.`,
    );
  }
  const into = ownShape(u) ? 'shape' : 'target';
  lines.push(
    `${count(u.assemblies, 'distinct assembly', 'distinct assemblies', false)} into the ${into} (counted once per symmetry of the ${into}, of order ${u.symmetryOrder}); ${u.solutions.toLocaleString()} ${u.solutions === 1 ? 'comes' : 'come'} apart.`,
  );
  if (u.undecided > 0) lines.push(`${u.undecided.toLocaleString()} undecided: the solver reached its state cap.`);
  if (u.status === 'aborted') lines.push('The count stopped at the assembly cap: these are lower bounds.');
  return lines.join('\n');
}

/** `check` undefined is a check still waiting. */
export function UniquenessBadge({ check }: { check: UniquenessCheck | undefined }) {
  if (!check) {
    return (
      <span className="uniq dim" title="Waiting for the uniqueness check">
        …
      </span>
    );
  }
  switch (check.kind) {
    case 'checking':
      return (
        <span className="uniq dim" title="Counting the assemblies">
          checking…
        </span>
      );
    case 'failed':
      return (
        <span className="uniq bad" title={check.error}>
          failed
        </span>
      );
    case 'done':
      return (
        <span
          className={`uniq ${check.result.unique ? 'ok' : 'warn'}${ownShape(check.result) ? ' shape' : ''}`}
          title={details(check.result)}
        >
          {uniquenessText(check.result)}
        </span>
      );
  }
}

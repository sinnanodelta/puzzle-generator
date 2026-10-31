// The uniqueness badge of a puzzle (SPEC §4.4, §5): `unique`, or `N solutions / M assemblies`.
import type { Uniqueness } from '../core/library';
import type { UniquenessCheck } from '../store';

function count(n: number, one: string, many: string, atLeast: boolean): string {
  return `${atLeast ? '≥ ' : ''}${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function uniquenessText(u: Uniqueness): string {
  if (u.unique) return 'unique';
  const atLeast = u.status === 'aborted';
  return `${count(u.solutions, 'solution', 'solutions', atLeast)} / ${count(u.assemblies, 'assembly', 'assemblies', atLeast)}`;
}

function details(u: Uniqueness): string {
  const lines = [
    `${count(u.assemblies, 'distinct assembly', 'distinct assemblies', false)} into the target (counted once per symmetry of the target, of order ${u.symmetryOrder}); ${u.solutions.toLocaleString()} ${u.solutions === 1 ? 'comes' : 'come'} apart.`,
  ];
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
        <span className={`uniq ${check.result.unique ? 'ok' : 'warn'}`} title={details(check.result)}>
          {uniquenessText(check.result)}
        </span>
      );
  }
}

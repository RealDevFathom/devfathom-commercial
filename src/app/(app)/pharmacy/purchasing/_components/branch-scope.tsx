import { SectionCard } from '@/components/ui/section-card';
import { pharmacyBranchLabel } from '@/lib/pharmacy/branch-label';
import type { BranchOption } from '../_lib/types';
import { EmptyState } from './console-chrome';

/**
 * Goods-in and returns are branch-owned: a receipt posts into one branch's
 * ledger, so the branch is part of the operation and not a display filter.
 *
 * How the branch is chosen matters. UX rule 1 forbids typing an id, so it is
 * always a picker of this organization's active branches. UX rule 5 forbids
 * silently adopting the first record as though the operator had chosen it — but
 * a single-branch pharmacy has nothing to choose, and asking it to would be UX
 * rule 12's dead end. So: one branch is adopted and *said*; several branches
 * are a prompt, which is a distinct state from "no results".
 */

export type BranchResolution =
  | { kind: 'none' }
  | { kind: 'unchosen'; branches: BranchOption[] }
  | { kind: 'resolved'; branch: BranchOption; branches: BranchOption[]; implicit: boolean };

export function resolveBranch(
  branches: BranchOption[],
  requested: string | undefined
): BranchResolution {
  if (branches.length === 0) return { kind: 'none' };
  const chosen = requested ? branches.find((branch) => branch.id === requested) : undefined;
  if (chosen) return { kind: 'resolved', branch: chosen, branches, implicit: false };
  // A requested branch that is not in this organization's list falls through to
  // the prompt rather than to another branch's stock.
  if (branches.length === 1) {
    return { kind: 'resolved', branch: branches[0]!, branches, implicit: true };
  }
  return { kind: 'unchosen', branches };
}

/**
 * A GET form, so the branch lives in the URL: the surface stays linkable, the
 * back button works, and UX rule 6's "selection survives filtering" is a
 * property of the address rather than of a component's memory.
 */
export function BranchPicker({
  branches,
  selected,
  route,
  keep = {},
}: {
  branches: BranchOption[];
  selected: string | undefined;
  route: string;
  keep?: Record<string, string | undefined>;
}) {
  if (branches.length <= 1) return null;
  return (
    <form action={route} className="flex flex-wrap items-end gap-3" method="get">
      {Object.entries(keep).map(([key, value]) =>
        value ? <input key={key} name={key} type="hidden" value={value} /> : null
      )}
      <label className="min-w-0 text-sm font-medium text-text-body" htmlFor="branch-scope">
        Branch
        <select
          className="mt-1 min-h-11 w-full min-w-56 rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
          defaultValue={selected ?? ''}
          id="branch-scope"
          name="branch"
        >
          <option disabled value="">
            Choose a branch…
          </option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {pharmacyBranchLabel(branch)}
            </option>
          ))}
        </select>
      </label>
      <button
        className="min-h-11 rounded-[var(--radius-sm)] border border-border-default px-4 text-sm font-medium text-text-strong hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
        type="submit"
      >
        Switch branch
      </button>
    </form>
  );
}

/** UX rule 13: the prerequisite is a checklist with a link, not a sentence. */
export function NoBranchState({ surface }: { surface: string }) {
  return (
    <SectionCard title={`${surface} needs an active branch`} titleLevel={2}>
      <EmptyState
        title="No active pharmacy branch"
        detail={`Stock is held by a branch, so ${surface.toLowerCase()} cannot open until this workspace has one. Creating a branch also creates the stock locations goods-in posts into.`}
        steps={[
          { label: 'Open pharmacy onboarding to add a branch', href: '/pharmacy' },
          { label: 'Review workspace settings', href: '/organization' },
        ]}
      />
    </SectionCard>
  );
}

export function ChooseBranchState({
  branches,
  route,
  surface,
}: {
  branches: BranchOption[];
  route: string;
  surface: string;
}) {
  return (
    <SectionCard title="Choose a branch" titleLevel={2}>
      <p className="text-sm text-text-muted">
        {surface} posts into one branch&rsquo;s ledger, and this workspace has {branches.length}.
        Pick the branch you are standing in — nothing is loaded or changed until you do.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {branches.map((branch) => (
          <li key={branch.id}>
            <a
              className="flex min-h-11 flex-col justify-center rounded-[var(--radius-sm)] border border-border-default px-4 py-2 hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
              href={`${route}?branch=${encodeURIComponent(branch.id)}`}
            >
              <span className="font-medium text-text-strong">{branch.name}</span>
              <span className="text-xs text-text-muted">
                {branch.code} · {branch.city}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

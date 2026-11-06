'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

const selectClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

/** Builds the URL a GET filter form would navigate to. */
export function filterHref(action: string, data: FormData): string {
  const query = new URLSearchParams();
  for (const [key, value] of data.entries())
    if (typeof value === 'string') query.append(key, value);
  const search = query.toString();
  return search ? `${action}?${search}` : action;
}

/**
 * A GET filter form that replaces the current history entry instead of adding
 * one, so changing a filter never makes Back take more than one click. With
 * `autoSubmit`, choosing a new option applies it at once; the visible submit
 * button stays for keyboard users and for browsers without JavaScript, where
 * the form falls back to an ordinary GET navigation.
 */
export function FilterForm({
  action,
  autoSubmit = false,
  className,
  children,
  label,
}: {
  action: string;
  autoSubmit?: boolean;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  const router = useRouter();
  return (
    <form
      action={action}
      aria-label={label}
      className={className}
      method="get"
      onChange={(event) => {
        if (autoSubmit && event.target instanceof HTMLSelectElement)
          event.currentTarget.requestSubmit();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        router.replace(filterHref(action, new FormData(event.currentTarget)));
      }}
    >
      {children}
    </form>
  );
}

/**
 * The working-branch control. With a single branch there is nothing to choose,
 * so it shows the branch name and carries its id in a hidden field.
 */
export function BranchField({
  branches,
  value,
  name = 'branch',
  className = 'min-w-64 flex-1 text-sm text-text-body',
}: {
  branches: ReadonlyArray<{ id: string; name: string; city?: string | null }>;
  value: string;
  name?: string;
  className?: string;
}) {
  const label = (branch: { name: string; city?: string | null }) =>
    branch.city ? `${branch.name} · ${branch.city}` : branch.name;
  if (branches.length === 1)
    return (
      <div className={className}>
        <span>Branch</span>
        <p className="mt-1 flex min-h-11 items-center font-medium text-text-strong">
          {label(branches[0]!)}
        </p>
        <input name={name} type="hidden" value={branches[0]!.id} />
      </div>
    );
  return (
    <label className={className}>
      Branch
      <select className={selectClass} defaultValue={value} name={name}>
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {label(branch)}
          </option>
        ))}
      </select>
    </label>
  );
}

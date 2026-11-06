import type { ComponentProps, ReactNode } from 'react';

export const fieldClass =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-text-strong">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-xs font-normal text-text-muted">{hint}</span> : null}
    </label>
  );
}

export function WorkspaceState({
  title,
  children,
  tone = 'neutral',
  ...props
}: ComponentProps<'div'> & { title: string; tone?: 'neutral' | 'danger' }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className="rounded-lg border border-border-subtle bg-card p-6"
      {...props}
    >
      <h2 className="font-display text-lg font-semibold text-text-strong">{title}</h2>
      <div className="mt-2 text-sm leading-relaxed text-text-muted">{children}</div>
    </div>
  );
}

/** A refusal, as opposed to a failed load: the surface is closed to this role (#979). */
export function isAccessDenied(
  error: { data?: { code?: string } | null } | null | undefined
): boolean {
  return error?.data?.code === 'FORBIDDEN';
}

/**
 * "Not permitted" is its own state with its own next step — never a connection
 * problem to retry, and never an empty branch list (#979).
 */
export function AccessDeniedState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <WorkspaceState title={title}>
      <p>{children}</p>
      <p className="mt-2">
        Ask a workspace administrator to add it to your role. Nothing here failed to load — the
        surface itself is closed to your role.
      </p>
    </WorkspaceState>
  );
}

import type { ComponentProps, ReactNode } from 'react';

export const fieldClass =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50';

export function Field({
  label,
  hint,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  /** Shows a visible required marker; the control itself still carries `required`. */
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-text-strong">
      <span>
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-destructive">
            *
          </span>
        ) : null}
      </span>
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

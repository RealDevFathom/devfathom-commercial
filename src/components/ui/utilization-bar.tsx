import * as React from 'react';

import { cn } from '@/lib/utils';

interface UtilizationBarProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  /** Optional mono uppercase label (e.g. "UTILISATION"). */
  label?: string;
  /** 0–100. Clamped. */
  value: number;
  /** Hide the right-aligned mono percentage. */
  hidePercent?: boolean;
}

/**
 * UtilizationBar — label + right-aligned mono %, with an abyss fill on a sunken
 * track. See proto-08 (People).
 */
function UtilizationBar({
  label,
  value,
  hidePercent = false,
  className,
  ...props
}: UtilizationBarProps) {
  const labelId = React.useId();
  const pct = Number.isNaN(value) ? 0 : Math.max(0, Math.min(100, value));
  const hasLabel = Boolean(label?.trim());
  const showHeader = hasLabel || !hidePercent;
  return (
    <div data-slot="utilization-bar" className={cn('space-y-1.5', className)} {...props}>
      {showHeader ? (
        <div className="flex items-center justify-between gap-2">
          {hasLabel ? (
            <span id={labelId} className="eyebrow">
              {label}
            </span>
          ) : (
            <span />
          )}
          {!hidePercent ? (
            <span className="font-mono text-xs tabular-nums text-text-body">
              {Math.round(pct)}%
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-labelledby={hasLabel ? labelId : undefined}
        aria-label={hasLabel ? undefined : 'Utilization'}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export { UtilizationBar };
export type { UtilizationBarProps };

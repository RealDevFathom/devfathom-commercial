import * as React from 'react';

import { cn } from '@/lib/utils';

type DeltaDirection = 'up' | 'down' | 'flat';

interface StatProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  /** Mono uppercase label, e.g. "RECOGNISED · JUNE". */
  label: React.ReactNode;
  /** The figure — rendered in Oxanium tabular-nums (`.stat-figure`). */
  value: React.ReactNode;
  /** Optional delta string, e.g. "+9%" or "−$18k". */
  delta?: React.ReactNode;
  /** up = success/green, down = destructive/red, flat = muted (default). */
  deltaDirection?: DeltaDirection;
  /** Optional secondary line under the delta, e.g. "vs May". */
  sub?: React.ReactNode;
  /** Override the figure's classes (e.g. a larger `text-[2.5rem]`). */
  valueClassName?: string;
}

const DELTA_GLYPH: Record<DeltaDirection, string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

const DELTA_COLOR: Record<DeltaDirection, string> = {
  up: 'text-success',
  down: 'text-destructive',
  flat: 'text-text-muted',
};

/**
 * Stat — a ledger figure: mono uppercase label, large Oxanium tabular value,
 * optional colored delta with a direction triangle. See proto-01 / proto-07.
 */
function Stat({
  label,
  value,
  delta,
  deltaDirection = 'flat',
  sub,
  className,
  valueClassName,
  ...props
}: StatProps) {
  return (
    <div data-slot="stat" className={cn('space-y-2', className)} {...props}>
      <div className="eyebrow">{label}</div>
      <div className={cn('stat-figure text-[2rem]', valueClassName)}>{value}</div>
      {delta != null ? (
        <div
          className={cn(
            'flex items-center gap-1 font-mono text-xs tabular-nums',
            DELTA_COLOR[deltaDirection]
          )}
        >
          <span aria-hidden className="text-[0.5rem] leading-none">
            {DELTA_GLYPH[deltaDirection]}
          </span>
          <span>{delta}</span>
        </div>
      ) : null}
      {sub != null ? <div className="text-xs text-text-muted">{sub}</div> : null}
    </div>
  );
}

export { Stat };
export type { StatProps, DeltaDirection };

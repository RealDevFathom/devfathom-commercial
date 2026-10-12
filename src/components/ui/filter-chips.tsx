import * as React from 'react';

import { cn } from '@/lib/utils';

interface FilterChipItem {
  label: React.ReactNode;
  value: string;
  count?: number;
}

interface FilterChipsProps extends Omit<React.ComponentProps<'div'>, 'onChange'> {
  items: FilterChipItem[];
  /** Currently-active chip value. */
  value: string;
  /** Called with the chosen chip's value. */
  onChange: (value: string) => void;
}

/**
 * FilterChips — segmented filter row (proto-02 / proto-08).
 * Active chip = abyss fill + paper text; inactive = hairline-bordered with a
 * muted mono count.
 */
function FilterChips({ items, value, onChange, className, ...props }: FilterChipsProps) {
  return (
    <div
      data-slot="filter-chips"
      className={cn('flex flex-wrap items-center gap-2', className)}
      {...props}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            data-active={active || undefined}
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-primary text-primary-foreground'
                : 'border border-border text-text-body hover:bg-muted'
            )}
          >
            <span>{item.label}</span>
            {item.count != null ? (
              <span
                className={cn(
                  'font-mono text-xs tabular-nums',
                  active ? 'text-primary-foreground/70' : 'text-text-muted'
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export { FilterChips };
export type { FilterChipsProps, FilterChipItem };

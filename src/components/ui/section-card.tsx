import * as React from 'react';

import { cn } from '@/lib/utils';
import { Eyebrow } from '@/components/ui/eyebrow';

interface SectionCardProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** Optional mono uppercase eyebrow above the title. Brass when `eyebrowAccent`. */
  eyebrow?: React.ReactNode;
  eyebrowAccent?: boolean;
  /** Optional Oxanium section title. */
  title?: React.ReactNode;
  /** Optional right-aligned actions slot in the header row. */
  actions?: React.ReactNode;
}

/**
 * SectionCard — a `bg-card` panel (hairline border, lg radius, generous padding)
 * with an optional mono eyebrow / Oxanium title / actions header row.
 */
function SectionCard({
  eyebrow,
  eyebrowAccent = false,
  title,
  actions,
  className,
  children,
  ...props
}: SectionCardProps) {
  const hasHeader = eyebrow != null || title != null || actions != null;
  return (
    <div
      data-slot="section-card"
      className={cn(
        'min-w-0 rounded-lg border border-border-subtle bg-card p-5 text-card-foreground shadow-none',
        className
      )}
      {...props}
    >
      {hasHeader ? (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {eyebrow != null ? <Eyebrow accent={eyebrowAccent}>{eyebrow}</Eyebrow> : null}
            {title != null ? (
              <h3 className="font-display text-lg leading-snug font-semibold tracking-tight text-text-strong">
                {title}
              </h3>
            ) : null}
          </div>
          {actions != null ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export { SectionCard };
export type { SectionCardProps };

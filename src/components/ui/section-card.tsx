import * as React from 'react';

import { cn } from '@/lib/utils';
import { Eyebrow } from '@/components/ui/eyebrow';

interface SectionCardProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** Optional mono uppercase eyebrow above the title. Brass when `eyebrowAccent`. */
  eyebrow?: React.ReactNode;
  eyebrowAccent?: boolean;
  /** Optional Oxanium section title. */
  title?: React.ReactNode;
  /**
   * Semantic heading level for the title. Defaults to 2: a SectionCard sits
   * directly under the page `<h1>` (PageHeader), so h2 keeps the outline
   * contiguous and avoids an axe `heading-order` skip. Pass 3 for a card
   * genuinely nested below an existing h2.
   */
  titleLevel?: 2 | 3;
  /** Optional right-aligned actions slot in the header row. */
  actions?: React.ReactNode;
  /** Tighter padding and a quieter title for dense operational surfaces. */
  compact?: boolean;
}

/**
 * SectionCard — a `bg-card` panel (hairline border, lg radius, generous padding)
 * with an optional mono eyebrow / Oxanium title / actions header row.
 */
function SectionCard({
  eyebrow,
  eyebrowAccent = false,
  title,
  titleLevel = 2,
  actions,
  compact = false,
  className,
  children,
  ...props
}: SectionCardProps) {
  const hasHeader = eyebrow != null || title != null || actions != null;
  const Title = titleLevel === 2 ? 'h2' : 'h3';
  return (
    <div
      data-slot="section-card"
      className={cn(
        'min-w-0 border border-border-subtle bg-card text-card-foreground shadow-none',
        compact ? 'rounded-md p-2' : 'rounded-lg p-5',
        className
      )}
      {...props}
    >
      {hasHeader ? (
        <div
          className={cn('flex items-start justify-between', compact ? 'mb-2 gap-2' : 'mb-4 gap-4')}
        >
          <div className="min-w-0 space-y-1">
            {eyebrow != null ? <Eyebrow accent={eyebrowAccent}>{eyebrow}</Eyebrow> : null}
            {title != null ? (
              <Title
                className={cn(
                  'font-display font-semibold tracking-tight text-text-strong',
                  compact ? 'text-sm leading-5' : 'text-lg leading-snug'
                )}
              >
                {title}
              </Title>
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

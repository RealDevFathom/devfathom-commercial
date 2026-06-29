import * as React from 'react';

import { cn } from '@/lib/utils';
import { Eyebrow } from '@/components/ui/eyebrow';

interface PageHeaderProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** Mono uppercase eyebrow (e.g. "WORKSPACE" / "FIRM"). Brass by default. */
  eyebrow?: React.ReactNode;
  /** Render the eyebrow in muted slate instead of brass. */
  eyebrowMuted?: boolean;
  /** Oxanium display heading — the page title. */
  heading: React.ReactNode;
  /** One-line muted description under the heading. */
  description?: React.ReactNode;
  /** Optional right-aligned actions slot (buttons, filters…). */
  actions?: React.ReactNode;
}

/**
 * PageHeader — the standard top-of-module header.
 * Mono eyebrow → large Oxanium heading → muted description, with an optional
 * right-aligned actions slot. Used at the top of every module page.
 */
function PageHeader({
  eyebrow,
  eyebrowMuted = false,
  heading,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn('mb-8 flex items-start justify-between gap-6', className)}
      {...props}
    >
      <div className="min-w-0 space-y-2">
        {eyebrow != null ? <Eyebrow accent={!eyebrowMuted}>{eyebrow}</Eyebrow> : null}
        <h1 className="font-display text-[2.25rem] leading-[1.1] font-semibold tracking-tight text-text-strong">
          {heading}
        </h1>
        {description != null ? (
          <p className="max-w-2xl text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions != null ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export { PageHeader };
export type { PageHeaderProps };

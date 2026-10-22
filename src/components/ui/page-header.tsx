import * as React from 'react';

import { cn } from '@/lib/utils';
import { Eyebrow } from '@/components/ui/eyebrow';

interface PageHeaderProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** Mono uppercase eyebrow (e.g. "WORKSPACE" / "FIRM"). Accent by default. */
  eyebrow?: React.ReactNode;
  /** Render the eyebrow in muted slate instead of accent. */
  eyebrowMuted?: boolean;
  /** Oxanium display heading — the page title. */
  heading: React.ReactNode;
  /** Optional visual shown beside the title block (for example, an entity avatar). */
  media?: React.ReactNode;
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
  media,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        'fieldbook-page-header mb-10 flex flex-col gap-5 border-b border-border-default pb-7 2xl:flex-row 2xl:items-start 2xl:justify-between',
        className
      )}
      {...props}
    >
      <div className="flex w-full min-w-0 items-stretch gap-4 sm:gap-5 2xl:flex-1">
        <span aria-hidden className="fieldbook-page-marker mt-1 shrink-0" />
        {media != null ? <div className="shrink-0 self-start">{media}</div> : null}
        <div className="min-w-0 space-y-2">
          {eyebrow != null ? <Eyebrow accent={!eyebrowMuted}>{eyebrow}</Eyebrow> : null}
          <h1 className="font-display text-[clamp(2.1rem,4vw,3.15rem)] leading-[0.98] font-semibold tracking-[-0.045em] text-text-strong">
            {heading}
          </h1>
          {description != null ? (
            <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-text-muted">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions != null ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 2xl:w-auto 2xl:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export { PageHeader };
export type { PageHeaderProps };

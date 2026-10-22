import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Eyebrow — small mono uppercase label (IBM Plex Mono, 0.14em caps tracking).
 * "Mono carries the data." Muted by default; `accent` switches it to accent.
 */
function Eyebrow({
  className,
  accent = false,
  ...props
}: React.ComponentProps<'span'> & { accent?: boolean }) {
  return (
    <span
      data-slot="eyebrow"
      className={cn('eyebrow', accent && 'eyebrow-accent', className)}
      {...props}
    />
  );
}

export { Eyebrow };

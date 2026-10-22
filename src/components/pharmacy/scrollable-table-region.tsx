import * as React from 'react';

import { cn } from '@/lib/utils';

type ScrollableTableRegionProps = React.ComponentPropsWithoutRef<'div'> & {
  label: string;
};

/** A keyboard-reachable, named viewport for pharmacy tables that may overflow horizontally. */
export const ScrollableTableRegion = React.forwardRef<HTMLDivElement, ScrollableTableRegionProps>(
  function ScrollableTableRegion({ label, className, ...props }, ref) {
    return (
      <div
        ref={ref}
        role="region"
        aria-label={label}
        tabIndex={0}
        className={cn(
          'overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          className
        )}
        {...props}
      />
    );
  }
);

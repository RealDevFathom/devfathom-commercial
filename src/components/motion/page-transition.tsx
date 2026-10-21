'use client';

import { m, useReducedMotion } from 'motion/react';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { easeOutExpo } from '@/lib/motion';

const subscribeToHydration = () => () => {};

/**
 * PageTransition — re-animates the main content on every route change.
 * Keyed on pathname so each page enters with a calm fade + lift.
 */
export function PageTransition({
  children,
  className,
  travel = true,
}: {
  children: React.ReactNode;
  className?: string;
  /** When false, the route does not fade or travel. POS surfaces opt out. */
  travel?: boolean;
}) {
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
  const still = !travel || reduceMotion;

  return (
    <m.div
      data-slot="page-transition"
      key={pathname}
      className={className}
      initial={mounted && !still ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: still ? 0 : 0.42, ease: easeOutExpo }}
    >
      {children}
    </m.div>
  );
}

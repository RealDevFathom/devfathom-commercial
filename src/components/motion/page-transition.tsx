'use client';

import { m, useReducedMotion } from 'motion/react';
import { usePathname } from 'next/navigation';
import { easeOutExpo } from '@/lib/motion';

/**
 * PageTransition — re-animates the main content on every route change.
 * Keyed on pathname so each page enters with a calm fade + lift.
 */
export function PageTransition({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const reduce = useReducedMotion();

  if (reduce) return <div className={className}>{children}</div>;

  return (
    <m.div
      key={pathname}
      className={className}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: easeOutExpo }}
    >
      {children}
    </m.div>
  );
}

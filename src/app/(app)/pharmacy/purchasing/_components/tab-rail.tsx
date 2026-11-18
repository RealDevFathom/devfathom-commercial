'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * DEV-44: every purchasing surface renders its own tab rail, so switching tabs
 * mounts a new rail scrolled back to its start and, on a narrow screen, the tab
 * just chosen sits off the edge. The rail opens with the current tab in view.
 * Only the rail's own horizontal offset moves; the page keeps its scroll.
 */
export function TabRail({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const rail = ref.current;
    const current = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !current) return;
    // Rectangles rather than offsets, so the same arithmetic holds right-to-left.
    const railBox = rail.getBoundingClientRect();
    const tabBox = current.getBoundingClientRect();
    if (tabBox.left < railBox.left) rail.scrollLeft += tabBox.left - railBox.left;
    else if (tabBox.right > railBox.right) rail.scrollLeft += tabBox.right - railBox.right;
  }, []);
  return (
    <nav ref={ref} aria-label={label} className="-mx-1 overflow-x-auto">
      {children}
    </nav>
  );
}

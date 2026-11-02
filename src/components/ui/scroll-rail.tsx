'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

type Edges = { start: boolean; end: boolean };

/**
 * ScrollRail — a horizontally scrolling row (tabs, chips) that shows it has more.
 *
 * A clipped tab with no cue reads as the end of the row. When content overflows,
 * a round arrow control sits on the edge that hides more items; clicking it pages
 * the row. The current item (`aria-current="page"`) is brought into view on mount,
 * so a deep tab is never selected off-screen. Keyboard users reach every item by Tab
 * as before; the arrows are a pointer and touch aid.
 */
export function ScrollRail({
  label,
  children,
  className,
  viewportClassName,
}: {
  /** Names the row in the arrow controls, e.g. "purchasing tabs". */
  label: string;
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });

  const measure = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    // scrollLeft is negative in right-to-left layouts; distance from the start is what matters.
    const offset = Math.abs(element.scrollLeft);
    const next = { start: max > 1 && offset > 1, end: max > 1 && offset < max - 1 };
    setEdges((previous) =>
      previous.start === next.start && previous.end === next.end ? previous : next
    );
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const current = element.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) {
      const box = element.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (item.left < box.left || item.right > box.right) {
        element.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
      }
    }
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure]);

  const page = (direction: 1 | -1) => {
    const element = viewport.current;
    if (!element) return;
    const rtl = getComputedStyle(element).direction === 'rtl';
    const left = direction * (rtl ? -1 : 1) * Math.max(element.clientWidth * 0.8, 120);
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof element.scrollBy === 'function') {
      element.scrollBy({ left, behavior: reduce ? 'auto' : 'smooth' });
    } else {
      element.scrollLeft += left;
    }
    measure();
  };

  const arrow =
    'absolute top-1/2 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border-default bg-card text-text-strong shadow-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div
      data-slot="scroll-rail"
      data-overflow-start={edges.start || undefined}
      data-overflow-end={edges.end || undefined}
      className={cn('relative min-w-0', className)}
    >
      <div
        ref={viewport}
        data-slot="scroll-rail-viewport"
        className={cn('overflow-x-auto overscroll-x-contain', viewportClassName)}
      >
        {children}
      </div>
      {edges.start ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Scroll ${label} back`}
          className={cn(arrow, 'start-0')}
          onClick={() => page(-1)}
        >
          <ChevronLeft aria-hidden className="size-4 rtl:rotate-180" />
        </button>
      ) : null}
      {edges.end ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Scroll ${label} forward`}
          className={cn(arrow, 'end-0')}
          onClick={() => page(1)}
        >
          <ChevronRight aria-hidden className="size-4 rtl:rotate-180" />
        </button>
      ) : null}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * DEV-977 phase 3: whether an element's content is wider than the element, so it scrolls
 * sideways. Re-measured when the element or its content changes size, and when its content
 * changes. A strip that scrolls needs to take the keyboard focus (WCAG 2.1.1, so arrow keys can
 * scroll it); one that fits must not, or it is a tab stop that does nothing.
 *
 * Returns a callback ref for the element, and the answer.
 */
export function useHorizontalOverflow<T extends HTMLElement>() {
  const [overflowing, setOverflowing] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  const ref = useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    // One pixel of slack: sub-pixel layout can report a width a fraction over.
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            measure();
          });
    resize?.observe(element);
    const observeChildren = () => {
      for (const child of element.children) resize?.observe(child);
    };
    observeChildren();
    const mutation =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observeChildren();
            measure();
          });
    mutation?.observe(element, { childList: true, subtree: true, characterData: true });
    cleanup.current = () => {
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, []);
  useEffect(() => () => cleanup.current?.(), []);
  return [ref, overflowing] as const;
}

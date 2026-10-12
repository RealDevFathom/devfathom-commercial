import { useEffect } from 'react';
import { create } from 'zustand';

type BreadcrumbState = {
  // Maps a dynamic path segment (typically a record id) to a human-readable
  // label, e.g. { "cmqip2t1a0009...": "Saad Ajmal" }. The topbar reads this so
  // a detail route shows the entity name instead of its raw id.
  labels: Record<string, string>;
  setLabel: (segment: string, label: string) => void;
  clearLabel: (segment: string) => void;
};

export const useBreadcrumbStore = create<BreadcrumbState>((set) => ({
  labels: {},
  setLabel: (segment, label) =>
    set((s) => (s.labels[segment] === label ? s : { labels: { ...s.labels, [segment]: label } })),
  clearLabel: (segment) =>
    set((s) => {
      if (!(segment in s.labels)) return s;
      const next = { ...s.labels };
      delete next[segment];
      return { labels: next };
    }),
}));

/**
 * Registers a human-readable breadcrumb label for a dynamic route segment
 * (usually a record id). The topbar uses it to render e.g. a member's name in
 * place of their raw id. No-ops until `label` resolves (so the raw-id fallback
 * shows while loading), and clears the entry on unmount so a stale label never
 * leaks onto the next page.
 */
export function useBreadcrumbLabel(
  segment: string | undefined | null,
  label: string | undefined | null
) {
  const setLabel = useBreadcrumbStore((s) => s.setLabel);
  const clearLabel = useBreadcrumbStore((s) => s.clearLabel);
  useEffect(() => {
    if (!segment || !label) return;
    setLabel(segment, label);
    return () => clearLabel(segment);
  }, [segment, label, setLabel, clearLabel]);
}

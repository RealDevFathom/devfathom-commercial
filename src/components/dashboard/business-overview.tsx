import type { ReactNode } from 'react';

/** Each vertical supplies its own authorized sections and independently loaded data. */
export function BusinessOverview({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label="Business dashboard" className="grid min-w-0 gap-4 lg:grid-cols-2">
      <div className="min-w-0 lg:col-span-2">{summary}</div>
      {children}
    </section>
  );
}

import type { ReactNode } from 'react';

/** Keep shared metadata readable throughout pharmacy without changing shell geometry. */
export default function PharmacyLayout({ children }: { children: ReactNode }) {
  return <div className="pharmacy-workspace contents">{children}</div>;
}

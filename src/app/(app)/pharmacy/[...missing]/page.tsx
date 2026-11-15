import { notFound } from 'next/navigation';

/**
 * DEV-502: an unknown address under this section renders the in-app
 * not-found page (`src/app/(app)/not-found.tsx`) inside the workspace shell,
 * instead of the bare root 404 with no navigation. Real pages always win over
 * this catch-all.
 */
export default function MissingPage(): never {
  notFound();
}

import { redirect } from 'next/navigation';

import { inventoryCountsHref } from '@/components/pharmacy/inventory/inventory-links';

/**
 * Counts live in the Physical count section of the inventory page. This route
 * keeps `/pharmacy/inventory/counts` working and carries the working branch over;
 * the inventory page applies its own access checks.
 */
export default async function PharmacyInventoryCountsPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string | string[] }>;
}) {
  const { branch } = await searchParams;
  redirect(inventoryCountsHref(branch));
}

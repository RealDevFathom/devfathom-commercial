import type { Metadata } from 'next';
import { PharmacyDayCloseConsole } from '@/components/pharmacy/counter/day-close-console';
export const metadata: Metadata = { title: 'Pharmacy day close' };
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export default async function PharmacyDayClosePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) =>
    typeof value === 'string' ? value : undefined;
  return <PharmacyDayCloseConsole initial={{ branch: one(params.branch), date: one(params.date) }} />;
}

import type { Metadata } from 'next';
import { StagedMedicineCatalogue } from '@/components/pharmacy/staged-medicine-catalogue';

export const metadata: Metadata = { title: 'Staged medicine review' };
export default function StagedMedicinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return StagedMedicineCatalogue({
    searchParams,
    route: '/pharmacy/medicines/staged',
    heading: 'Staged medicines',
  });
}

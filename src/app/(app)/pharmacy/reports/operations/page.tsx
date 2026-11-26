import PharmacyReportsPage from '../page';

export default async function OperationalReportsPage({
  searchParams,
}: Parameters<typeof PharmacyReportsPage>[0]) {
  return PharmacyReportsPage({
    searchParams: Promise.resolve({ ...(await searchParams), view: 'operations' }),
  });
}

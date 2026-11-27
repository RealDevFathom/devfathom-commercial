import { UniversityPortal } from './portal-page';
export default async function Page({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  return (
    <UniversityPortal mode="apply" language={(await searchParams).lang === 'ur' ? 'ur' : 'en'} />
  );
}

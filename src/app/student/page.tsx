import { UniversityPortal } from '../apply/portal-page';
export default async function Page({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  return (
    <UniversityPortal mode="student" language={(await searchParams).lang === 'ur' ? 'ur' : 'en'} />
  );
}

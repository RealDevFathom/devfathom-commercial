import { Suspense } from 'react';

import Loading from './loading';

type SearchParams = Promise<
  Record<'branch' | 'from' | 'to' | 'department', string | string[] | undefined>
>;

async function ReportContent({ searchParams }: { searchParams: SearchParams }) {
  const { default: Content } = await import('./report-content');

  return <Content searchParams={searchParams} />;
}

export default function SopReportsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Loading />}>
      <ReportContent searchParams={searchParams} />
    </Suspense>
  );
}

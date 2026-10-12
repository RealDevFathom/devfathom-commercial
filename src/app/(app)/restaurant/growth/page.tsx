import { GrowthReviewPanel } from '@/components/restaurant/growth/growth-review-panel';
import { GrowthEntries } from '@/components/restaurant/growth/growth-entries';
import { loadGrowthReview, submitGrowthReview, listGrowth, generateGrowth } from './actions';

export default async function RestaurantGrowthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const branch = typeof query.branch === 'string' ? query.branch : '';
  const entries = branch ? await listGrowth({ branchId: branch }) : null;
  const view =
    query.branch && query.insight
      ? await loadGrowthReview({ branchId: query.branch, insightId: query.insight })
      : { status: 'NOT_FOUND' as const };
  return (
    <GrowthReviewPanel
      key={`${query.branch}:${query.insight}`}
      view={view}
      onReview={submitGrowthReview}
    >
      <GrowthEntries branchId={branch} entries={entries} onGenerate={generateGrowth} />
    </GrowthReviewPanel>
  );
}

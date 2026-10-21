import { buttonVariants } from '@/components/ui/button';
import type { RestaurantReportSection } from '@/lib/restaurant/reports';

export function ExportLink({
  section,
  branch,
  from,
  to,
  stockLocationId,
}: {
  section: RestaurantReportSection;
  branch: string;
  from: string;
  to: string;
  stockLocationId?: string;
}) {
  const params = new URLSearchParams({ section, branch, from, to });
  if (stockLocationId) params.set('stockLocation', stockLocationId);
  return (
    <a
      className={buttonVariants({ variant: 'secondary', size: 'sm' })}
      download
      href={`/api/restaurant/reports/export?${params.toString()}`}
    >
      Export CSV
    </a>
  );
}

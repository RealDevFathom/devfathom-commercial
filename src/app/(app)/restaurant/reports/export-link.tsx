import { buttonVariants } from '@/components/ui/button';
import type { RestaurantReportSection } from '@/lib/restaurant/reports';

export function ExportLink({
  section,
  branch,
  stockLocation,
  from,
  to,
}: {
  section: RestaurantReportSection;
  branch: string;
  stockLocation?: string;
  from: string;
  to: string;
}) {
  const params = new URLSearchParams({ section, branch, from, to });
  if (stockLocation) params.set('stockLocation', stockLocation);
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

import type { PrintJob, PrintRoute } from './contract';

export function resolvePrintRoute(routes: readonly PrintRoute[], job: PrintJob): PrintRoute | null {
  const eligible = routes.filter(
    (route) => route.enabled && route.documentType === job.document.type
  );
  return (
    eligible.find((route) => route.stationId !== null && route.stationId === job.stationId) ??
    eligible.find((route) => route.stationId === null) ??
    null
  );
}

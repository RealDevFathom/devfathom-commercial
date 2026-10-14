import type { PrintJob, PrintRoute, PrintRoutingConfig } from './contract';

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

/** Normalize the input contract without changing submitted route precedence. */
export function normalizePrintRoutingConfig(config: PrintRoutingConfig): PrintRoutingConfig {
  return {
    branchId: config.branchId.trim(),
    routes: config.routes.map((route) => ({
      documentType: route.documentType,
      stationId: route.stationId?.trim() ?? null,
      printerId: route.printerId.trim(),
      registeredPrinterId: route.registeredPrinterId?.trim() ?? null,
      enabled: route.enabled,
    })),
  };
}

export function samePrintRoutingConfig(a: PrintRoutingConfig, b: PrintRoutingConfig): boolean {
  const comparable = (config: PrintRoutingConfig) => {
    const value = normalizePrintRoutingConfig(config);
    // Independent scopes have no relative priority. Preserve order within a
    // scope for in-memory or divergent data with multiple matching routes.
    value.routes.sort((left, right) =>
      JSON.stringify([left.documentType, left.stationId]).localeCompare(
        JSON.stringify([right.documentType, right.stationId])
      )
    );
    return JSON.stringify(value);
  };
  return comparable(a) === comparable(b);
}

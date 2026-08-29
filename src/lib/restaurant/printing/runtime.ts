import type { PrintRoutingConfig } from './contract';
import { PrintBridgeService } from './service';
import { SimulatedPrintBridgeAdapter } from './stub';

type Runtime = {
  adapter: SimulatedPrintBridgeAdapter;
  service: PrintBridgeService;
  configs: Map<string, PrintRoutingConfig>;
};

const runtimeKey = Symbol.for('devfathom.restaurant.printBridge.simulation');
const host = globalThis as typeof globalThis & { [runtimeKey]?: Runtime };

/** Process-local simulation state. It is intentionally non-durable and must not be presented as production hardware. */
export function simulatedPrintRuntime(): Runtime {
  if (!host[runtimeKey]) {
    const adapter = new SimulatedPrintBridgeAdapter();
    host[runtimeKey] = { adapter, service: new PrintBridgeService(adapter), configs: new Map() };
  }
  return host[runtimeKey];
}

export function configKey(organizationId: string, branchId: string) {
  return `${organizationId}:${branchId}`;
}

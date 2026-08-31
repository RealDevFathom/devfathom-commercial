import { SimulatedPrintBridgeAdapter } from './stub';

type Runtime = {
  adapter: SimulatedPrintBridgeAdapter;
};

const runtimeKey = Symbol.for('devfathom.restaurant.printBridge.simulation');
const host = globalThis as typeof globalThis & { [runtimeKey]?: Runtime };

/** Process-local simulated hardware only. Configuration and jobs are durable in PostgreSQL. */
export function simulatedPrintRuntime(): Runtime {
  if (!host[runtimeKey]) {
    const adapter = new SimulatedPrintBridgeAdapter();
    host[runtimeKey] = { adapter };
  }
  return host[runtimeKey];
}

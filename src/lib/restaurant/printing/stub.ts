import type { PrintBridgeAdapter } from './contract';

/** Simulation only. This is not a hardware driver and performs no network or OS I/O. */
export class SimulatedPrintBridgeAdapter implements PrintBridgeAdapter {
  readonly kind = 'SIMULATION_ONLY';
  private offline = new Set<string>();
  readonly deliveries: Array<{ printerId: string; bytes: Uint8Array }> = [];

  setOffline(printerId: string, offline: boolean) {
    if (offline) this.offline.add(printerId);
    else this.offline.delete(printerId);
  }

  async send(printerId: string, bytes: Uint8Array): Promise<'PRINTED' | 'OFFLINE'> {
    if (this.offline.has(printerId)) return 'OFFLINE';
    this.deliveries.push({ printerId, bytes: bytes.slice() });
    return 'PRINTED';
  }
}

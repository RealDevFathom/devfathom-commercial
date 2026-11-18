import 'server-only';

import type { LedgerScope } from '../stock-ledger';
import type { CardTerminalAdapter, TerminalAdmission } from './contract';

/**
 * DEV-743: which integrated card terminal, if any, serves a branch's counter.
 *
 * NO PROVIDER IS BOUND. Provider and device selection wait for a named proposal and a real-device
 * test (the owner's decision), so this resolves nothing for every branch and device, and the
 * router answers "not available". Binding a provider is its own reviewed change: it returns that
 * provider's adapter and the terminal paired with the counter here, and adds the provider to
 * `PRODUCTION_TERMINAL_ADMISSION` with its certification evidence and real-device test linked.
 * Even then the service checks admission again before every charge and status query.
 *
 * Tests replace this module to drive the fake terminal (`testing/fake-terminal.ts`).
 */
export type ResolvedCardTerminal = {
  adapter: CardTerminalAdapter;
  /** The terminal paired with this counter. Chosen on the server, never by the browser. */
  terminalId: string;
  /** Tests only: a production process always uses the built-in, empty admission list. */
  admission?: TerminalAdmission;
};

export const resolvePharmacyCardTerminal: (
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  deviceId: string | null
) => Promise<ResolvedCardTerminal | null> = async () => null;

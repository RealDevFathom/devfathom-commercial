import 'server-only';

import type { TerminalIntent } from './intent';
import { TERMINAL_UNRESOLVED_STATES } from './intent';

/**
 * DEV-743 — persistence port for terminal intents.
 *
 * The seam ships the PORT and an in-memory reference implementation used by tests.
 * There is no database table or migration in this change. The proposed PostgreSQL
 * table (docs/pharmacy/card-terminal-integration-boundary.md) must give the same
 * guarantees this port promises:
 *
 *  - `createOrGet` is atomic. A unique (organizationId, intentRef) key returns the
 *    existing intent on replay. A per-sale guard (the sale row lock, or a partial
 *    unique index over unresolved and approved-unsettled intents) makes sure only
 *    one money-moving operation per sale is open at a time.
 *  - `compareAndSet` is an optimistic update on `version`. It succeeds for exactly
 *    one writer, so two tabs or a retry racing a recovery job cannot both dispatch.
 *  - Rows are tenant-scoped. Every read and write carries organizationId.
 */

export type CreateOrGetResult =
  | { status: 'CREATED'; intent: TerminalIntent }
  | { status: 'EXISTING'; intent: TerminalIntent }
  | { status: 'BLOCKED'; blocking: TerminalIntent };

export interface TerminalIntentStore {
  createOrGet(intent: TerminalIntent): Promise<CreateOrGetResult>;
  get(organizationId: string, intentRef: string): Promise<TerminalIntent | null>;
  compareAndSet(expectedVersion: number, next: TerminalIntent): Promise<boolean>;
  listForSale(organizationId: string, saleId: string): Promise<TerminalIntent[]>;
  listUnresolved(organizationId: string, branchId: string): Promise<TerminalIntent[]>;
}

/** Whether `existing` blocks a new operation of `candidate` on the same sale. */
export function blocksNewOperation(existing: TerminalIntent, candidate: TerminalIntent) {
  if (existing.intentRef === candidate.intentRef) return false;
  if (existing.saleId !== candidate.saleId) return false;
  if (TERMINAL_UNRESOLVED_STATES.has(existing.state)) return true;
  // An approved charge that is not yet a tender (or an approved reversal not yet a
  // refund) must be settled or reversed before anything else touches this sale.
  return existing.state === 'APPROVED';
}

/** Deep copy so callers can never mutate stored state by reference. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory store for tests and the mocked end-to-end suite. Not for production. */
export function createInMemoryTerminalIntentStore(): TerminalIntentStore & {
  all(): TerminalIntent[];
} {
  const rows = new Map<string, TerminalIntent>();
  const key = (organizationId: string, intentRef: string) => `${organizationId}\u0000${intentRef}`;

  return {
    async createOrGet(intent) {
      const existing = rows.get(key(intent.organizationId, intent.intentRef));
      if (existing) return { status: 'EXISTING', intent: clone(existing) };
      for (const row of rows.values()) {
        if (row.organizationId === intent.organizationId && blocksNewOperation(row, intent))
          return { status: 'BLOCKED', blocking: clone(row) };
      }
      rows.set(key(intent.organizationId, intent.intentRef), clone(intent));
      return { status: 'CREATED', intent: clone(intent) };
    },
    async get(organizationId, intentRef) {
      const row = rows.get(key(organizationId, intentRef));
      return row ? clone(row) : null;
    },
    async compareAndSet(expectedVersion, next) {
      const k = key(next.organizationId, next.intentRef);
      const current = rows.get(k);
      if (!current || current.version !== expectedVersion) return false;
      if (next.version <= expectedVersion) return false;
      rows.set(k, clone(next));
      return true;
    },
    async listForSale(organizationId, saleId) {
      return [...rows.values()]
        .filter((row) => row.organizationId === organizationId && row.saleId === saleId)
        .map(clone);
    },
    async listUnresolved(organizationId, branchId) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.organizationId === organizationId &&
            row.branchId === branchId &&
            TERMINAL_UNRESOLVED_STATES.has(row.state)
        )
        .map(clone);
    },
    all() {
      return [...rows.values()].map(clone);
    },
  };
}

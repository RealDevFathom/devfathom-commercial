import 'server-only';

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { redactForLog } from './cardholder-data';
import { PRODUCTION_TERMINAL_ADMISSION, terminalAdmissionRefusal } from './contract';
import { resolvePharmacyCardTerminal } from './registry';
import { recoverCardTerminalAttempt, type CardTerminalDeps } from './service';
import {
  OPEN_ATTEMPT_STATUSES,
  prismaCardTerminalAttemptStore,
  type CardTerminalAttemptStore,
} from './store';

/**
 * DEV-743: the scheduled recovery sweep for card-terminal attempts a counter left behind (the
 * browser closed, the request was cut, the server restarted). Every few minutes, each stale
 * attempt is recovered exactly as the counter's "Check status" does: a status query on the same
 * operation reference, never a new charge. A stale CREATED attempt is closed unsent, an APPROVED
 * one is recorded as its tender, and one that stays unknown ends in manual review.
 *
 * Manual review waits for a person and is not swept. No provider is bound, so in production no
 * terminal resolves and every candidate is skipped (there are none: an attempt cannot begin
 * without an admitted terminal).
 */

/** An attempt untouched this long is the sweep's to recover; the counter owns a fresher one. */
export const CARD_TERMINAL_STALE_AFTER_MS = 2 * 60_000;

const SWEPT_STATUSES = OPEN_ATTEMPT_STATUSES.filter((status) => status !== 'MANUAL_REVIEW');

export type CardTerminalSweepCandidate = {
  organizationId: string;
  branchId: string;
  attemptKey: string;
  deviceId: string;
  actorId: string;
};

export type CardTerminalSweepOptions = {
  resolve?: typeof resolvePharmacyCardTerminal;
  listDue?: (staleBefore: Date, take: number) => Promise<CardTerminalSweepCandidate[]>;
  /** One committed tenant transaction per store call, as the attempt's own cashier. */
  storeFor?: (candidate: CardTerminalSweepCandidate) => CardTerminalAttemptStore;
};

function listDueAttempts(staleBefore: Date, take: number) {
  return withPlatformDb((db) =>
    db.pharmacyCardTerminalAttempt.findMany({
      where: { status: { in: [...SWEPT_STATUSES] }, updatedAt: { lte: staleBefore } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: {
        organizationId: true,
        branchId: true,
        attemptKey: true,
        deviceId: true,
        actorId: true,
      },
      take,
    })
  );
}

function tenantStore(candidate: CardTerminalSweepCandidate) {
  return prismaCardTerminalAttemptStore((work) =>
    withTenantDb(candidate.organizationId, work, { userId: candidate.actorId })
  );
}

export async function processDueCardTerminalRecovery(
  now = new Date(),
  limit = 25,
  options: CardTerminalSweepOptions = {}
) {
  const resolve = options.resolve ?? resolvePharmacyCardTerminal;
  const take = Math.max(1, Math.min(500, Math.floor(limit)));
  const candidates = await (options.listDue ?? listDueAttempts)(
    new Date(now.getTime() - CARD_TERMINAL_STALE_AFTER_MS),
    take
  );
  const result = { attempts: candidates.length, resolved: 0, open: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    const scope = {
      organizationId: candidate.organizationId,
      branchId: candidate.branchId,
      actorId: candidate.actorId,
    };
    try {
      const terminal = await resolve(scope, candidate.deviceId);
      if (
        !terminal ||
        terminalAdmissionRefusal(
          terminal.adapter,
          terminal.admission ?? PRODUCTION_TERMINAL_ADMISSION
        )
      ) {
        result.skipped += 1;
        continue;
      }
      const deps: CardTerminalDeps = {
        store: (options.storeFor ?? tenantStore)(candidate),
        adapter: terminal.adapter,
        ...(terminal.admission ? { admission: terminal.admission } : {}),
        now: () => now,
      };
      const attempt = await recoverCardTerminalAttempt(deps, scope, candidate.attemptKey);
      if (OPEN_ATTEMPT_STATUSES.includes(attempt.status)) result.open += 1;
      else result.resolved += 1;
    } catch (error) {
      result.failed += 1;
      console.error(
        '[pharmacy-card-terminal] recovery sweep failed',
        redactForLog({
          organizationId: candidate.organizationId,
          branchId: candidate.branchId,
          error: error instanceof Error ? error.message : 'unknown',
        })
      );
    }
  }
  return result;
}

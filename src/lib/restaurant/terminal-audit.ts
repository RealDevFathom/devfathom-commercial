import 'server-only';

import type { TerminalContext } from '@/lib/restaurant/terminal-auth';
import { recordAudit, type AuditOperationT } from '@/server/audit';

/**
 * M2 attribution (C6/C7) — write ONE audit row for a sensitive terminal
 * mutation, attributing the ACTING restaurant operator (and, for a co-authorized
 * action, the approving manager, carried in metadata).
 *
 * An operator acts at a device-authenticated terminal and is NOT a User (C2), so
 * the row is typed `RESTAURANT_OPERATOR` and its `actorId` is the acting staff
 * profile id — never a User id. The device and terminal session are always
 * pinned so an action can be traced to the exact terminal it was taken on.
 *
 * Delegates to the platform audit core (`recordAudit`), which is fire-and-forget
 * and writes in its OWN transaction: a failed audit write can neither roll back
 * nor fail the operator's action, and never surfaces to the caller. Only
 * server-derived, non-secret values are recorded — the operator's PIN/badge
 * secret is never part of the entry.
 */
export function recordTerminalOperatorAudit(
  ctx: TerminalContext,
  entry: {
    /** Dotted action name, e.g. `restaurant.terminal.unlock`. */
    action: string;
    /** The operator the action is attributed to (the acting identity). */
    actingStaffProfileId: string;
    operation?: AuditOperationT;
    targetType?: string | null;
    targetId?: string | null;
    /** Extra structured context merged into the row's metadata (no secrets). */
    metadata?: Record<string, unknown>;
  }
): void {
  recordAudit({
    organizationId: ctx.organizationId,
    actorType: 'RESTAURANT_OPERATOR',
    actorId: entry.actingStaffProfileId,
    source: 'REST_API',
    category: 'TERMINAL',
    operation: entry.operation ?? 'UPDATE',
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    httpMethod: 'POST',
    metadata: {
      deviceId: ctx.device.id,
      terminalSessionId: ctx.session.id,
      actingStaffProfileId: entry.actingStaffProfileId,
      ...(entry.metadata ?? {}),
    },
  });
}

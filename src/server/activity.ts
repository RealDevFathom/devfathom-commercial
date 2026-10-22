import type { PrismaClient } from '@/generated/prisma/client';
import { trackSideEffect } from '@/lib/side-effects/scope';

/**
 * Activity types — keep this list in sync with the dashboard's getActivityColor mapping.
 *
 * Convention: <entity>_<verb>. Anything starting with `invoice_` or `transaction_`
 * is treated as finance and hidden from non-admin users in the activity feed.
 */
export type ActivityType =
  | 'project_created'
  | 'project_updated'
  | 'project_deleted'
  | 'project_member_added'
  | 'project_member_removed'
  | 'project_file_added'
  | 'task_created'
  | 'task_completed'
  | 'task_assigned'
  | 'note_created'
  | 'note_shared'
  | 'client_created'
  | 'client_deleted'
  | 'contract_created'
  | 'contract_updated'
  | 'contract_deleted'
  | 'invoice_created'
  | 'invoice_sent'
  | 'invoice_paid'
  | 'meeting_joined'
  | 'member_status_changed';

export interface LogActivityArgs {
  type: ActivityType;
  message: string;
  entityType?:
    | 'Project'
    | 'Task'
    | 'Note'
    | 'Client'
    | 'Contract'
    | 'Invoice'
    | 'Meeting'
    | 'User';
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a single row to the Activity feed. Fire-and-forget — never blocks
 * or rejects the surrounding mutation if the insert fails (the user action
 * succeeded; failing to log shouldn't surface an error to the client).
 */
export function logActivity(db: PrismaClient, userId: string, args: LogActivityArgs): void {
  const write = db.activity
    .create({
      data: {
        type: args.type,
        message: args.message,
        userId,
        entityType: args.entityType ?? null,
        entityId: args.entityId ?? null,
        metadata: (args.metadata ?? undefined) as never,
      },
    })
    .catch((err) => {
      // Prisma errors can contain query values. Log only stable, non-sensitive
      // diagnostics rather than the full error object.
      const code =
        typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
          ? err.code
          : 'unknown';
      console.error('[activity] failed to log', args.type, code);
    });

  // Tenant requests run inside an interactive transaction. Register this
  // otherwise fire-and-forget write so withTenantDb waits for it before commit;
  // without this, Prisma can close the transaction first and reject with P2028.
  trackSideEffect(write);
}

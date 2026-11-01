import type { PrismaClient } from '@/generated/prisma/client';
import { trackTransactionWork } from '@/lib/side-effects/scope';

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
  entityType?: 'Project' | 'Task' | 'Note' | 'Client' | 'Contract' | 'Invoice' | 'Meeting' | 'User';
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a single row to the Activity feed. The write never rejects the
 * surrounding mutation; inside a tenant transaction it is allowed to settle
 * before commit, while calls outside that scope remain fire-and-forget.
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
      console.error('[activity] failed to log', args.type, err);
    });

  // Tenant requests run on an interactive transaction. Although activity is
  // best-effort, the insert must finish before that transaction is allowed to
  // close; otherwise Prisma rejects the still-pending query with P2028.
  // Outside a tenant request there is no scope, so the existing fire-and-forget
  // behaviour is preserved.
  trackTransactionWork(write);
}

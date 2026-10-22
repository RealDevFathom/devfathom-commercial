import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Use the central authorization decision for server-rendered purchasing access. */
export async function actorCanProcure(db: ScopedDb, userId: string, now = new Date()) {
  return can(
    { id: userId, role: 'EMPLOYEE', department: null, status: null },
    'pharmacy:procurement',
    undefined,
    { db, now }
  );
}

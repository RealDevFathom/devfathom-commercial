import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function actorCanProcure(db: ScopedDb, userId: string, now = new Date()) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      department: true,
      status: true,
    },
  });
  if (!user) return false;
  return can(subjectFromSession(user), 'pharmacy:procurement', undefined, { db, now });
}

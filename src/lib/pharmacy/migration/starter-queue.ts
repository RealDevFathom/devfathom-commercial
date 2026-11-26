import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function enqueueStarterImport(db: ScopedDb, organizationId: string) {
  await db.$executeRaw`
    INSERT INTO pharmacy_starter_imports ("organizationId")
    SELECT id FROM organizations WHERE id = ${organizationId} AND vertical = 'PHARMACY'
    ON CONFLICT ("organizationId") DO NOTHING`;
}

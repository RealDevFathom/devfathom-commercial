import 'server-only';
import { createHmac, randomUUID } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { hashEnrollmentToken } from './enrollment';

// Reprint the same public poster without persisting the QR token in plaintext.
function posterToken(id: string) {
  const key = process.env.AUTH_SECRET;
  if (!key) throw new Error('The application signing secret is required to print a poster.');
  const bits = createHmac('sha256', key)
    .update('wallet-branch-poster-v1:' + id)
    .digest()
    .subarray(0, 16);
  return (
    'wel_' +
    Array.from(bits, (b) => b.toString(2).padStart(8, '0'))
      .join('')
      .padStart(130, '0')
      .match(/.{5}/g)!
      .map((v) => '0123456789abcdefghjkmnpqrstvwxyz'[parseInt(v, 2)])
      .join('')
  );
}

export async function branchPoster(
  db: ScopedDb,
  organizationId: string,
  pharmacy: boolean,
  branchId: string
) {
  await db.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId} FOR UPDATE`;
  const config = await db.walletTenantConfig.findUnique({ where: { organizationId } });
  const where = { id: branchId, organizationId, active: true };
  const branch = pharmacy
    ? await db.pharmacyBranch.findFirst({ where, select: { id: true } })
    : await db.restaurantBranch.findFirst({ where, select: { id: true } });
  if (!branch || !config?.enabled)
    throw new Error('Enable the programme and select an active branch.');
  const carrier = pharmacy ? { pharmacyBranchId: branchId } : { branchId };
  const existing = await db.walletEnrollmentLink.findFirst({
    where: { organizationId, ...carrier, phoneJoin: true, active: true },
  });
  const id = existing?.id ?? randomUUID(),
    token = posterToken(id),
    tokenHash = hashEnrollmentToken(token);
  if (!existing)
    await db.walletEnrollmentLink.create({
      data: { id, organizationId, ...carrier, tokenHash, phoneJoin: true },
    });
  else if (existing.tokenHash !== tokenHash)
    await db.walletEnrollmentLink.update({ where: { id }, data: { tokenHash } });
  return '/wallet/join/' + token;
}

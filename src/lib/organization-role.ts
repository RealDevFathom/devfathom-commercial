import type { Prisma } from '@/generated/prisma/client';
import { z } from 'zod';

export const organizationRolePermissionsSchema = z
  .array(
    z.object({
      capability: z.string().trim().min(1).max(150),
      effect: z.enum(['ALLOW', 'DENY']),
    })
  )
  .max(250)
  .superRefine((permissions, ctx) => {
    const capabilities = new Set<string>();
    permissions.forEach((permission, index) => {
      if (capabilities.has(permission.capability)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each capability may only appear once.',
          path: [index, 'capability'],
        });
      }
      capabilities.add(permission.capability);
    });
  });

/** Keep unchanged grants in place. Install additions before removing superseded
 * grants so a role promotion never transiently withdraws terminal access. */
export async function replaceRolePermissions(
  db: Pick<Prisma.TransactionClient, 'organizationRolePermission'>,
  organizationId: string,
  organizationRoleId: string,
  current: readonly { capability: string; effect: 'ALLOW' | 'DENY' }[],
  requested: z.infer<typeof organizationRolePermissionsSchema>
) {
  const scope = { organizationId, organizationRoleId };
  const existing = new Map(current.map((row) => [row.capability, row.effect]));
  const desired = new Set(requested.map((row) => row.capability));
  // Install final denies before new allowances, and discard obsolete allowances
  // before lifting obsolete denies. No intermediate state grants a right that
  // neither the initial nor the final role had.
  const add = async (effect: 'ALLOW' | 'DENY') => {
    const rows = requested.filter((row) => row.effect === effect && !existing.has(row.capability));
    if (rows.length)
      await db.organizationRolePermission.createMany({
        data: rows.map((row) => ({ ...scope, ...row })),
      });
  };
  const flip = async (effect: 'ALLOW' | 'DENY') => {
    const names = requested
      .filter(
        (row) =>
          row.effect === effect &&
          existing.has(row.capability) &&
          existing.get(row.capability) !== effect
      )
      .map((row) => row.capability);
    if (names.length)
      await db.organizationRolePermission.updateMany({
        where: { ...scope, capability: { in: names } },
        data: { effect },
      });
  };
  const remove = async (effect: 'ALLOW' | 'DENY') => {
    const names = current
      .filter((row) => row.effect === effect && !desired.has(row.capability))
      .map((row) => row.capability);
    if (names.length)
      await db.organizationRolePermission.deleteMany({
        where: { ...scope, capability: { in: names } },
      });
  };
  await add('DENY');
  await flip('DENY');
  await add('ALLOW');
  await remove('ALLOW');
  await flip('ALLOW');
  await remove('DENY');
}

import type { ApiContext } from '@/lib/api-auth';
import { hasModule } from '@/lib/entitlements';
import {
  bindOfficeScope,
  canAccessOffice,
  universityStaffContext,
  UniversityAccessError,
} from './access';
import { deliveryPolicy } from './connector-topics';
import { officeRoleAllowed } from './office-types';
import { universityOffices } from './offices';

/** Polls and receipts share the same current authority. Hold the token-topic assignment for the transaction. */
export async function permitsUniversityDelivery(ctx: ApiContext, kind: string): Promise<boolean> {
  const policy = deliveryPolicy(kind);
  const office = policy && universityOffices.get(policy.office);
  if (
    !policy ||
    !office ||
    ctx.entitlements.vertical !== 'UNIVERSITY' ||
    !hasModule(ctx.entitlements, office.moduleKey)
  )
    return false;
  await ctx.db.$queryRaw`SELECT set_config('app.current_user_id',${ctx.userId},true)`;
  const [grant] = await ctx.db.$queryRaw<
    { present: boolean }[]
  >`SELECT true AS present FROM university_connector_topics t
    JOIN api_tokens k ON (k."organizationId",k.id)=(t.organization_id,t.token_id)
    WHERE t.organization_id=${ctx.organizationId} AND t.kind=${kind} AND k.id=${ctx.tokenId}
      AND k."userId"=${ctx.userId} AND (k."expiresAt" IS NULL OR k."expiresAt">now())
    FOR SHARE OF t,k`;
  if (!grant) return false;
  let staff;
  try {
    staff = await universityStaffContext(ctx.db, ctx.organizationId, ctx.userId, ctx.entitlements);
  } catch (error) {
    if (error instanceof UniversityAccessError) return false;
    throw error;
  }
  if (staff.coverage !== 'INSTITUTION' || !canAccessOffice(staff, office)) return false;
  if (
    policy.roles &&
    !(policy.strictRoles
      ? policy.roles.includes(staff.roleKey)
      : officeRoleAllowed(staff, policy.roles))
  )
    return false;
  await bindOfficeScope(staff, office);
  return true;
}

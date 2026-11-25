import { z } from 'zod';
import type { UniversityContext } from './office-types';

export type DelegationSummary = {
  id: string;
  relationship: 'GUARDIAN' | 'SPONSOR';
  permission: 'FINANCIAL_SUMMARY' | 'SPECIFIC_CHALLAN';
  challan_reference: string | null;
  ends_on: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
};
export class DelegationError extends Error {}
function requirePortal(ctx: UniversityContext) {
  if (ctx.admin || ctx.roleKey !== 'university-learner')
    throw new DelegationError('Sign in to the university portal.');
}
const grantInput = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .email()
    .transform((v) => v.toLowerCase()),
  relationship: z.enum(['GUARDIAN', 'SPONSOR']),
  permission: z.enum(['FINANCIAL_SUMMARY', 'SPECIFIC_CHALLAN']),
  challanReference: z.string().trim().max(100).optional(),
  endsOn: z.iso.date(),
  consent: z.literal('yes'),
});
type GrantRecord = {
  id: string;
  student_id: string;
  recipient_id: string | null;
  permission: DelegationSummary['permission'];
  challan_reference: string | null;
};
async function audit(
  ctx: UniversityContext,
  id: string,
  event: 'CONSENTED' | 'CLAIMED' | 'VIEWED' | 'REVOKED'
) {
  await ctx.db
    .$executeRaw`INSERT INTO university_fee_delegation_audit(organization_id,grant_id,event,person_id)
    VALUES(${ctx.organizationId},${id},${event},${ctx.userId}) ON CONFLICT DO NOTHING`;
}
async function expireVisible(ctx: UniversityContext) {
  await ctx.db
    .$executeRaw`INSERT INTO university_fee_delegation_audit(organization_id,grant_id,event,effective_at)
    SELECT g.organization_id,g.id,'EXPIRED',g.expires_at FROM university_fee_delegations g
    WHERE g.organization_id=${ctx.organizationId} AND g.expires_at<=now() AND (g.revoked_at IS NULL OR g.revoked_at>=g.expires_at)
      AND (g.student_id=${ctx.userId} OR EXISTS(SELECT 1 FROM university_people p WHERE p.organization_id=g.organization_id
      AND p.id=${ctx.userId} AND p.email=g.recipient_email AND (g.recipient_id IS NULL OR g.recipient_id=p.id)))
    ON CONFLICT DO NOTHING`;
}
export async function consentFeeDelegation(ctx: UniversityContext, input: unknown) {
  requirePortal(ctx);
  const d = grantInput.parse(input),
    reference = d.permission === 'SPECIFIC_CHALLAN' ? d.challanReference : null;
  if (d.permission === 'SPECIFIC_CHALLAN' && !reference)
    throw new DelegationError('Select the challan to share.');
  const [student] = await ctx.db.$queryRaw<{ id: string }[]>`SELECT p.id FROM university_people p
    WHERE p.organization_id=${ctx.organizationId} AND p.id=${ctx.userId} AND p.email<>${d.email}
      AND EXISTS(SELECT 1 FROM university_student_programs s WHERE s.organization_id=p.organization_id AND s.person_id=p.id AND s.status='ACTIVE')
      AND ${d.endsOn}::date >= (now() AT TIME ZONE 'Asia/Karachi')::date
      AND (${reference ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM university_challans c WHERE c.organization_id=p.organization_id
        AND c.person_id=p.id AND c.reference=${reference ?? null}))
    FOR UPDATE OF p`;
  if (!student)
    throw new DelegationError(
      'Use an active student account, a different recipient email, your own challan and a current or future expiry.'
    );
  const existing = await ctx.db.$queryRaw<{ id: string; same: boolean }[]>`SELECT id,
    (relationship=${d.relationship} AND expires_at=((${d.endsOn}::date+1)::timestamp AT TIME ZONE 'Asia/Karachi')) AS same
    FROM university_fee_delegations WHERE organization_id=${ctx.organizationId} AND student_id=${ctx.userId}
      AND recipient_email=${d.email} AND permission=${d.permission} AND challan_reference IS NOT DISTINCT FROM ${reference ?? null}
      AND expires_at>now() AND revoked_at IS NULL FOR UPDATE`;
  const same = existing.find((g) => g.same);
  if (same) return { id: same.id };
  for (const old of existing) await revokeFeeDelegation(ctx, old.id);
  const [grant] = await ctx.db.$queryRaw<{ id: string }[]>`INSERT INTO university_fee_delegations
    (organization_id,student_id,recipient_email,recipient_id,relationship,permission,challan_reference,consent_version,expires_at)
    VALUES(${ctx.organizationId},${ctx.userId},${d.email},
      (SELECT id FROM university_people WHERE organization_id=${ctx.organizationId} AND email=${d.email}),
      ${d.relationship},${d.permission},${reference ?? null},'FEE-DISCLOSURE-1',((${d.endsOn}::date+1)::timestamp AT TIME ZONE 'Asia/Karachi')) RETURNING id`;
  await audit(ctx, grant.id, 'CONSENTED');
  await ctx.db
    .$executeRaw`INSERT INTO university_fee_delegation_audit(organization_id,grant_id,event,person_id,effective_at)
    SELECT organization_id,id,'EXPIRY_SCHEDULED',student_id,expires_at FROM university_fee_delegations
    WHERE organization_id=${ctx.organizationId} AND id=${grant.id}`;
  return grant;
}
export async function revokeFeeDelegation(ctx: UniversityContext, id: string) {
  requirePortal(ctx);
  const rows = await ctx.db
    .$executeRaw`UPDATE university_fee_delegations SET revoked_at=coalesce(revoked_at,now())
    WHERE organization_id=${ctx.organizationId} AND id=${id} AND student_id=${ctx.userId}`;
  if (!rows) throw new DelegationError('This access grant is unavailable.');
  await audit(ctx, id, 'REVOKED');
  return { id };
}
export async function listFeeDelegations(ctx: UniversityContext) {
  requirePortal(ctx);
  await expireVisible(ctx);
  const outgoing = await ctx.db.$queryRaw<
    (DelegationSummary & { recipient_email: string })[]
  >`SELECT id,recipient_email,relationship,permission,challan_reference,
    ((expires_at AT TIME ZONE 'Asia/Karachi')::date-1)::text AS ends_on,
    CASE WHEN revoked_at IS NOT NULL THEN 'REVOKED' WHEN expires_at<=now() THEN 'EXPIRED' ELSE 'ACTIVE' END AS status
    FROM university_fee_delegations WHERE organization_id=${ctx.organizationId} AND student_id=${ctx.userId} ORDER BY consented_at DESC,id LIMIT 150`;
  const incoming = await ctx.db.$queryRaw<
    (DelegationSummary & { student_name: string })[]
  >`SELECT g.id,s.full_name AS student_name,g.relationship,g.permission,g.challan_reference,
    ((g.expires_at AT TIME ZONE 'Asia/Karachi')::date-1)::text AS ends_on,'ACTIVE' AS status FROM university_fee_delegations g
    JOIN university_people p ON p.organization_id=g.organization_id AND p.email=g.recipient_email AND p.id=${ctx.userId} AND (g.recipient_id IS NULL OR g.recipient_id=p.id)
    JOIN university_people s ON s.organization_id=g.organization_id AND s.id=g.student_id
    WHERE g.organization_id=${ctx.organizationId} AND g.expires_at>now() AND g.revoked_at IS NULL ORDER BY g.consented_at DESC,g.id LIMIT 150`;
  const challans = await ctx.db.$queryRaw<
    { reference: string }[]
  >`SELECT reference FROM university_challans WHERE organization_id=${ctx.organizationId} AND person_id=${ctx.userId} ORDER BY created_at DESC,reference`;
  const [student] = await ctx.db.$queryRaw<
    { can_consent: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM university_student_programs WHERE organization_id=${ctx.organizationId} AND person_id=${ctx.userId} AND status='ACTIVE') AS can_consent`;
  return { outgoing, incoming, challans, canConsent: student.can_consent };
}
export async function readDelegatedFees(ctx: UniversityContext, id: string) {
  requirePortal(ctx);
  const [g] = await ctx.db.$queryRaw<
    GrantRecord[]
  >`SELECT g.id,g.student_id,g.recipient_id,g.permission,g.challan_reference FROM university_fee_delegations g
    JOIN university_people p ON p.organization_id=g.organization_id AND p.email=g.recipient_email AND p.id=${ctx.userId}
    WHERE g.organization_id=${ctx.organizationId} AND g.id=${id} AND g.expires_at>now() AND g.revoked_at IS NULL
      AND (g.recipient_id IS NULL OR g.recipient_id=p.id) FOR UPDATE OF g`;
  if (!g) throw new DelegationError('This access grant is unavailable.');
  if (!g.recipient_id) {
    await ctx.db
      .$executeRaw`UPDATE university_fee_delegations SET recipient_id=${ctx.userId} WHERE organization_id=${ctx.organizationId} AND id=${g.id}`;
    await audit(ctx, g.id, 'CLAIMED');
  }
  await audit(ctx, g.id, 'VIEWED');
  if (g.permission === 'SPECIFIC_CHALLAN') {
    const [challan] = await ctx.db.$queryRaw<
      {
        reference: string;
        fee_head: string;
        amount_paisa: string;
        balance_paisa: string;
        due_date: string;
      }[]
    >`
      SELECT c.reference,c.fee_head,c.amount_paisa::text,c.due_date::text,
        coalesce(sum(CASE WHEN e.debit_account='STUDENT_RECEIVABLE' THEN e.amount_paisa WHEN e.credit_account='STUDENT_RECEIVABLE' THEN -e.amount_paisa ELSE 0 END),0)::text AS balance_paisa
        FROM university_challans c LEFT JOIN university_finance_entries e ON e.organization_id=c.organization_id AND e.reference=c.reference
        WHERE c.organization_id=${ctx.organizationId} AND c.person_id=${g.student_id} AND c.reference=${g.challan_reference}
        GROUP BY c.reference,c.fee_head,c.amount_paisa,c.due_date`;
    if (!challan) throw new DelegationError('The selected challan is unavailable.');
    return { permission: 'SPECIFIC_CHALLAN' as const, currency: 'PKR', challan };
  }
  const [summary] = await ctx.db.$queryRaw<
    { balance_paisa: string; overdue_paisa: string; open_challans: number }[]
  >`WITH balances AS (
    SELECT c.reference,c.due_date,coalesce(sum(CASE WHEN e.debit_account='STUDENT_RECEIVABLE' THEN e.amount_paisa WHEN e.credit_account='STUDENT_RECEIVABLE' THEN -e.amount_paisa ELSE 0 END),0) AS balance
    FROM university_challans c LEFT JOIN university_finance_entries e ON e.organization_id=c.organization_id AND e.reference=c.reference
    WHERE c.organization_id=${ctx.organizationId} AND c.person_id=${g.student_id} GROUP BY c.reference,c.due_date)
    SELECT coalesce(sum(balance),0)::text AS balance_paisa,
      coalesce(sum(balance) FILTER(WHERE balance>0 AND due_date<(now() AT TIME ZONE 'Asia/Karachi')::date),0)::text AS overdue_paisa,
      count(*) FILTER(WHERE balance>0)::integer AS open_challans FROM balances`;
  return { permission: 'FINANCIAL_SUMMARY' as const, currency: 'PKR', summary };
}

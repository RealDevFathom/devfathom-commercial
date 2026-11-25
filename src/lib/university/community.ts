import { z } from 'zod';
import { emitUniversityEvent } from './events';
import { issueStudentCharge } from './finance';
import {
  officeRoleAllowed,
  type UniversityContext,
  type UniversityField,
  type UniversityOffice,
} from './office-types';
import { allocate, AllocationConflict, requireRegisteredStudent } from './services';

type Input = Record<string, string>;
type Rows = Record<string, unknown>[];
type Id = { id: string };
const serviceRoles = ['university-services-officer'],
  registrarRoles = ['university-registrar'],
  advisorRoles = ['university-advisor'];
const text = z.string().trim().min(1).max(500);
const narrative = z.string().trim().min(1).max(2500);
const dates = z
  .object({ startsOn: z.iso.date(), endsOn: z.iso.date() })
  .refine((d) => d.startsOn <= d.endsOn, 'End date must follow start date.');
const paisa = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(999_999_999_999));

export async function promoteHousingWaitlist(ctx: UniversityContext, resourceId: string) {
  const [r] = await ctx.db.$queryRaw<
    Id[]
  >`SELECT id FROM university_service_resources WHERE organization_id=${ctx.organizationId} AND id=${resourceId} AND kind='HOSTEL' FOR UPDATE`;
  if (!r) return;
  await ctx.db
    .$executeRaw`UPDATE university_housing_waitlist SET status='EXPIRED' WHERE organization_id=${ctx.organizationId}
    AND resource_id=${resourceId} AND status='WAITING' AND ends_on < (now() AT TIME ZONE 'Asia/Karachi')::date`;
  const waiting = await ctx.db.$queryRaw<
    { id: string; person_id: string; starts_on: string; ends_on: string }[]
  >`
    SELECT w.id,w.person_id,greatest(w.starts_on,(now() AT TIME ZONE 'Asia/Karachi')::date)::text AS starts_on,w.ends_on::text
      FROM university_housing_waitlist w JOIN university_people p ON p.organization_id=w.organization_id AND p.id=w.person_id
    WHERE w.organization_id=${ctx.organizationId} AND w.resource_id=${resourceId} AND w.status='WAITING'
      AND EXISTS(SELECT 1 FROM university_student_programs s WHERE s.organization_id=w.organization_id AND s.person_id=w.person_id AND s.status='ACTIVE')
    ORDER BY w.queued_at,w.id FOR UPDATE OF p,w SKIP LOCKED`;
  for (const w of waiting) {
    try {
      const assigned = await allocate(ctx, {
        personId: w.person_id,
        resourceId,
        startsOn: w.starts_on,
        endsOn: w.ends_on,
      });
      await ctx.db
        .$executeRaw`UPDATE university_housing_waitlist SET status='ALLOCATED',allocation_id=${assigned.allocationId}
        WHERE organization_id=${ctx.organizationId} AND id=${w.id}`;
      await emitUniversityEvent(ctx, 'housing.promoted', w.id, {
        personId: w.person_id,
        allocationId: assigned.allocationId,
      });
    } catch (error) {
      if (!(error instanceof AllocationConflict)) throw error;
    }
  }
}
async function joinHousing(ctx: UniversityContext, personId: string, input: Input) {
  const period = dates.parse(input),
    resourceId = text.parse(input.resourceId);
  await requireRegisteredStudent(ctx, personId);
  const [r] = await ctx.db.$queryRaw<
    Id[]
  >`SELECT id FROM university_service_resources WHERE organization_id=${ctx.organizationId} AND id=${resourceId}
    AND kind='HOSTEL' AND ${period.startsOn}::date >= (now() AT TIME ZONE 'Asia/Karachi')::date FOR UPDATE`;
  if (!r) throw new Error('Choose a hostel and current or future dates.');
  const [prior] = await ctx.db.$queryRaw<
    { id: string; status: string }[]
  >`SELECT w.id,w.status FROM university_housing_waitlist w
    LEFT JOIN university_service_allocations a ON a.organization_id=w.organization_id AND a.id=w.allocation_id
    WHERE w.organization_id=${ctx.organizationId} AND w.resource_id=${resourceId} AND w.person_id=${personId}
      AND w.starts_on=${period.startsOn}::date AND w.ends_on=${period.endsOn}::date
      AND (w.status='WAITING' OR (w.status='ALLOCATED' AND a.released_at IS NULL)) LIMIT 1`;
  if (prior) return prior;
  const [row] = await ctx.db.$queryRaw<
    Id[]
  >`INSERT INTO university_housing_waitlist(organization_id,person_id,resource_id,starts_on,ends_on)
    VALUES(${ctx.organizationId},${personId},${resourceId},${period.startsOn}::date,${period.endsOn}::date) RETURNING id`;
  await promoteHousingWaitlist(ctx, resourceId);
  const [result] = await ctx.db.$queryRaw<
    { id: string; status: string }[]
  >`SELECT id,status FROM university_housing_waitlist WHERE organization_id=${ctx.organizationId} AND id=${row.id}`;
  return result;
}
async function leaveHousing(ctx: UniversityContext, personId: string, input: Input) {
  const count = await ctx.db
    .$executeRaw`UPDATE university_housing_waitlist SET status='CANCELLED' WHERE organization_id=${ctx.organizationId}
    AND id=${text.parse(input.waitlistId)} AND person_id=${personId} AND status='WAITING'`;
  if (!count) throw new Error('Choose your pending housing request.');
  return { status: 'CANCELLED' };
}
export async function endStudentCommunityServices(ctx: UniversityContext, personId: string) {
  const [active] = await ctx.db.$queryRaw<
    Id[]
  >`SELECT id FROM university_student_programs WHERE organization_id=${ctx.organizationId} AND person_id=${personId} AND status='ACTIVE' LIMIT 1`;
  if (active) return;
  await ctx.db
    .$executeRaw`UPDATE university_housing_waitlist SET status='CANCELLED' WHERE organization_id=${ctx.organizationId} AND person_id=${personId} AND status='WAITING'`;
  const memberships = await ctx.db.$queryRaw<
    { id: string; fee: string }[]
  >`UPDATE university_dining_memberships m SET cancelled_at=now()
    FROM university_dining_plans p WHERE m.organization_id=${ctx.organizationId} AND m.person_id=${personId} AND m.cancelled_at IS NULL
      AND m.ends_on >= (now() AT TIME ZONE 'Asia/Karachi')::date AND p.organization_id=m.organization_id AND p.id=m.plan_id
    RETURNING m.id,p.fee_paisa::text AS fee`;
  for (const m of memberships)
    await emitUniversityEvent(ctx, 'dining.cancelled', m.id, {
      personId,
      chargeReference: m.fee === '0' ? null : 'DINING-' + m.id,
    });
}

async function createDining(ctx: UniversityContext, input: Input) {
  const data = z
    .object({
      campusId: text,
      name: text,
      meals: z.coerce.number().int().min(1).max(5000),
      feePaisa: paisa,
    })
    .parse(input);
  const [row] = await ctx.db.$queryRaw<
    Id[]
  >`INSERT INTO university_dining_plans(organization_id,campus_id,name,meals,fee_paisa)
    VALUES(${ctx.organizationId},${data.campusId},${data.name},${data.meals},${data.feePaisa}) RETURNING id`;
  return row;
}
async function assignDining(ctx: UniversityContext, input: Input) {
  const plan = text.parse(input.planId),
    person = text.parse(input.personId),
    range = dates.parse(input);
  await requireRegisteredStudent(ctx, person);
  const [row] = await ctx.db.$queryRaw<{ id: string; fee: string }[]>`WITH plan AS (
     SELECT id,meals,fee_paisa FROM university_dining_plans WHERE organization_id=${ctx.organizationId} AND id=${plan}), membership AS (
     INSERT INTO university_dining_memberships(organization_id,person_id,plan_id,starts_on,ends_on,remaining)
       SELECT ${ctx.organizationId},${person},id,${range.startsOn}::date,${range.endsOn}::date,meals FROM plan
       WHERE ${range.endsOn}::date >= (now() AT TIME ZONE 'Asia/Karachi')::date RETURNING id)
     SELECT membership.id,plan.fee_paisa::text AS fee FROM membership CROSS JOIN plan`;
  if (!row) throw new Error('Choose an existing plan with a current or future end date.');
  if (row.fee !== '0')
    await issueStudentCharge(ctx, {
      reference: 'DINING-' + row.id,
      personId: person,
      feeHead: 'OTHER',
      amountPaisa: Number(row.fee),
      commencementDate: range.startsOn,
      dueDate: range.startsOn,
    });
  await emitUniversityEvent(ctx, 'dining.assigned', row.id, { personId: person, planId: plan });
  return row;
}
async function redeemMeal(ctx: UniversityContext, input: Input) {
  const membershipId = text.parse(input.membershipId),
    reference = text.parse(input.reference);
  const [member] = await ctx.db.$queryRaw<{ usable: boolean; remaining: number }[]>`SELECT
    ((now() AT TIME ZONE 'Asia/Karachi')::date BETWEEN starts_on AND ends_on AND cancelled_at IS NULL) AS usable,remaining
    FROM university_dining_memberships WHERE organization_id=${ctx.organizationId} AND id=${membershipId} FOR UPDATE`;
  if (!member) throw new Error('Choose an existing dining membership.');
  const [prior] = await ctx.db.$queryRaw<
    { membership_id: string }[]
  >`SELECT membership_id FROM university_dining_redemptions
    WHERE organization_id=${ctx.organizationId} AND reference=${reference}`;
  if (prior?.membership_id === membershipId) return { reference };
  if (prior || !member.usable || member.remaining < 1)
    throw new Error('The redemption reference or meal entitlement is unavailable.');
  await ctx.db
    .$executeRaw`INSERT INTO university_dining_redemptions(organization_id,reference,membership_id) VALUES(${ctx.organizationId},${reference},${membershipId})`;
  await ctx.db
    .$executeRaw`UPDATE university_dining_memberships SET remaining=remaining-1 WHERE organization_id=${ctx.organizationId} AND id=${membershipId}`;
  return { reference };
}

async function openPrivateCase(
  ctx: UniversityContext,
  personId: string,
  input: Input,
  kind: 'ADVISING' | 'GRIEVANCE'
) {
  await requireRegisteredStudent(ctx, personId);
  const [row] = await ctx.db.$queryRaw<
    Id[]
  >`INSERT INTO university_private_cases(organization_id,person_id,kind,message)
    VALUES(${ctx.organizationId},${personId},${kind},${narrative.parse(input.message)}) RETURNING id`;
  return row;
}
function caseKind(ctx: UniversityContext): 'ADVISING' | 'GRIEVANCE' | null {
  if (ctx.roleKey === 'university-registrar') return 'GRIEVANCE';
  if (ctx.roleKey === 'university-advisor') return 'ADVISING';
  return null;
}
async function privateCases(ctx: UniversityContext): Promise<Rows> {
  const kind = caseKind(ctx);
  if (!kind) return [];
  return ctx.db
    .$queryRaw<Rows>`SELECT c.kind AS record,c.id,c.person_id,c.message,c.status,c.resolution,c.opened_at
    FROM university_private_cases c WHERE c.organization_id=${ctx.organizationId} AND c.kind=${kind}
    AND (c.kind='GRIEVANCE' OR EXISTS(SELECT 1 FROM university_advising_assignments a JOIN university_student_programs s
      ON s.organization_id=a.organization_id AND s.id=a.student_program_id WHERE s.organization_id=c.organization_id
      AND s.person_id=c.person_id AND s.status='ACTIVE' AND a.advisor_id=${ctx.userId} AND a.released_at IS NULL))
    ORDER BY c.opened_at DESC,c.id LIMIT 250`;
}
async function resolvePrivateCase(ctx: UniversityContext, input: Input) {
  const kind = caseKind(ctx);
  if (!kind)
    throw new Error(
      'A designated registrar or assigned academic advisor must handle private cases.'
    );
  const count = await ctx.db
    .$executeRaw`UPDATE university_private_cases c SET status='RESOLVED',resolution=${narrative.parse(input.resolution)},resolved_by=${ctx.userId},resolved_at=now()
    WHERE c.organization_id=${ctx.organizationId} AND c.id=${text.parse(input.caseId)} AND c.status='OPEN' AND c.kind=${kind}
    AND (c.kind='GRIEVANCE' OR EXISTS(SELECT 1 FROM university_advising_assignments a JOIN university_student_programs s
      ON s.organization_id=a.organization_id AND s.id=a.student_program_id WHERE s.organization_id=c.organization_id
      AND s.person_id=c.person_id AND s.status='ACTIVE' AND a.advisor_id=${ctx.userId} AND a.released_at IS NULL))`;
  if (!count) throw new Error('An accessible open case is required.');
  return { status: 'RESOLVED' };
}

async function consent(ctx: UniversityContext, personId: string, input: Input) {
  const optedIn = z.enum(['OPT_IN', 'OPT_OUT']).parse(input.consent) === 'OPT_IN';
  const changed = await ctx.db
    .$executeRaw`INSERT INTO university_alumni_preferences(organization_id,person_id,opted_in)
    SELECT ${ctx.organizationId},${personId},${optedIn} WHERE EXISTS(SELECT 1 FROM university_awards a JOIN university_student_programs s
      ON s.organization_id=a.organization_id AND s.id=a.student_program_id WHERE s.organization_id=${ctx.organizationId} AND s.person_id=${personId})
    ON CONFLICT(organization_id,person_id) DO UPDATE SET opted_in=EXCLUDED.opted_in,changed_at=now()`;
  if (!changed)
    throw new Error('Career opportunities are available to graduates with an issued award.');
  return { optedIn };
}
async function publishOpportunity(ctx: UniversityContext, input: Input) {
  const data = z
    .object({ title: text, employer: text, description: narrative, closesOn: z.iso.date() })
    .parse(input);
  const [row] = await ctx.db.$queryRaw<
    Id[]
  >`INSERT INTO university_career_opportunities(organization_id,title,employer,description,closes_on,posted_by)
    SELECT ${ctx.organizationId},${data.title},${data.employer},${data.description},${data.closesOn}::date,${ctx.userId}
    WHERE ${data.closesOn}::date >= (now() AT TIME ZONE 'Asia/Karachi')::date RETURNING id`;
  if (!row) throw new Error('Choose a current or future application deadline.');
  return row;
}
async function applyOpportunity(ctx: UniversityContext, personId: string, input: Input) {
  const id = text.parse(input.opportunityId);
  const [allowed] = await ctx.db.$queryRaw<
    Id[]
  >`SELECT o.id FROM university_career_opportunities o JOIN university_alumni_preferences p ON p.organization_id=o.organization_id
    WHERE o.organization_id=${ctx.organizationId} AND o.id=${id} AND p.person_id=${personId} AND p.opted_in
    AND o.closes_on >= (now() AT TIME ZONE 'Asia/Karachi')::date FOR SHARE OF p,o`;
  if (!allowed) throw new Error('Opt in to careers and select an open opportunity.');
  await ctx.db
    .$executeRaw`INSERT INTO university_career_applications(organization_id,opportunity_id,person_id)
    VALUES(${ctx.organizationId},${id},${personId}) ON CONFLICT DO NOTHING`;
  return { opportunityId: id, status: 'APPLIED' };
}
async function requestVerification(ctx: UniversityContext, personId: string, input: Input) {
  const awardId = text.parse(input.awardId),
    recipient = z.email().max(254).parse(input.recipient).toLowerCase();
  const [request] = await ctx.db.$queryRaw<
    Id[]
  >`INSERT INTO university_verification_requests(organization_id,person_id,award_id,recipient)
    SELECT a.organization_id,s.person_id,a.id,${recipient} FROM university_awards a JOIN university_student_programs s
    ON s.organization_id=a.organization_id AND s.id=a.student_program_id WHERE s.organization_id=${ctx.organizationId} AND s.person_id=${personId} AND a.id=${awardId}
    ON CONFLICT(organization_id,award_id,recipient) WHERE status='REQUESTED' DO UPDATE SET recipient=EXCLUDED.recipient RETURNING id`;
  if (!request) throw new Error('Choose an award from your own academic record.');
  return request;
}
async function decideVerification(ctx: UniversityContext, input: Input) {
  const id = text.parse(input.requestId),
    decision = z.enum(['VERIFIED', 'DECLINED']).parse(input.decision),
    note = narrative.parse(input.note);
  const verificationId = decision === 'VERIFIED' ? text.parse(input.verificationId) : null;
  if (ctx.roleKey !== 'university-registrar')
    throw new Error('The registrar handles credential verification requests.');
  const [result] = await ctx.db.$queryRaw<
    Id[]
  >`UPDATE university_verification_requests r SET status=${decision},verified_by=${ctx.userId},decision_note=${note},verification_id=${verificationId}
    WHERE r.organization_id=${ctx.organizationId} AND r.id=${id} AND r.status='REQUESTED'
    AND (${decision}='DECLINED' OR EXISTS(SELECT 1 FROM university_award_verifications v WHERE v.organization_id=r.organization_id
      AND v.id=${verificationId} AND v.award_id=r.award_id AND v.outcome='VERIFIED')) RETURNING id`;
  if (!result)
    throw new Error('Select a pending request and the official verification for the same award.');
  await emitUniversityEvent(ctx, 'credential.request-decided', id, { requestId: id, decision });
  return { id, status: decision };
}

function requireSubject(ctx: UniversityContext, personId: string) {
  if (ctx.admin || ctx.roleKey !== 'university-learner' || ctx.userId !== personId)
    throw new Error('An authenticated learner session for this person is required.');
}
export async function readLearnerCommunity(ctx: UniversityContext, personId: string) {
  requireSubject(ctx, personId);
  const org = ctx.organizationId;
  const hostels = await ctx.db
    .$queryRaw<Rows>`SELECT id,label,campus_id,capacity,fee_paisa::text AS allocation_fee_paisa FROM university_service_resources
    WHERE organization_id=${org} AND kind='HOSTEL' ORDER BY label,id LIMIT 250`;
  const housing = await ctx.db
    .$queryRaw<Rows>`SELECT w.id,r.label,w.status,w.starts_on::text,w.ends_on::text,w.allocation_id
    FROM university_housing_waitlist w JOIN university_service_resources r ON r.organization_id=w.organization_id AND r.id=w.resource_id
    WHERE w.organization_id=${org} AND w.person_id=${personId} ORDER BY w.queued_at DESC,w.id LIMIT 100`;
  const allocations = await ctx.db
    .$queryRaw<Rows>`SELECT a.id,r.kind,r.label,a.starts_on::text,a.ends_on::text,a.charge_reference,
      CASE WHEN a.released_at IS NOT NULL THEN 'RELEASED' WHEN a.ends_on<(now() AT TIME ZONE 'Asia/Karachi')::date THEN 'EXPIRED' ELSE 'ALLOCATED' END AS status
    FROM university_service_allocations a JOIN university_service_resources r ON r.organization_id=a.organization_id AND r.id=a.resource_id
    WHERE a.organization_id=${org} AND a.person_id=${personId} ORDER BY a.starts_on DESC,a.id LIMIT 150`;
  const libraryLoans = await ctx.db.$queryRaw<Rows>`SELECT id,title,barcode,due_on::text,
    CASE WHEN returned_at IS NOT NULL THEN 'RETURNED' WHEN due_on<(now() AT TIME ZONE 'Asia/Karachi')::date THEN 'OVERDUE' ELSE 'BORROWED' END AS status
    FROM university_library_loans WHERE organization_id=${org} AND person_id=${personId} ORDER BY borrowed_at DESC,id LIMIT 150`;
  const dining = await ctx.db
    .$queryRaw<Rows>`SELECT m.id,p.name,m.starts_on::text,m.ends_on::text,m.remaining,m.cancelled_at IS NOT NULL AS cancelled
    FROM university_dining_memberships m JOIN university_dining_plans p ON p.organization_id=m.organization_id AND p.id=m.plan_id
    WHERE m.organization_id=${org} AND m.person_id=${personId} ORDER BY m.starts_on DESC,m.id LIMIT 100`;
  const cases = await ctx.db
    .$queryRaw<Rows>`SELECT id,kind,message,status,resolution FROM university_private_cases
    WHERE organization_id=${org} AND person_id=${personId} ORDER BY opened_at DESC,id LIMIT 100`;
  const [pref] = await ctx.db.$queryRaw<
    { opted_in: boolean }[]
  >`SELECT opted_in FROM university_alumni_preferences WHERE organization_id=${org} AND person_id=${personId}`;
  const opportunities = pref?.opted_in
    ? await ctx.db
        .$queryRaw<Rows>`SELECT o.id,o.title,o.employer,o.description,o.closes_on::text,a.applied_at IS NOT NULL AS applied
    FROM university_career_opportunities o LEFT JOIN university_career_applications a ON a.organization_id=o.organization_id AND a.opportunity_id=o.id AND a.person_id=${personId}
    WHERE o.organization_id=${org} AND (o.closes_on >= (now() AT TIME ZONE 'Asia/Karachi')::date OR a.applied_at IS NOT NULL)
    ORDER BY o.closes_on DESC,o.id LIMIT 150`
    : [];
  const awards = await ctx.db
    .$queryRaw<Rows>`SELECT a.id,a.credential_number FROM university_awards a JOIN university_student_programs s
    ON s.organization_id=a.organization_id AND s.id=a.student_program_id WHERE s.organization_id=${org} AND s.person_id=${personId} ORDER BY a.id`;
  const verifications = await ctx.db
    .$queryRaw<Rows>`SELECT id,award_id,recipient,status,decision_note FROM university_verification_requests
    WHERE organization_id=${org} AND person_id=${personId} ORDER BY requested_at DESC,id LIMIT 100`;
  return {
    hostels,
    housing,
    allocations,
    libraryLoans,
    dining,
    cases,
    alumniOptedIn: pref?.opted_in ?? false,
    opportunities,
    awards,
    verifications,
  };
}
function field(
  name: string,
  label: string,
  type: UniversityField['type'] = 'text',
  required = true
): UniversityField {
  return { name, label, type, required };
}
function choose(name: string, label: string, options: string[]): UniversityField {
  return { name, label, type: 'select', required: true, options };
}
const periodFields = [field('startsOn', 'Start date', 'date'), field('endsOn', 'End date', 'date')];
export const learnerCommunityActions = [
  {
    key: 'housing-waitlist',
    label: 'Request hostel place and accept the listed fee on allocation',
    fields: [field('resourceId', 'Hostel ID'), ...periodFields],
  },
  {
    key: 'leave-waitlist',
    label: 'Leave housing waitlist',
    fields: [field('waitlistId', 'Waitlist request ID')],
  },
  {
    key: 'open-advising',
    label: 'Request private academic advising',
    fields: [field('message', 'Message for your advisor', 'textarea')],
  },
  {
    key: 'open-grievance',
    label: 'Submit confidential grievance',
    fields: [field('message', 'Message for the registrar', 'textarea')],
  },
  {
    key: 'alumni-consent',
    label: 'Update alumni careers consent',
    fields: [choose('consent', 'Careers opt-in', ['OPT_IN', 'OPT_OUT'])],
  },
  {
    key: 'apply-opportunity',
    label: 'Apply for alumni opportunity',
    fields: [field('opportunityId', 'Opportunity ID')],
  },
  {
    key: 'request-verification',
    label: 'Authorize credential verification for a recipient',
    fields: [field('awardId', 'Award ID'), field('recipient', 'Recipient email')],
  },
];
export async function runLearnerCommunityAction(
  ctx: UniversityContext,
  personId: string,
  action: string,
  input: Input
) {
  requireSubject(ctx, personId);
  switch (action) {
    case 'housing-waitlist':
      return joinHousing(ctx, personId, input);
    case 'leave-waitlist':
      return leaveHousing(ctx, personId, input);
    case 'open-advising':
      return openPrivateCase(ctx, personId, input, 'ADVISING');
    case 'open-grievance':
      return openPrivateCase(ctx, personId, input, 'GRIEVANCE');
    case 'alumni-consent':
      return consent(ctx, personId, input);
    case 'apply-opportunity':
      return applyOpportunity(ctx, personId, input);
    case 'request-verification':
      return requestVerification(ctx, personId, input);
    default:
      throw new Error('Unknown learner community request.');
  }
}
async function communityRecords(ctx: UniversityContext): Promise<Rows> {
  const records: Rows = await privateCases(ctx);
  if (officeRoleAllowed(ctx, serviceRoles)) {
    records.push(
      ...(await ctx.db
        .$queryRaw<Rows>`SELECT 'Housing waitlist' AS record,w.id,r.label AS description,w.person_id AS related,w.status
      FROM university_housing_waitlist w JOIN university_service_resources r ON r.organization_id=w.organization_id AND r.id=w.resource_id WHERE w.organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Dining plan',id,name,campus_id,meals::text||' meals' FROM university_dining_plans WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Dining membership',m.id,p.name,m.person_id,m.remaining::text||' remaining' FROM university_dining_memberships m JOIN university_dining_plans p
        ON p.organization_id=m.organization_id AND p.id=m.plan_id WHERE m.organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Career opportunity',id,title,employer,closes_on::text FROM university_career_opportunities WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Career application',a.opportunity_id,o.title,a.person_id,'APPLIED' FROM university_career_applications a JOIN university_alumni_preferences p
        ON p.organization_id=a.organization_id AND p.person_id=a.person_id JOIN university_career_opportunities o ON o.organization_id=a.organization_id AND o.id=a.opportunity_id
        WHERE a.organization_id=${ctx.organizationId} AND p.opted_in ORDER BY record,description,id LIMIT 400`)
    );
  }
  if (ctx.roleKey === 'university-registrar')
    records.push(
      ...(await ctx.db
        .$queryRaw<Rows>`SELECT 'Credential verification' AS record,id,person_id,award_id,recipient,status
    FROM university_verification_requests WHERE organization_id=${ctx.organizationId} ORDER BY requested_at DESC,id LIMIT 150`)
    );
  return records;
}
export const communityOffice: UniversityOffice = {
  title: 'Student and alumni services',
  description:
    'Manage housing waitlists, meal entitlements, private student cases and graduate services.',
  moduleKey: 'university-services',
  roles: [...serviceRoles, ...registrarRoles, ...advisorRoles],
  read: communityRecords,
  actions: [
    {
      key: 'promote-housing',
      label: 'Process housing waitlist',
      roles: serviceRoles,
      fields: [field('resourceId', 'Hostel resource ID')],
      run: async (ctx, i) => {
        await promoteHousingWaitlist(ctx, text.parse(i.resourceId));
        return { processed: true };
      },
    },
    {
      key: 'create-dining',
      label: 'Create meal plan',
      roles: serviceRoles,
      fields: [
        field('campusId', 'Campus ID'),
        field('name', 'Plan name'),
        field('meals', 'Meal credits', 'number'),
        field('feePaisa', 'Plan fee in paisa', 'number'),
      ],
      run: createDining,
    },
    {
      key: 'assign-dining',
      label: 'Assign meal plan',
      roles: serviceRoles,
      fields: [
        field('personId', 'Student person ID'),
        field('planId', 'Meal plan ID'),
        ...periodFields,
      ],
      run: assignDining,
    },
    {
      key: 'redeem-meal',
      label: 'Redeem meal credit',
      roles: serviceRoles,
      fields: [
        field('membershipId', 'Dining membership ID'),
        field('reference', 'Unique transaction reference'),
      ],
      run: redeemMeal,
    },
    {
      key: 'resolve-case',
      strictRoles: true,
      label: 'Respond to private student case',
      roles: [...registrarRoles, ...advisorRoles],
      fields: [
        field('caseId', 'Case ID'),
        field('resolution', 'Response visible to the student', 'textarea'),
      ],
      run: resolvePrivateCase,
    },
    {
      key: 'career-opportunity',
      institutionWide: true,
      label: 'Publish alumni career opportunity',
      roles: serviceRoles,
      fields: [
        field('title', 'Title'),
        field('employer', 'Employer'),
        field('description', 'Opportunity', 'textarea'),
        field('closesOn', 'Deadline', 'date'),
      ],
      run: publishOpportunity,
    },
    {
      key: 'decide-verification',
      strictRoles: true,
      label: 'Resolve credential request',
      roles: registrarRoles,
      fields: [
        field('requestId', 'Request ID'),
        choose('decision', 'Decision', ['VERIFIED', 'DECLINED']),
        field(
          'verificationId',
          'Official university verification ID (required when verified)',
          'text',
          false
        ),
        field('note', 'Reply to graduate', 'textarea'),
      ],
      run: decideVerification,
    },
  ],
};

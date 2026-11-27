import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  officeRoleAllowed,
  type UniversityAction,
  type UniversityContext,
  type UniversityOffice,
} from './office-types';

const researchRoles = ['university-research-officer', 'university-registrar'];
const examinationRoles = ['university-examinations-officer', 'university-registrar'];
const roles = [...new Set([...researchRoles, ...examinationRoles])];
const value = z.string().trim().min(1).max(250);
const textValue = z.string().trim().min(1).max(2500);
const date = z.iso.date();

export const researchTransitions = {
  PROPOSAL_ACCEPTED: ['PROPOSAL', 'ETHICS_REVIEW'],
  PROPOSAL_RETURNED: ['ETHICS_REVIEW', 'PROPOSAL'],
  ETHICS_APPROVED: ['ETHICS_REVIEW', 'RESEARCH'],
  ETHICS_EXEMPT: ['ETHICS_REVIEW', 'RESEARCH'],
  PROGRESS_REVIEWED: ['RESEARCH', 'RESEARCH'],
  THESIS_SUBMITTED: ['RESEARCH', 'EXAMINATION'],
  CORRECTIONS_REQUIRED: ['EXAMINATION', 'CORRECTIONS'],
  THESIS_RESUBMITTED: ['CORRECTIONS', 'EXAMINATION'],
  DEFENSE_SCHEDULED: ['EXAMINATION', 'DEFENSE'],
  DEFENSE_REVISIONS: ['DEFENSE', 'CORRECTIONS'],
  DEFENSE_PASSED: ['DEFENSE', 'COMPLETE'],
} as const;
const decisionKeys = Object.keys(researchTransitions) as (keyof typeof researchTransitions)[];
const examDecisions = [
  'CORRECTIONS_REQUIRED',
  'DEFENSE_SCHEDULED',
  'DEFENSE_REVISIONS',
  'DEFENSE_PASSED',
];

export function parseGrantBudget(pkr: string) {
  const parsed = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(pkr.trim());
  if (!parsed) throw new Error('Enter a positive PKR amount with up to two decimal places.');
  const minor = BigInt(parsed[1]) * BigInt(100) + BigInt((parsed[2] ?? '').padEnd(2, '0'));
  if (minor <= BigInt(0)) throw new Error('The award budget must be greater than zero.');
  return minor.toString();
}

function required(name: string, label: string, type: 'text' | 'textarea' | 'date' = 'text') {
  return { name, label, type, required: true };
}

async function newCase(ctx: UniversityContext, input: Record<string, string>) {
  const data = z
    .object({ studentProgramId: value, title: textValue, supervisorId: value })
    .parse(input);
  const [record] = await ctx.db.$queryRaw<{ id: string }[]>`
    INSERT INTO university_research_cases (organization_id,student_program_id,title,supervisor_id,created_by)
    SELECT sp.organization_id, sp.id, ${data.title}, supervisor.id, ${ctx.userId}
    FROM university_student_programs sp JOIN university_intakes i ON (i.organization_id,i.id)=(sp.organization_id,sp.intake_id) AND i.research_required
    JOIN users supervisor ON supervisor."organizationId"=sp.organization_id
    WHERE sp.organization_id=${ctx.organizationId} AND sp.id=${data.studentProgramId} AND sp.status='ACTIVE'
      AND supervisor.id=${data.supervisorId} AND supervisor.status='ACTIVE'
    ON CONFLICT (organization_id,student_program_id) DO NOTHING RETURNING id`;
  if (!record)
    throw new Error(
      'Choose an active program enrollment and supervisor without an existing thesis case.'
    );
  return record;
}

async function recordDecision(ctx: UniversityContext, input: Record<string, string>) {
  const data = z
    .object({ caseId: value, decision: z.enum(decisionKeys), evidence: textValue })
    .parse(input);
  const allowed = examDecisions.includes(data.decision) ? examinationRoles : researchRoles;
  if (!officeRoleAllowed(ctx, allowed))
    throw new Error('This decision requires the responsible office.');
  const [prior, next] = researchTransitions[data.decision];
  const [candidate] = await ctx.db.$queryRaw<{ status: string }[]>`
    SELECT status FROM university_research_cases WHERE organization_id=${ctx.organizationId} AND id=${data.caseId} FOR UPDATE`;
  if (!candidate) throw new Error('Research case was not found.');
  const [duplicate] = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT id FROM university_research_decisions WHERE organization_id=${ctx.organizationId} AND case_id=${data.caseId}
      AND kind=${data.decision} AND evidence_reference=${data.evidence}`;
  if (duplicate) return duplicate;
  if (candidate.status !== prior)
    throw new Error('This decision is unavailable at the current research stage.');
  const [decision] = await ctx.db.$queryRaw<{ id: string }[]>`
    INSERT INTO university_research_decisions
      (organization_id,case_id,kind,prior_status,next_status,evidence_reference,recorded_by)
    VALUES (${ctx.organizationId},${data.caseId},${data.decision},${prior},${next},${data.evidence},${ctx.userId}) RETURNING id`;
  await ctx.db.$executeRaw`UPDATE university_research_cases SET status=${next}
    WHERE organization_id=${ctx.organizationId} AND id=${data.caseId}`;
  return decision;
}

async function changeSupervisor(ctx: UniversityContext, input: Record<string, string>) {
  const data = z.object({ caseId: value, supervisorId: value, evidence: textValue }).parse(input);
  const [candidate] = await ctx.db.$queryRaw<
    { status: string; supervisor_id: string }[]
  >`SELECT status,supervisor_id FROM university_research_cases
    WHERE organization_id=${ctx.organizationId} AND id=${data.caseId} FOR UPDATE`;
  if (!candidate || candidate.status === 'COMPLETE')
    throw new Error('Choose a continuing research case.');
  const [decision] = await ctx.db.$queryRaw<
    { id: string }[]
  >`INSERT INTO university_research_decisions
    (organization_id,case_id,kind,prior_status,next_status,evidence_reference,recorded_by)
    SELECT u."organizationId",${data.caseId},'SUPERVISOR_CHANGED',${candidate.status},${candidate.status},${data.evidence},${ctx.userId}
    FROM users u WHERE u."organizationId"=${ctx.organizationId} AND u.id=${data.supervisorId} AND u.status='ACTIVE' AND u.id<>${candidate.supervisor_id}
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!decision)
    throw new Error('Provide a different active supervisor and a new approval reference.');
  await ctx.db.$executeRaw`UPDATE university_research_cases SET supervisor_id=${data.supervisorId}
    WHERE organization_id=${ctx.organizationId} AND id=${data.caseId}`;
  return decision;
}

async function registerGrant(ctx: UniversityContext, input: Record<string, string>) {
  const data = z
    .object({
      code: value,
      sponsor: value,
      title: value,
      startsOn: date,
      endsOn: date,
      restrictions: textValue,
      budgetPkr: value,
      categories: z.string().max(1000).optional(),
    })
    .parse(input);
  if (data.endsOn < data.startsOn) throw new Error('The award ends before it starts.');
  const categories = [
    ...new Set(
      (data.categories ?? '')
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
  const minor = parseGrantBudget(data.budgetPkr);
  const [grant] = await ctx.db.$queryRaw<{ id: string }[]>`
    INSERT INTO university_research_grants (organization_id,code,sponsor,title,budget_minor,starts_on,ends_on,restrictions,allowed_categories,created_by)
    VALUES (${ctx.organizationId},${data.code},${data.sponsor},${data.title},${minor}::bigint,${data.startsOn}::date,
      ${data.endsOn}::date,${data.restrictions},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(categories)}::jsonb)),${ctx.userId})
    ON CONFLICT (organization_id,code) DO NOTHING RETURNING id`;
  if (!grant) throw new Error('This sponsor award code is already registered.');
  return grant;
}

async function lockActiveAward(ctx: UniversityContext, id: string) {
  const [award] = await ctx.db.$queryRaw<{ id: string }[]>`SELECT id FROM university_research_grants
    WHERE organization_id=${ctx.organizationId} AND id=${id} AND status='ACTIVE' FOR UPDATE`;
  if (!award) throw new Error('An active sponsor award is required.');
}
async function closeGrant(ctx: UniversityContext, input: Record<string, string>) {
  const data = z.object({ grantId: value, reference: value }).parse(input);
  await lockActiveAward(ctx, data.grantId);
  const count = await ctx.db
    .$executeRaw`UPDATE university_research_grants g SET status='CLOSED',closed_by=${ctx.userId},closed_at=now(),closure_reference=${data.reference}
    WHERE g.organization_id=${ctx.organizationId} AND g.id=${data.grantId} AND NOT EXISTS(
      SELECT 1 FROM university_grant_deliverables d WHERE (d.organization_id,d.grant_id)=(g.organization_id,g.id) AND d.receipt IS NULL)
    AND NOT EXISTS(SELECT 1 FROM university_procurement_requests p WHERE (p.organization_id,p.grant_id)=(g.organization_id,g.id) AND p.status IN ('REQUESTED','APPROVED'))`;
  if (!count)
    throw new Error(
      'Reconcile open purchase commitments and sponsor deliverables before closing the award.'
    );
  return { id: data.grantId, status: 'CLOSED' };
}
async function scheduleDeliverable(ctx: UniversityContext, input: Record<string, string>) {
  const data = z.object({ grantId: value, title: value, dueOn: date }).parse(input);
  await lockActiveAward(ctx, data.grantId);
  const [row] = await ctx.db.$queryRaw<{ id: string }[]>`
    INSERT INTO university_grant_deliverables (organization_id,grant_id,title,due_on)
    SELECT organization_id,id,${data.title},${data.dueOn}::date FROM university_research_grants
     WHERE organization_id=${ctx.organizationId} AND id=${data.grantId} AND status='ACTIVE'
    ON CONFLICT (organization_id,grant_id,title,due_on) DO NOTHING RETURNING id`;
  if (!row) throw new Error('Select an active award and a new deliverable.');
  return row;
}

async function acceptDeliverable(ctx: UniversityContext, input: Record<string, string>) {
  const data = z.object({ id: value, receipt: value }).parse(input);
  const count = await ctx.db.$executeRaw`UPDATE university_grant_deliverables
    SET receipt=${data.receipt}, accepted_by=${ctx.userId}, accepted_at=now()
    WHERE organization_id=${ctx.organizationId} AND id=${data.id} AND receipt IS NULL`;
  if (!count) throw new Error('Choose a pending deliverable.');
  return { id: data.id };
}

async function verifyUniversityAward(ctx: UniversityContext, input: Record<string, string>) {
  const data = z
    .object({
      credential: value,
      request: value,
      outcome: z.enum(['VERIFIED', 'DISCREPANCY']),
      evidence: textValue,
    })
    .parse(input);
  const [verification] = await ctx.db.$queryRaw<{ id: string }[]>`
    INSERT INTO university_award_verifications (organization_id,award_id,request_reference,outcome,university_evidence,decided_by)
    SELECT organization_id,id,${data.request},${data.outcome},${data.evidence},${ctx.userId} FROM university_awards
    WHERE organization_id=${ctx.organizationId} AND credential_number=${data.credential}
    ON CONFLICT (organization_id,request_reference) DO NOTHING RETURNING id`;
  if (!verification)
    throw new Error('Choose an issued award and a new verification request reference.');
  return verification;
}

async function recordHecIssuance(ctx: UniversityContext, input: Record<string, string>) {
  const data = z
    .object({ verificationId: value, hecReference: value, issuedOn: date })
    .parse(input);
  const [attestation] = await ctx.db.$queryRaw<{ id: string }[]>`
    INSERT INTO university_hec_attestations (organization_id,verification_id,hec_reference,issued_on,recorded_by)
    SELECT v.organization_id,v.id,${data.hecReference},${data.issuedOn}::date,${ctx.userId} FROM university_award_verifications v
    JOIN university_awards a ON (a.organization_id,a.id)=(v.organization_id,v.award_id)
    WHERE v.organization_id=${ctx.organizationId} AND v.id=${data.verificationId} AND v.outcome='VERIFIED'
      AND ${data.issuedOn}::date >= (a.issued_at AT TIME ZONE 'Asia/Karachi')::date
      AND ${data.issuedOn}::date <= (now() AT TIME ZONE 'Asia/Karachi')::date
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!attestation)
    throw new Error(
      'An unrecorded, externally issued HEC decision and a verified award are required.'
    );
  return attestation;
}

export async function readLearnerResearch(db: ScopedDb, org: string, personId: string) {
  const projects = await db.$queryRaw<
    Record<string, unknown>[]
  >`SELECT c.id,c.title,c.status,u.name AS supervisor
    FROM university_research_cases c JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(c.organization_id,c.student_program_id)
    JOIN users u ON (u."organizationId",u.id)=(c.organization_id,c.supervisor_id) WHERE c.organization_id=${org} AND sp.person_id=${personId}
    ORDER BY c.created_at DESC`;
  const milestones = await db.$queryRaw<
    Record<string, unknown>[]
  >`SELECT c.title,d.kind,d.next_status,d.recorded_at FROM university_research_decisions d
    JOIN university_research_cases c ON (c.organization_id,c.id)=(d.organization_id,d.case_id)
    JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(c.organization_id,c.student_program_id)
    WHERE d.organization_id=${org} AND sp.person_id=${personId} ORDER BY d.recorded_at DESC,d.id LIMIT 100`;
  const verifications = await db.$queryRaw<
    Record<string, unknown>[]
  >`SELECT a.credential_number,v.outcome AS university_outcome,v.decided_at,
    h.hec_reference,h.issued_on::text AS hec_issued_on FROM university_award_verifications v JOIN university_awards a ON (a.organization_id,a.id)=(v.organization_id,v.award_id)
    JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(a.organization_id,a.student_program_id)
    LEFT JOIN university_hec_attestations h ON (h.organization_id,h.verification_id)=(v.organization_id,v.id)
    WHERE v.organization_id=${org} AND sp.person_id=${personId} ORDER BY v.decided_at DESC LIMIT 100`;
  return { projects, milestones, verifications };
}

async function read(ctx: UniversityContext) {
  const records: Record<string, unknown>[] = [];
  if (officeRoleAllowed(ctx, researchRoles) || officeRoleAllowed(ctx, examinationRoles)) {
    const cases = await ctx.db.$queryRaw<Record<string, unknown>[]>`
      SELECT 'Thesis' AS record,c.id,c.title,c.status,supervisor.name AS supervisor,
        (SELECT d.kind FROM university_research_decisions d WHERE d.organization_id=c.organization_id AND d.case_id=c.id
          ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1) AS last_decision
      FROM university_research_cases c JOIN users supervisor ON supervisor."organizationId"=c.organization_id AND supervisor.id=c.supervisor_id
      WHERE c.organization_id=${ctx.organizationId} ORDER BY c.created_at DESC,c.id LIMIT 100`;
    records.push(...cases);
    records.push(
      ...(await ctx.db.$queryRaw<Record<string, unknown>[]>`
      SELECT 'Research decision' AS record,d.id,d.case_id,d.kind,d.prior_status,d.next_status,d.evidence_reference,d.recorded_at
      FROM university_research_decisions d WHERE d.organization_id=${ctx.organizationId}
      ORDER BY d.recorded_at DESC,d.id LIMIT 100`)
    );
  }
  if (officeRoleAllowed(ctx, researchRoles)) {
    records.push(
      ...(await ctx.db.$queryRaw<Record<string, unknown>[]>`
      SELECT 'Grant' AS record,g.id,g.title,g.code,g.sponsor,g.status,g.budget_minor::text,g.restrictions,g.allowed_categories,
        g.starts_on::text,g.ends_on::text,ex.committed_minor,ex.spent_minor FROM university_research_grants g
        LEFT JOIN LATERAL(SELECT coalesce(sum(pr.amount_paisa) FILTER(WHERE pr.status='APPROVED'),0)::text AS committed_minor,
          coalesce(sum(pr.amount_paisa) FILTER(WHERE pr.status='RECEIVED'),0)::text AS spent_minor FROM university_procurement_requests pr
          WHERE (pr.organization_id,pr.grant_id)=(g.organization_id,g.id)) ex ON true WHERE g.organization_id=${ctx.organizationId}
      ORDER BY ends_on,id LIMIT 100`)
    );
    records.push(
      ...(await ctx.db.$queryRaw<Record<string, unknown>[]>`
      SELECT 'Sponsor deliverable' AS record,id,grant_id,title,due_on::text,receipt FROM university_grant_deliverables
      WHERE organization_id=${ctx.organizationId} ORDER BY (receipt IS NULL) DESC,due_on,id LIMIT 100`)
    );
  }
  if (officeRoleAllowed(ctx, examinationRoles)) {
    records.push(
      ...(await ctx.db.$queryRaw<Record<string, unknown>[]>`
      SELECT 'Award verification' AS record,v.id,a.credential_number,v.outcome,v.request_reference,
        h.hec_reference,h.issued_on::text AS hec_issued_on FROM university_award_verifications v
      JOIN university_awards a ON (a.organization_id,a.id)=(v.organization_id,v.award_id)
      LEFT JOIN university_hec_attestations h ON (h.organization_id,h.verification_id)=(v.organization_id,v.id)
      WHERE v.organization_id=${ctx.organizationId} ORDER BY v.decided_at DESC,v.id LIMIT 100`)
    );
  }
  return records;
}

const actions: UniversityAction[] = [
  {
    key: 'change-supervisor',
    label: 'Record approved supervisor change',
    roles: researchRoles,
    run: changeSupervisor,
    fields: [
      required('caseId', 'Thesis case ID'),
      required('supervisorId', 'New supervisor staff ID'),
      required('evidence', 'Appointment or committee reference'),
    ],
  },
  {
    key: 'close-grant',
    label: 'Close sponsored award',
    roles: researchRoles,
    run: closeGrant,
    fields: [required('grantId', 'Award ID'), required('reference', 'Sponsor closeout reference')],
  },

  {
    key: 'open-case',
    label: 'Open thesis case',
    roles: researchRoles,
    run: newCase,
    fields: [
      required('studentProgramId', 'Program enrollment ID'),
      required('title', 'Research title'),
      required('supervisorId', 'Supervisor staff ID'),
    ],
  },
  {
    key: 'record-decision',
    label: 'Record research decision',
    roles,
    run: recordDecision,
    fields: [
      required('caseId', 'Thesis case ID'),
      {
        name: 'decision',
        label: 'Decision',
        type: 'select',
        required: true,
        options: decisionKeys,
      },
      required('evidence', 'Signed decision or examination record reference'),
    ],
  },
  {
    key: 'register-grant',
    label: 'Register sponsored award',
    roles: researchRoles,
    run: registerGrant,
    fields: [
      required('code', 'Award code'),
      required('sponsor', 'Sponsor'),
      required('title', 'Award title'),
      required('budgetPkr', 'Approved budget in PKR'),
      required('startsOn', 'Start date', 'date'),
      required('endsOn', 'End date', 'date'),
      required('restrictions', 'Sponsor terms', 'textarea'),
      {
        name: 'categories',
        label: 'Permitted spending categories, comma separated (blank allows all)',
      },
    ],
  },
  {
    key: 'schedule-deliverable',
    label: 'Schedule sponsor deliverable',
    roles: researchRoles,
    run: scheduleDeliverable,
    fields: [
      required('grantId', 'Award ID'),
      required('title', 'Deliverable title'),
      required('dueOn', 'Due date', 'date'),
    ],
  },
  {
    key: 'accept-deliverable',
    label: 'Record sponsor acceptance',
    roles: researchRoles,
    run: acceptDeliverable,
    fields: [
      required('id', 'Deliverable ID'),
      required('receipt', 'Sponsor acknowledgment reference'),
    ],
  },
  {
    key: 'verify-award',
    label: 'Record university verification',
    roles: examinationRoles,
    run: verifyUniversityAward,
    fields: [
      required('credential', 'University credential number'),
      required('request', 'Verification request reference'),
      {
        name: 'outcome',
        label: 'University decision',
        type: 'select',
        required: true,
        options: ['VERIFIED', 'DISCREPANCY'],
      },
      required('evidence', 'Evidence reference'),
    ],
  },
  {
    key: 'record-hec',
    label: 'Record externally issued HEC e-attestation',
    roles: examinationRoles,
    run: recordHecIssuance,
    fields: [
      required('verificationId', 'Verified university decision ID'),
      required('hecReference', 'HEC e-attestation reference'),
      required('issuedOn', 'HEC issue date', 'date'),
    ],
  },
];

export const researchOffice: UniversityOffice = {
  title: 'Research and awards',
  description: 'Manage thesis decisions, sponsor requirements and official award verifications.',
  moduleKey: 'university-research',
  roles,
  actions,
  read,
};

import { emitUniversityEvent } from './events';
import { issueStudentCharge } from './finance';
import {
  officeRoleAllowed,
  type UniversityContext,
  type UniversityField,
  type UniversityOffice,
} from './office-types';

type Input = Record<string, string>;
type Row = Record<string, unknown>;
type IdRow = { id: string };
const campusRoles = ['university-services-officer'];
const registryRoles = ['university-registrar'];
const financeRoles = ['university-bursar', 'university-finance-approver'];
const purchaseRoles = [...campusRoles, 'university-research-officer', ...financeRoles];
const allRoles = [...new Set([...campusRoles, ...registryRoles, ...purchaseRoles])];

function value(input: Input, key: string, limit = 160): string {
  const text = input[key]?.trim();
  if (!text || text.length > limit)
    throw new Error(`Enter a valid ${key} (maximum ${limit} characters).`);
  return text;
}
function integer(input: Input, key: string, minimum: number, maximum: number): number {
  const text = value(input, key);
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < minimum || n > maximum) {
    throw new Error(`${key} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return n;
}
function date(input: Input, key: string): string {
  const text = value(input, key);
  const parsed = new Date(text + 'T00:00:00Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`Enter a valid ISO date for ${key}.`);
  }
  return text;
}
function period(input: Input) {
  const startsOn = date(input, 'startsOn'),
    endsOn = date(input, 'endsOn');
  if (endsOn < startsOn) throw new Error('End date must be on or after start date.');
  return { startsOn, endsOn };
}

async function lockPerson(ctx: UniversityContext, personId: string) {
  const rows = await ctx.db.$queryRaw<IdRow[]>`SELECT id FROM university_people
    WHERE organization_id=${ctx.organizationId} AND id=${personId} FOR UPDATE`;
  if (!rows.length) throw new Error('This person does not exist in the university.');
}
export async function requireRegisteredStudent(ctx: UniversityContext, personId: string) {
  await lockPerson(ctx, personId);
  const rows = await ctx.db.$queryRaw<IdRow[]>`SELECT id FROM university_student_programs
    WHERE organization_id=${ctx.organizationId} AND person_id=${personId} AND status='ACTIVE' LIMIT 1`;
  if (!rows.length) throw new Error('This service requires an active student registration.');
}

async function createResource(ctx: UniversityContext, input: Input) {
  const kind = value(input, 'kind'),
    code = value(input, 'code'),
    campusId = value(input, 'campusId');
  const capacity = integer(input, 'capacity', 1, 100000),
    fee = integer(input, 'feePaisa', 0, 2000000000);
  if (!['HOSTEL', 'TRANSPORT', 'ROOM'].includes(kind))
    throw new Error('Choose a campus resource type.');
  const [row] = await ctx.db.$queryRaw<IdRow[]>`INSERT INTO university_service_resources
    (organization_id,campus_id,kind,code,label,capacity,fee_paisa)
    VALUES(${ctx.organizationId},${campusId},${kind},${code},${value(input, 'label')},${capacity},${fee})
    RETURNING id`;
  return row;
}

export class AllocationConflict extends Error {}
export async function allocate(ctx: UniversityContext, input: Input) {
  const resourceId = value(input, 'resourceId'),
    personId = value(input, 'personId'),
    { startsOn, endsOn } = period(input);
  await requireRegisteredStudent(ctx, personId);
  const [resource] = await ctx.db.$queryRaw<
    { kind: 'HOSTEL' | 'TRANSPORT' | 'ROOM'; fee: number; capacity: number; permissible: boolean }[]
  >`
    SELECT kind,fee_paisa::integer AS fee,capacity,${startsOn}::date >= (now() AT TIME ZONE 'Asia/Karachi')::date AS permissible
    FROM university_service_resources WHERE organization_id=${ctx.organizationId} AND id=${resourceId} FOR UPDATE`;
  if (!resource || !resource.permissible)
    throw new Error('Choose an existing resource and a current or future allocation period.');
  const duplicates = await ctx.db.$queryRaw<
    IdRow[]
  >`SELECT a.id FROM university_service_allocations a
    JOIN university_service_resources r USING(organization_id)
    WHERE a.organization_id=${ctx.organizationId} AND a.resource_id=r.id AND a.person_id=${personId}
      AND r.kind=${resource.kind} AND a.released_at IS NULL AND a.starts_on<=${endsOn}::date AND a.ends_on>=${startsOn}::date LIMIT 1`;
  if (duplicates.length)
    throw new AllocationConflict(
      'This student already has a resource of this type during the requested dates.'
    );

  // Occupancy can rise only at the start of an existing reservation. Counting every
  // reservation intersecting the requested period would reject disjoint bookings.
  const [occupancy] = await ctx.db.$queryRaw<{ peak: number }[]>`WITH active AS (
    SELECT starts_on,ends_on FROM university_service_allocations WHERE organization_id=${ctx.organizationId}
      AND resource_id=${resourceId} AND released_at IS NULL AND starts_on<=${endsOn}::date AND ends_on>=${startsOn}::date
  ), changes AS (
    SELECT greatest(starts_on,${startsOn}::date) AS day,1 AS delta FROM active
    UNION ALL SELECT ends_on+1 AS day,-1 AS delta FROM active
  ), occupancy AS (SELECT sum(sum(delta)) OVER (ORDER BY day) AS used FROM changes GROUP BY day)
  SELECT coalesce(max(used),0)::integer AS peak FROM occupancy`;
  if (occupancy.peak >= resource.capacity)
    throw new AllocationConflict('The resource is full during the requested dates.');
  const [row] = await ctx.db.$queryRaw<IdRow[]>`INSERT INTO university_service_allocations
    (organization_id,person_id,resource_id,starts_on,ends_on)
    VALUES(${ctx.organizationId},${personId},${resourceId},${startsOn}::date,${endsOn}::date) RETURNING id`;
  const reference = resource.fee ? 'SERVICE-' + row.id : null;
  if (reference) {
    await issueStudentCharge(ctx, {
      personId,
      reference,
      feeHead: resource.kind === 'ROOM' ? 'OTHER' : resource.kind,
      amountPaisa: resource.fee,
      commencementDate: startsOn,
      dueDate: startsOn,
    });
    await ctx.db.$executeRaw`UPDATE university_service_allocations SET charge_reference=${reference}
      WHERE organization_id=${ctx.organizationId} AND id=${row.id}`;
  }
  await emitUniversityEvent(ctx, 'service.allocated', row.id, {
    personId,
    resourceId,
    startsOn,
    endsOn,
    chargeReference: reference,
  });
  return { allocationId: row.id, chargeReference: reference };
}

type Released = {
  id: string;
  person_id: string;
  resource_id: string;
  charge_reference: string | null;
};
async function publishRelease(ctx: UniversityContext, row: Released, reason: string) {
  await emitUniversityEvent(ctx, 'service.released', row.id, {
    personId: row.person_id,
    resourceId: row.resource_id,
    reason,
    chargeReference: row.charge_reference,
    needsBursarReview: row.charge_reference !== null,
  });
  const { promoteHousingWaitlist } = await import('./community');
  await promoteHousingWaitlist(ctx, row.resource_id);
}
async function release(ctx: UniversityContext, input: Input) {
  const reason = value(input, 'reason', 500);
  const [row] = await ctx.db.$queryRaw<Released[]>`UPDATE university_service_allocations
    SET released_at=now(),release_reason=${reason} WHERE organization_id=${ctx.organizationId}
    AND id=${value(input, 'allocationId')} AND released_at IS NULL RETURNING id,person_id,resource_id,charge_reference`;
  if (!row) throw new Error('Select an allocation which has not been released.');
  await publishRelease(ctx, row, reason);
  return { allocationId: row.id, chargeReference: row.charge_reference };
}
export async function releaseUniversityServicesOnWithdrawal(
  ctx: UniversityContext,
  personId: string,
  reason: 'WITHDRAWN' | 'GRADUATED' = 'WITHDRAWN'
) {
  await lockPerson(ctx, personId);
  const rows = await ctx.db.$queryRaw<
    Released[]
  >`UPDATE university_service_allocations a SET released_at=now(),release_reason=${reason}
    WHERE a.organization_id=${ctx.organizationId} AND a.person_id=${personId} AND a.released_at IS NULL
      AND a.ends_on >= (now() AT TIME ZONE 'Asia/Karachi')::date
      AND NOT EXISTS(SELECT 1 FROM university_student_programs p WHERE p.organization_id=a.organization_id AND p.person_id=a.person_id AND p.status='ACTIVE')
    RETURNING id,person_id,resource_id,charge_reference`;
  const { endStudentCommunityServices } = await import('./community');
  await endStudentCommunityServices(ctx, personId);
  for (const row of rows) await publishRelease(ctx, row, reason);
  return rows.length;
}
async function openCase(ctx: UniversityContext, input: Input) {
  const priority = value(input, 'priority');
  if (!['NORMAL', 'URGENT'].includes(priority)) throw new Error('Choose a case priority.');
  const [row] = await ctx.db.$queryRaw<IdRow[]>`INSERT INTO university_facilities_cases
    (organization_id,campus_id,location,description,priority,raised_by)
    VALUES(${ctx.organizationId},${value(input, 'campusId')},${value(input, 'location')},${value(input, 'description', 1500)},${priority},${ctx.userId}) RETURNING id`;
  await emitUniversityEvent(ctx, 'facilities.opened', row.id, { caseId: row.id, priority });
  return row;
}
async function assignCase(ctx: UniversityContext, input: Input) {
  const id = value(input, 'caseId'),
    staff = value(input, 'staffUserId');
  const rows = await ctx.db
    .$executeRaw`UPDATE university_facilities_cases c SET assigned_to=${staff}
    WHERE c.organization_id=${ctx.organizationId} AND c.id=${id} AND c.closed_at IS NULL
    AND EXISTS(SELECT 1 FROM users u WHERE u."organizationId"=c.organization_id AND u.id=${staff} AND u.status='ACTIVE')`;
  if (!rows) throw new Error('Select an open case and an active staff member.');
  return { id, assignedTo: staff };
}
async function resolveCase(ctx: UniversityContext, input: Input) {
  const id = value(input, 'caseId');
  const rows = await ctx.db
    .$executeRaw`UPDATE university_facilities_cases SET closed_at=now(),resolution=${value(input, 'resolution', 1500)}
    WHERE organization_id=${ctx.organizationId} AND id=${id} AND assigned_to IS NOT NULL AND closed_at IS NULL`;
  if (!rows) throw new Error('Select an assigned, open facilities case.');
  await emitUniversityEvent(ctx, 'facilities.resolved', id, { caseId: id });
  return { id };
}

async function loanBook(ctx: UniversityContext, input: Input) {
  const personId = value(input, 'personId'),
    due = date(input, 'dueOn'),
    barcode = value(input, 'barcode');
  await requireRegisteredStudent(ctx, personId);
  const [row] = await ctx.db.$queryRaw<
    IdRow[]
  >`INSERT INTO university_library_loans (organization_id,person_id,barcode,title,due_on)
    SELECT ${ctx.organizationId},${personId},${barcode},${value(input, 'title')},${due}::date
    WHERE ${due}::date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    ON CONFLICT(organization_id,barcode) WHERE returned_at IS NULL DO NOTHING RETURNING id`;
  if (!row) throw new Error('Choose an available barcode and a current or future due date.');
  return row;
}
async function returnBook(ctx: UniversityContext, input: Input) {
  const [row] = await ctx.db.$queryRaw<
    IdRow[]
  >`UPDATE university_library_loans SET returned_at=now()
    WHERE organization_id=${ctx.organizationId} AND barcode=${value(input, 'barcode')} AND returned_at IS NULL RETURNING id`;
  if (!row) throw new Error('No outstanding loan has this barcode.');
  return row;
}
export async function assertUniversityLibraryClearance(ctx: UniversityContext, personId: string) {
  await lockPerson(ctx, personId);
  const [row] = await ctx.db.$queryRaw<
    { outstanding: number }[]
  >`SELECT count(*)::integer AS outstanding FROM university_library_loans
    WHERE organization_id=${ctx.organizationId} AND person_id=${personId} AND returned_at IS NULL`;
  if (row.outstanding > 0)
    throw new Error(`Library clearance requires the return of ${row.outstanding} item(s).`);
  return { personId, cleared: true };
}

async function appoint(ctx: UniversityContext, input: Input) {
  const { startsOn, endsOn } = period(input),
    staff = value(input, 'staffUserId'),
    reference = value(input, 'reference', 100);
  const monthly = integer(input, 'monthlyPaisa', 0, 2000000000),
    weekly = integer(input, 'weeklyMinutes', 0, 10080);
  const [row] = await ctx.db.$queryRaw<IdRow[]>`INSERT INTO university_staff_appointments
    (organization_id,user_id,campus_id,reference,position,starts_on,ends_on,monthly_paisa,load_minutes)
    SELECT ${ctx.organizationId},u.id,${value(input, 'campusId')},${reference},${value(input, 'position')},${startsOn}::date,${endsOn}::date,${monthly},${weekly}
    FROM users u WHERE u."organizationId"=${ctx.organizationId} AND u.id=${staff} AND u.status='ACTIVE' RETURNING id`;
  if (!row) throw new Error('Choose an active staff member.');
  await emitUniversityEvent(ctx, 'staff.appointed', row.id, {
    staffUserId: staff,
    reference,
    startsOn,
    endsOn,
  });
  return row;
}
async function assignLoad(ctx: UniversityContext, input: Input) {
  const appointmentId = value(input, 'appointmentId'),
    sectionId = value(input, 'sectionId');
  const [app] = await ctx.db.$queryRaw<
    {
      user_id: string;
      campus_id: string;
      load_minutes: number;
      starts_on: string;
      ends_on: string;
    }[]
  >`
    SELECT user_id,campus_id,load_minutes,starts_on::text,ends_on::text FROM university_staff_appointments
    WHERE organization_id=${ctx.organizationId} AND id=${appointmentId} FOR UPDATE`;
  if (!app) throw new Error('Choose a valid appointment.');
  const [section] = await ctx.db.$queryRaw<
    { term: string; minutes: number }[]
  >`SELECT s.term,(s.end_minute-s.start_minute) AS minutes
    FROM university_sections s JOIN university_intakes i ON i.organization_id=s.organization_id AND i.id=s.intake_id
    JOIN university_programs p ON p.organization_id=i.organization_id AND p.id=i.program_id
    WHERE s.organization_id=${ctx.organizationId} AND s.id=${sectionId} AND s.instructor_id=${app.user_id} AND p.campus_id=${app.campus_id}
      AND ${date(input, 'teachingDate')}::date BETWEEN ${app.starts_on}::date AND ${app.ends_on}::date`;
  if (!section)
    throw new Error('The section instructor, campus and teaching date must match the appointment.');
  const [used] = await ctx.db.$queryRaw<
    { minutes: number }[]
  >`SELECT coalesce(sum(s.end_minute-s.start_minute),0)::integer AS minutes
    FROM university_teaching_loads l JOIN university_sections s ON s.organization_id=l.organization_id AND s.id=l.section_id
    WHERE l.organization_id=${ctx.organizationId} AND l.appointment_id=${appointmentId} AND s.term=${section.term}`;
  if (used.minutes + section.minutes > app.load_minutes)
    throw new Error('This section exceeds the contracted weekly teaching load.');
  const count = await ctx.db
    .$executeRaw`INSERT INTO university_teaching_loads (organization_id,appointment_id,section_id)
    VALUES(${ctx.organizationId},${appointmentId},${sectionId}) ON CONFLICT DO NOTHING`;
  if (!count) throw new Error('This section is already allocated to an appointment.');
  return { appointmentId, sectionId, term: section.term, minutes: section.minutes };
}
function csvCell(value: string) {
  // Office software interprets formulas even inside quoted cells.
  const safe = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
async function payrollExport(ctx: UniversityContext, input: Input) {
  const month = value(input, 'month');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000'))
    throw new Error('Enter a payroll month in YYYY-MM format.');
  const rows = await ctx.db.$queryRaw<
    {
      reference: string;
      user_id: string;
      position: string;
      from_date: string;
      through_date: string;
      monthly_paisa: string;
      gross_paisa: string;
    }[]
  >`
    WITH m AS (SELECT ${month + '-01'}::date AS first_day, (${month + '-01'}::date + interval '1 month' - interval '1 day')::date AS last_day)
    SELECT a.reference,a.user_id,a.position,greatest(a.starts_on,m.first_day)::text AS from_date,
      least(a.ends_on,m.last_day)::text AS through_date,a.monthly_paisa::text,
      round(a.monthly_paisa::numeric * (least(a.ends_on,m.last_day)-greatest(a.starts_on,m.first_day)+1)
          / (m.last_day-m.first_day+1))::text AS gross_paisa
    FROM university_staff_appointments a CROSS JOIN m WHERE a.organization_id=${ctx.organizationId}
      AND a.starts_on<=m.last_day AND a.ends_on>=m.first_day ORDER BY a.user_id,a.reference`;
  const csv = [
    'appointment_reference,staff_user_id,position,from_date,through_date,monthly_paisa,gross_paisa,currency',
    ...rows.map((r) =>
      [
        r.reference,
        r.user_id,
        r.position,
        r.from_date,
        r.through_date,
        r.monthly_paisa,
        r.gross_paisa,
        'PKR',
      ]
        .map(csvCell)
        .join(',')
    ),
  ].join('\r\n');
  return { filename: 'university-gross-pay-' + month + '.csv', csv, appointments: rows.length };
}

type Procurement = {
  id: string;
  grant_id: string | null;
  amount_paisa: string;
  category: string;
  needed_on: string;
  created_by: string;
  status: string;
};
async function readRequest(ctx: UniversityContext, id: string): Promise<Procurement> {
  const [row] = await ctx.db.$queryRaw<
    Procurement[]
  >`SELECT id,grant_id,amount_paisa::text,category,needed_on::text,created_by,status
    FROM university_procurement_requests WHERE organization_id=${ctx.organizationId} AND id=${id} FOR UPDATE`;
  if (!row) throw new Error('Choose an existing procurement request.');
  return row;
}
async function checkGrant(
  ctx: UniversityContext,
  grantId: string,
  category: string,
  onDate: string,
  amount: string,
  requestId: string | null
) {
  // Serialize reservations against the award. The second statement sees approvals
  // committed by the previous lock holder under the normal READ COMMITTED policy.
  const [award] = await ctx.db.$queryRaw<
    { budget: string; eligible: boolean }[]
  >`SELECT budget_minor::text AS budget,
    (status='ACTIVE' AND currency='PKR' AND ${onDate}::date BETWEEN starts_on AND ends_on AND
      (cardinality(allowed_categories)=0 OR ${category}=ANY(allowed_categories))) AS eligible
    FROM university_research_grants WHERE organization_id=${ctx.organizationId} AND id=${grantId} FOR UPDATE`;
  if (!award?.eligible) throw new Error('The award must permit this category and date.');
  const [reserved] = await ctx.db.$queryRaw<
    { committed: string }[]
  >`SELECT coalesce(sum(amount_paisa),0)::text AS committed
    FROM university_procurement_requests WHERE organization_id=${ctx.organizationId} AND grant_id=${grantId}
      AND status IN ('APPROVED','RECEIVED') AND id IS DISTINCT FROM ${requestId}`;
  if (BigInt(reserved.committed) + BigInt(amount) > BigInt(award.budget))
    throw new Error('This expenditure exceeds the remaining award budget.');
}
async function requisition(ctx: UniversityContext, input: Input) {
  const grant = input.grantId?.trim() || null,
    amount = integer(input, 'amountPaisa', 1, 2000000000);
  const category = value(input, 'category', 80).toUpperCase(),
    needed = date(input, 'neededOn');
  if (grant) await checkGrant(ctx, grant, category, needed, String(amount), null);
  const [row] = await ctx.db.$queryRaw<IdRow[]>`INSERT INTO university_procurement_requests
    (organization_id,reference,campus_id,grant_id,category,supplier,description,amount_paisa,needed_on,created_by)
    VALUES(${ctx.organizationId},${value(input, 'reference', 100)},${value(input, 'campusId')},${grant},${category},${value(input, 'supplier')},
      ${value(input, 'description', 1500)},${amount},${needed}::date,${ctx.userId}) RETURNING id`;
  await emitUniversityEvent(ctx, 'procurement.requested', row.id, {
    requestId: row.id,
    grantId: grant,
  });
  return row;
}
async function decidePurchase(ctx: UniversityContext, input: Input) {
  const request = await readRequest(ctx, value(input, 'requestId')),
    decision = value(input, 'decision');
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new Error('Choose an approval decision.');
  if (request.status !== 'REQUESTED' || request.created_by === ctx.userId)
    throw new Error('A different officer must review a pending request.');
  if (decision === 'APPROVED' && request.grant_id)
    await checkGrant(
      ctx,
      request.grant_id,
      request.category,
      request.needed_on,
      request.amount_paisa,
      request.id
    );
  await ctx.db
    .$executeRaw`UPDATE university_procurement_requests SET status=${decision},decision_reason=${value(input, 'reason', 500)},decision_by=${ctx.userId}
    WHERE organization_id=${ctx.organizationId} AND id=${request.id}`;
  await emitUniversityEvent(ctx, 'procurement.decided', request.id, {
    requestId: request.id,
    decision,
    grantId: request.grant_id,
  });
  return { requestId: request.id, status: decision };
}
async function receivePurchase(ctx: UniversityContext, input: Input) {
  const request = await readRequest(ctx, value(input, 'requestId')),
    received = date(input, 'receivedOn'),
    receipt = value(input, 'receiptReference', 100);
  if (request.status !== 'APPROVED')
    throw new Error('Only approved goods or services can be received.');
  if (request.grant_id)
    await checkGrant(
      ctx,
      request.grant_id,
      request.category,
      received,
      request.amount_paisa,
      request.id
    );
  const updated = await ctx.db
    .$executeRaw`UPDATE university_procurement_requests SET status='RECEIVED',receipt_reference=${receipt},received_on=${received}::date
    WHERE organization_id=${ctx.organizationId} AND id=${request.id} AND ${received}::date <= (now() AT TIME ZONE 'Asia/Karachi')::date`;
  if (!updated) throw new Error('A goods receipt cannot be dated in the future.');
  await emitUniversityEvent(ctx, 'procurement.received', request.id, {
    requestId: request.id,
    grantId: request.grant_id,
    amountPaisa: request.amount_paisa,
    currency: 'PKR',
    receipt,
    received,
  });
  return { requestId: request.id, status: 'RECEIVED' };
}
async function cancelPurchase(ctx: UniversityContext, input: Input) {
  const request = await readRequest(ctx, value(input, 'requestId'));
  const approver = officeRoleAllowed(ctx, ['university-finance-approver']);
  if (
    !['REQUESTED', 'APPROVED'].includes(request.status) ||
    (!approver && (request.created_by !== ctx.userId || request.status !== 'REQUESTED'))
  ) {
    throw new Error(
      'Only your pending request, or a commitment released by a finance approver, can be cancelled.'
    );
  }
  await ctx.db
    .$executeRaw`UPDATE university_procurement_requests SET status='CANCELLED',decision_reason=${value(input, 'reason', 500)}
    WHERE organization_id=${ctx.organizationId} AND id=${request.id}`;
  await emitUniversityEvent(ctx, 'procurement.cancelled', request.id, {
    requestId: request.id,
    grantId: request.grant_id,
  });
  return { requestId: request.id, status: 'CANCELLED' };
}

async function servicesRegister(ctx: UniversityContext): Promise<Row[]> {
  const records: Row[] = [];
  if (officeRoleAllowed(ctx, campusRoles)) {
    records.push(
      ...(await ctx.db.$queryRaw<Row[]>`
      SELECT 'Resource' AS kind,id,label AS description,kind AS status,campus_id AS related,capacity::text AS detail
        FROM university_service_resources WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Allocation',a.id,r.label,CASE WHEN a.released_at IS NOT NULL THEN 'RELEASED'
        WHEN a.ends_on < (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'EXPIRED' ELSE 'RESERVED' END,a.person_id,a.starts_on||' to '||a.ends_on
        FROM university_service_allocations a JOIN university_service_resources r ON r.organization_id=a.organization_id AND r.id=a.resource_id
        WHERE a.organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Facilities case',id,location||' — '||description,CASE WHEN closed_at IS NOT NULL THEN 'RESOLVED'
        WHEN assigned_to IS NOT NULL THEN 'ASSIGNED' ELSE 'OPEN' END,campus_id,concat_ws(' · ',priority,assigned_to,resolution) FROM university_facilities_cases WHERE organization_id=${ctx.organizationId}
      UNION ALL SELECT 'Library loan',id,title,CASE WHEN returned_at IS NULL THEN 'BORROWED' ELSE 'RETURNED' END,person_id,barcode
        FROM university_library_loans WHERE organization_id=${ctx.organizationId} ORDER BY kind,description,id LIMIT 300`)
    );
  }
  if (officeRoleAllowed(ctx, [...registryRoles, ...financeRoles])) {
    records.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Staff appointment' AS kind,id,position AS description,reference AS status,user_id AS related,
      starts_on||' to '||ends_on AS detail FROM university_staff_appointments WHERE organization_id=${ctx.organizationId} ORDER BY starts_on DESC,id LIMIT 100`)
    );
  }
  if (officeRoleAllowed(ctx, registryRoles)) {
    records.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Teaching load' AS kind,s.id,s.label AS description,s.term AS status,l.appointment_id AS related,
      (s.end_minute-s.start_minute)::text||' minutes/week' AS detail FROM university_teaching_loads l
      JOIN university_sections s ON s.organization_id=l.organization_id AND s.id=l.section_id
      WHERE l.organization_id=${ctx.organizationId} ORDER BY s.term DESC,s.label,s.id LIMIT 100`)
    );
  }
  if (officeRoleAllowed(ctx, purchaseRoles)) {
    records.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Procurement' AS kind,id,reference||' — '||description AS description,status,grant_id AS related,
      amount_paisa::text||' paisa' AS detail FROM university_procurement_requests
      WHERE organization_id=${ctx.organizationId} ORDER BY created_at DESC,id LIMIT 100`)
    );
  }
  return records;
}

function field(
  name: string,
  label: string,
  type: UniversityField['type'] = 'text',
  required = true
): UniversityField {
  return { name, label, type, required };
}
function select(name: string, label: string, options: string[]): UniversityField {
  return { name, label, type: 'select', options, required: true };
}
const campusField = field('campusId', 'Campus ID'),
  personField = field('personId', 'Student person ID'),
  staffField = field('staffUserId', 'Staff user ID'),
  requestField = field('requestId', 'Procurement request ID');
const periodFields = [field('startsOn', 'Start date', 'date'), field('endsOn', 'End date', 'date')];
const reasonField = field('reason', 'Reason', 'textarea');

export const servicesOffice: UniversityOffice = {
  title: 'Campus services and workforce',
  description:
    'Manage campus allocations, library returns, facilities cases, staff appointments and purchases.',
  moduleKey: 'university-services',
  roles: allRoles,
  read: servicesRegister,
  actions: [
    {
      key: 'create-resource',
      label: 'Register campus resource',
      roles: campusRoles,
      fields: [
        campusField,
        select('kind', 'Resource type', ['HOSTEL', 'TRANSPORT', 'ROOM']),
        field('code', 'Resource code'),
        field('label', 'Resource name'),
        field('capacity', 'Simultaneous capacity', 'number'),
        field('feePaisa', 'Allocation fee in paisa (zero if free)', 'number'),
      ],
      run: createResource,
    },
    {
      key: 'allocate',
      label: 'Allocate campus resource',
      roles: campusRoles,
      fields: [field('resourceId', 'Resource ID'), personField, ...periodFields],
      run: allocate,
    },
    {
      key: 'release',
      label: 'Release allocation',
      roles: campusRoles,
      fields: [field('allocationId', 'Allocation ID'), reasonField],
      run: release,
    },
    {
      key: 'open-case',
      label: 'Open facilities case',
      roles: campusRoles,
      fields: [
        campusField,
        field('location', 'Location'),
        field('description', 'Issue', 'textarea'),
        select('priority', 'Priority', ['NORMAL', 'URGENT']),
      ],
      run: openCase,
    },
    {
      key: 'assign-case',
      label: 'Assign facilities case',
      roles: campusRoles,
      fields: [field('caseId', 'Case ID'), staffField],
      run: assignCase,
    },
    {
      key: 'resolve-case',
      label: 'Resolve facilities case',
      roles: campusRoles,
      fields: [field('caseId', 'Case ID'), field('resolution', 'Resolution', 'textarea')],
      run: resolveCase,
    },
    {
      key: 'library-loan',
      label: 'Check out library item',
      roles: campusRoles,
      fields: [
        personField,
        field('barcode', 'Item barcode'),
        field('title', 'Item title'),
        field('dueOn', 'Due date', 'date'),
      ],
      run: loanBook,
    },
    {
      key: 'library-return',
      label: 'Return library item',
      roles: campusRoles,
      fields: [field('barcode', 'Item barcode')],
      run: returnBook,
    },
    {
      key: 'library-clearance',
      label: 'Check library clearance',
      roles: [...campusRoles, ...registryRoles],
      fields: [personField],
      run: (ctx, input) => assertUniversityLibraryClearance(ctx, value(input, 'personId')),
    },
    {
      key: 'appointment',
      label: 'Register staff appointment',
      roles: registryRoles,
      fields: [
        staffField,
        campusField,
        field('reference', 'Contract reference'),
        field('position', 'Position'),
        ...periodFields,
        field('monthlyPaisa', 'Monthly gross pay in paisa', 'number'),
        field('weeklyMinutes', 'Contracted weekly teaching minutes', 'number'),
      ],
      run: appoint,
    },
    {
      key: 'teaching-load',
      label: 'Allocate section teaching load',
      roles: registryRoles,
      fields: [
        field('appointmentId', 'Appointment ID'),
        field('sectionId', 'Section ID'),
        field('teachingDate', 'Teaching date within appointment', 'date'),
      ],
      run: assignLoad,
    },
    {
      key: 'payroll-export',
      institutionWide: true,
      label: 'Export gross payroll',
      roles: financeRoles,
      fields: [field('month', 'Payroll month (YYYY-MM)')],
      run: payrollExport,
    },
    {
      key: 'requisition',
      label: 'Request purchase',
      roles: purchaseRoles,
      fields: [
        field('reference', 'Requisition reference'),
        campusField,
        field('grantId', 'Research award ID (if funded)', 'text', false),
        field('category', 'Spending category'),
        field('supplier', 'Supplier'),
        field('description', 'Goods or services', 'textarea'),
        field('amountPaisa', 'Total in paisa', 'number'),
        field('neededOn', 'Required date', 'date'),
      ],
      run: requisition,
    },
    {
      key: 'purchase-decision',
      label: 'Review purchase',
      roles: ['university-finance-approver'],
      fields: [requestField, select('decision', 'Decision', ['APPROVED', 'REJECTED']), reasonField],
      run: decidePurchase,
    },
    {
      key: 'receive-purchase',
      label: 'Record goods or services received',
      roles: [...campusRoles, 'university-bursar'],
      fields: [
        requestField,
        field('receiptReference', 'Receipt reference'),
        field('receivedOn', 'Receipt date', 'date'),
      ],
      run: receivePurchase,
    },
    {
      key: 'cancel-purchase',
      label: 'Cancel purchase commitment',
      roles: purchaseRoles,
      fields: [requestField, reasonField],
      run: cancelPurchase,
    },
  ],
};

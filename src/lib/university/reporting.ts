import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { UniversityAction, UniversityContext, UniversityOffice } from './office-types';

const analysts = ['university-analyst', 'university-registrar'];
const registrar = ['university-registrar'];
const label = z.string().trim().min(1).max(180);
const censusRowSchema = z
  .object({
    scope: z.enum(['INSTITUTION', 'CAMPUS', 'PROGRAM', 'AFFILIATED_COLLEGE']),
    unit: label,
    metric: label,
    count: z.number().int().nonnegative().max(2147483647),
    source: label,
  })
  .strict();
type CensusRow = z.infer<typeof censusRowSchema>;

export function parseCensusSupplement(input: string) {
  if (!input.trim()) return [];
  if (input.length > 200000) throw new Error('The supplemental return is too large.');
  let rows: unknown;
  try {
    rows = JSON.parse(input);
  } catch {
    throw new Error('Enter a JSON array of supplemental counts.');
  }
  return z.array(censusRowSchema).max(1000).parse(rows);
}

export function orderCensusRows(rows: CensusRow[]) {
  const keys = new Set<string>();
  const sortable = rows.map((row) => {
    const key = JSON.stringify([row.scope, row.unit, row.metric]);
    if (keys.has(key)) throw new Error('Each census unit and metric may appear only once.');
    keys.add(key);
    return { key, row };
  });
  sortable.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sortable.map((item) => item.row);
}

export function censusCsv(rows: CensusRow[]) {
  // Text fields may be supplied by an institutional return. Use neutral spreadsheet cells.
  const escape = (value: string) => {
    const safe = /^[=+@\-\t\r]/.test(value.trimStart()) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const lines = rows.map((row) =>
    [
      escape(row.scope),
      escape(row.unit),
      escape(row.metric),
      String(row.count),
      escape(row.source),
    ].join(',')
  );
  return ['Scope,Unit,Metric,Count,Source', ...lines].join('\r\n') + '\r\n';
}

async function liveCounts(ctx: UniversityContext, start: string, end: string) {
  // The census is the end of the named Pakistan civil day. Historical enrollment intervals survive withdrawals.
  return ctx.db.$queryRaw<CensusRow[]>`
    WITH bounds AS (
      SELECT (${start}::date::timestamp AT TIME ZONE 'Asia/Karachi') AS starts,
        ((${end}::date + 1)::timestamp AT TIME ZONE 'Asia/Karachi') AS ends
    ), records AS (
      SELECT sp.person_id, p.id AS program_id,p.code,ca.id AS campus_id,ca.name AS campus,sp.matriculated_at,sp.ended_at,sp.status,
        b.starts,b.ends,EXISTS(SELECT 1 FROM university_study_interruptions l
          WHERE (l.organization_id,l.student_program_id)=(sp.organization_id,sp.id)
            AND l.starts_on<=${end}::date AND (l.returned_on IS NULL OR l.returned_on>${end}::date)) AS on_leave
        FROM university_student_programs sp
      JOIN university_intakes i ON (i.organization_id,i.id)=(sp.organization_id,sp.intake_id)
      JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id)
      JOIN university_campuses ca ON (ca.organization_id,ca.id)=(p.organization_id,p.campus_id)
      CROSS JOIN bounds b WHERE sp.organization_id=${ctx.organizationId} AND sp.matriculated_at<b.ends
    ), counts AS (
      SELECT CASE WHEN GROUPING(campus_id)=1 THEN 'INSTITUTION' WHEN GROUPING(program_id)=1 THEN 'CAMPUS' ELSE 'PROGRAM' END AS scope,
        CASE WHEN GROUPING(campus_id)=1 THEN 'All' WHEN GROUPING(program_id)=1 THEN campus ELSE campus || ' / ' || code || ' (' || program_id || ')' END AS unit,
        count(DISTINCT person_id) FILTER (WHERE ended_at IS NULL OR ended_at>=ends)::int AS active,
        count(DISTINCT person_id) FILTER (WHERE on_leave AND (ended_at IS NULL OR ended_at>=ends))::int AS studying_on_leave,
        count(DISTINCT person_id) FILTER (WHERE matriculated_at>=starts)::int AS entrants,
        count(DISTINCT person_id) FILTER (WHERE status='GRADUATED' AND ended_at>=starts AND ended_at<ends)::int AS graduates,
        count(DISTINCT person_id) FILTER (WHERE status='WITHDRAWN' AND ended_at>=starts AND ended_at<ends)::int AS withdrawn
      FROM records GROUP BY GROUPING SETS ((),(campus_id,campus),(campus_id,campus,program_id,code))
    )
    SELECT counts.scope,counts.unit,m.metric,m.count,'Registrar'::text AS source FROM counts
      CROSS JOIN LATERAL (VALUES ('active_students',active),('new_entrants',entrants),('graduates',graduates),
       ('withdrawals',withdrawn),('active_students_on_leave',studying_on_leave)) AS m(metric,count)
    ORDER BY counts.scope,counts.unit,m.metric`;
}

export function censusInput(input: Record<string, string>) {
  const data = z
    .object({
      periodStart: z.iso.date(),
      censusDate: z.iso.date(),
      template: label,
      expectedRevision: z.coerce.number().int().min(0),
      note: z.string().trim().min(1).max(1000),
      supplement: z.string().optional(),
    })
    .parse(input);
  if (data.periodStart > data.censusDate)
    throw new Error('Choose a census date on or after the reporting period starts.');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  if (data.censusDate > today) throw new Error('Choose a completed or current census date.');
  return data;
}

async function freezeCensus(ctx: UniversityContext, input: Record<string, string>) {
  const data = censusInput(input);
  const extra = parseCensusSupplement(data.supplement ?? '');
  const scopeKey = JSON.stringify([ctx.organizationId, data.periodStart, data.censusDate]);
  await ctx.db
    .$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey},0))::text AS locked`;
  const [previous] = await ctx.db.$queryRaw<{ revision: number }[]>`
    SELECT revision FROM university_census_snapshots WHERE organization_id=${ctx.organizationId}
      AND period_start=${data.periodStart}::date AND census_date=${data.censusDate}::date ORDER BY revision DESC LIMIT 1`;
  if ((previous?.revision ?? 0) !== data.expectedRevision)
    throw new Error('Refresh the latest report revision before freezing a new one.');
  const rows = orderCensusRows([
    ...(await liveCounts(ctx, data.periodStart, data.censusDate)),
    ...extra,
  ]);
  const sha256 = createHash('sha256').update(censusCsv(rows), 'utf8').digest('hex');
  const [snapshot] = await ctx.db.$queryRaw<{ id: string; revision: number; sha256: string }[]>`
    INSERT INTO university_census_snapshots (organization_id,period_start,census_date,revision,template_reference,revision_note,payload,sha256,created_by)
    VALUES (${ctx.organizationId},${data.periodStart}::date,${data.censusDate}::date,${data.expectedRevision + 1},${data.template},
      ${data.note},${JSON.stringify(rows)}::jsonb,${sha256},${ctx.userId}) RETURNING id,revision,sha256`;
  return snapshot;
}

async function approveCensus(ctx: UniversityContext, input: Record<string, string>) {
  const id = label.parse(input.id);
  const [snapshot] = await ctx.db.$queryRaw<{ period_start: string; census_date: string }[]>`
    SELECT period_start::text,census_date::text FROM university_census_snapshots WHERE organization_id=${ctx.organizationId} AND id=${id}`;
  if (!snapshot) throw new Error('Census revision was not found.');
  const scopeKey = JSON.stringify([
    ctx.organizationId,
    snapshot.period_start,
    snapshot.census_date,
  ]);
  await ctx.db
    .$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey},0))::text AS locked`;
  const count = await ctx.db.$executeRaw`
    INSERT INTO university_census_approvals (organization_id,snapshot_id,approved_by)
    SELECT s.organization_id,s.id,${ctx.userId} FROM university_census_snapshots s
    WHERE s.organization_id=${ctx.organizationId} AND s.id=${id} AND s.created_by<>${ctx.userId}
      AND NOT EXISTS (SELECT 1 FROM university_census_snapshots newer WHERE newer.organization_id=s.organization_id
        AND newer.period_start=s.period_start AND newer.census_date=s.census_date AND newer.revision>s.revision)
    ON CONFLICT DO NOTHING`;
  if (!count) throw new Error('A second officer must approve the latest unapproved revision.');
  return { id, status: 'APPROVED' };
}

async function exportCensus(ctx: UniversityContext, input: Record<string, string>) {
  const id = label.parse(input.id);
  const [row] = await ctx.db.$queryRaw<
    { census_date: string; revision: number; sha256: string; payload: unknown }[]
  >`
    SELECT s.census_date::text,s.revision,s.sha256,s.payload FROM university_census_snapshots s
    JOIN university_census_approvals a ON (a.organization_id,a.snapshot_id)=(s.organization_id,s.id)
    WHERE s.organization_id=${ctx.organizationId} AND s.id=${id}`;
  if (!row) throw new Error('Select an approved census revision.');
  const content = censusCsv(z.array(censusRowSchema).parse(row.payload));
  if (createHash('sha256').update(content, 'utf8').digest('hex') !== row.sha256)
    throw new Error('The frozen export checksum does not match.');
  return {
    fileName: `hedr-${row.census_date}-r${row.revision}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    content,
    sha256: row.sha256,
  };
}

async function acknowledge(ctx: UniversityContext, input: Record<string, string>) {
  const data = z.object({ id: label, externalReference: label }).parse(input);
  const count = await ctx.db.$executeRaw`
    INSERT INTO university_census_receipts (organization_id,snapshot_id,official_reference,recorded_by)
    SELECT organization_id,snapshot_id,${data.externalReference},${ctx.userId} FROM university_census_approvals
    WHERE organization_id=${ctx.organizationId} AND snapshot_id=${data.id} ON CONFLICT DO NOTHING`;
  if (!count)
    throw new Error(
      'Select an approved, unacknowledged return and an unused HEC receipt reference.'
    );
  return { id: data.id, status: 'ACKNOWLEDGED' };
}

const snapshotId = { name: 'id', label: 'Census snapshot ID', required: true };
const actions: UniversityAction[] = [
  {
    key: 'freeze-census',
    label: 'Freeze census revision',
    roles: analysts,
    run: freezeCensus,
    fields: [
      { name: 'periodStart', label: 'Reporting period start', type: 'date', required: true },
      { name: 'censusDate', label: 'Census date', type: 'date', required: true },
      {
        name: 'template',
        label: 'HEC template version or reporting request reference',
        required: true,
      },
      {
        name: 'expectedRevision',
        label: 'Previous revision (0 for first return)',
        type: 'number',
        required: true,
      },
      { name: 'note', label: 'Source and revision reason', type: 'textarea', required: true },
      {
        name: 'supplement',
        label: 'Supplemental counts as JSON with scope, unit, metric, count and source',
        type: 'textarea',
      },
    ],
  },
  {
    key: 'approve-census',
    label: 'Approve frozen return',
    roles: registrar,
    run: approveCensus,
    fields: [snapshotId],
  },
  {
    key: 'export-census',
    label: 'Download approved census CSV',
    roles: analysts,
    run: exportCensus,
    fields: [snapshotId],
  },
  {
    key: 'acknowledge-census',
    label: 'Record HEC acknowledgment',
    roles: registrar,
    run: acknowledge,
    fields: [
      snapshotId,
      { name: 'externalReference', label: 'Official acknowledgment reference', required: true },
    ],
  },
];

export const reportingOffice: UniversityOffice = {
  title: 'Institutional reporting',
  description:
    'Reconcile annual enrollment, entrants and completions with approved supplemental counts for the HEC focal person.',
  moduleKey: 'university-reporting',
  roles: analysts,
  actions,
  read: async (ctx) => {
    const reports = await ctx.db.$queryRaw<Record<string, unknown>[]>`
      SELECT 'Annual census' AS record,s.id,s.period_start::text,s.census_date::text,s.revision,s.template_reference,
        CASE WHEN r.snapshot_id IS NOT NULL THEN 'ACKNOWLEDGED' WHEN a.snapshot_id IS NOT NULL THEN 'APPROVED' ELSE 'DRAFT' END AS status,
        s.sha256,r.official_reference,s.revision_note FROM university_census_snapshots s
      LEFT JOIN university_census_approvals a ON (a.organization_id,a.snapshot_id)=(s.organization_id,s.id)
      LEFT JOIN university_census_receipts r ON (r.organization_id,r.snapshot_id)=(s.organization_id,s.id)
      WHERE s.organization_id=${ctx.organizationId} ORDER BY s.census_date DESC,s.revision DESC LIMIT 100`;
    const [totals] = await ctx.db.$queryRaw<Record<string, unknown>[]>`
      SELECT 'Live academic totals' AS record,
        (SELECT count(*)::int FROM university_applications WHERE organization_id=${ctx.organizationId}) AS applications,
        (SELECT count(DISTINCT person_id)::int FROM university_student_programs WHERE organization_id=${ctx.organizationId} AND status='ACTIVE') AS active_people,
        (SELECT count(*)::int FROM university_enrollments WHERE organization_id=${ctx.organizationId} AND status='WAITLISTED') AS waitlisted_requests,
        (SELECT count(*)::int FROM university_awards WHERE organization_id=${ctx.organizationId}) AS issued_degrees`;
    return [totals, ...reports];
  },
};

import { z } from 'zod';
import type { UniversityAction, UniversityContext, UniversityOffice } from './office-types';

const kinds = [
  'APPLICATION_DOCUMENT',
  'INCOMPLETE_UPLOAD',
  'EXPIRED_CHALLENGE',
  'EXPIRED_SESSION',
] as const;
const scopes = ['INSTITUTION', 'PERSON', 'DOCUMENT', 'CANDIDATE'] as const;
type Kind = (typeof kinds)[number];
type Row = Record<string, unknown>;
type Form = Record<string, string>;
const text = z.string().trim().min(1).max(240);
const id = z.string().trim().min(1).max(160);
const adminRoles = ['university-admin'];
function admin(ctx: UniversityContext) {
  if (!ctx.admin) throw new Error('This operation requires an institution administrator.');
}
async function lock(ctx: UniversityContext) {
  admin(ctx);
  await ctx.db
    .$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('university-retention:' || ${ctx.organizationId},0))`;
}
function ensureUpdated(count: number, message: string) {
  if (!count) throw new Error(message);
}
async function propose(ctx: UniversityContext, input: Form) {
  const data = z
    .object({
      kind: z.enum(kinds),
      days: z.coerce.number().int().min(1).max(36500),
      effectiveOn: z.iso.date(),
      authority: text,
    })
    .parse(input);
  await lock(ctx);
  const [policy] = await ctx.db.$queryRaw<
    { id: string }[]
  >`INSERT INTO university_retention_policies(organization_id,kind,retain_days,effective_on,authority_reference,proposed_by)
    VALUES(${ctx.organizationId},${data.kind},${data.days},${data.effectiveOn}::date,${data.authority},${ctx.userId})
    ON CONFLICT(organization_id,kind,effective_on) DO UPDATE SET retain_days=EXCLUDED.retain_days,authority_reference=EXCLUDED.authority_reference
      WHERE university_retention_policies.approved_at IS NULL AND university_retention_policies.proposed_by=EXCLUDED.proposed_by RETURNING id`;
  if (!policy)
    throw new Error(
      'This effective date has an approved policy or a proposal from another administrator.'
    );
  return policy;
}
async function approvePolicy(ctx: UniversityContext, input: Form) {
  const policy = id.parse(input.policyId);
  await lock(ctx);
  const count = await ctx.db
    .$executeRaw`UPDATE university_retention_policies SET approved_by=${ctx.userId},approved_at=now()
    WHERE organization_id=${ctx.organizationId} AND id=${policy} AND approved_at IS NULL AND proposed_by<>${ctx.userId}`;
  ensureUpdated(count, 'A different administrator must approve a pending proposal.');
  return { id: policy, status: 'APPROVED' };
}
async function createHold(ctx: UniversityContext, input: Form) {
  const data = z
    .object({
      scope: z.enum(scopes),
      target: z.string().trim().max(180).optional(),
      authority: text,
    })
    .parse(input);
  await lock(ctx);
  let target = data.target ?? '';
  if (data.scope === 'INSTITUTION') target = '';
  else if (!target)
    throw new Error(
      'Provide the person, document or preview candidate ID to place a targeted hold.'
    );
  if (data.scope === 'PERSON') {
    const [person] = await ctx.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM university_people WHERE organization_id=${ctx.organizationId} AND id=${target}`;
    if (!person) throw new Error('University person was not found.');
  } else if (data.scope === 'DOCUMENT') {
    const [doc] = await ctx.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM university_documents WHERE organization_id=${ctx.organizationId} AND id=${target}`;
    if (!doc) throw new Error('University document was not found.');
  } else if (data.scope === 'CANDIDATE') {
    const [candidate] = await ctx.db.$queryRaw<
      { key: string }[]
    >`SELECT p.kind||'/'||c.target_key AS key FROM university_retention_candidates c JOIN university_retention_reviews r
      ON (r.organization_id,r.id)=(c.organization_id,c.review_id) JOIN university_retention_policies p ON (p.organization_id,p.id)=(r.organization_id,r.policy_id)
      WHERE c.organization_id=${ctx.organizationId} AND c.id=${target} AND c.status='PENDING' AND r.status IN ('PREVIEW','APPROVED')`;
    if (!candidate) throw new Error('Choose a pending candidate.');
    target = candidate.key;
  }
  const [hold] = await ctx.db.$queryRaw<{ id: string }[]>`INSERT INTO university_retention_holds
    (organization_id,scope,target_key,authority_reference,created_by) VALUES(${ctx.organizationId},${data.scope},${target},${data.authority},${ctx.userId}) RETURNING id`;
  return hold;
}
async function releaseHold(ctx: UniversityContext, input: Form) {
  const data = z.object({ holdId: id, reference: text }).parse(input);
  await lock(ctx);
  const count = await ctx.db
    .$executeRaw`UPDATE university_retention_holds SET released_by=${ctx.userId},released_at=now(),release_reference=${data.reference}
    WHERE organization_id=${ctx.organizationId} AND id=${data.holdId} AND released_at IS NULL`;
  ensureUpdated(count, 'Choose an active legal hold.');
  return { id: data.holdId, status: 'RELEASED' };
}
async function preview(ctx: UniversityContext, input: Form) {
  const policyId = id.parse(input.policyId);
  await lock(ctx);
  const [review] = await ctx.db.$queryRaw<
    { id: string }[]
  >`INSERT INTO university_retention_reviews(organization_id,policy_id,created_by)
    SELECT organization_id,id,${ctx.userId} FROM university_active_retention_policies WHERE organization_id=${ctx.organizationId} AND id=${policyId} RETURNING id`;
  if (!review) throw new Error('Select the currently effective, approved policy.');
  const count = await ctx.db
    .$executeRaw`INSERT INTO university_retention_candidates(organization_id,review_id,target_key,reference_time)
    SELECT e.organization_id,${review.id},e.target_key,e.reference_time FROM university_retention_eligible e
    WHERE e.organization_id=${ctx.organizationId} AND e.policy_id=${policyId} AND NOT EXISTS(
      SELECT FROM university_retention_candidates c JOIN university_retention_reviews r ON (r.organization_id,r.id)=(c.organization_id,c.review_id)
      WHERE c.organization_id=e.organization_id AND r.policy_id=e.policy_id AND r.status IN ('PREVIEW','APPROVED') AND c.target_key=e.target_key)
    ORDER BY e.reference_time,e.target_key LIMIT 100`;
  if (!count) throw new Error('No eligible records are waiting for a new review.');
  return { reviewId: review.id, candidates: count, status: 'PREVIEW' };
}
async function approveReview(ctx: UniversityContext, input: Form) {
  const data = z.object({ reviewId: id, reference: text }).parse(input);
  await lock(ctx);
  const count = await ctx.db
    .$executeRaw`UPDATE university_retention_reviews r SET approved_by=${ctx.userId},approved_at=now(),approval_reference=${data.reference},status='APPROVED'
    FROM university_active_retention_policies p WHERE (p.organization_id,p.id)=(r.organization_id,r.policy_id)
      AND r.organization_id=${ctx.organizationId} AND r.id=${data.reviewId} AND r.status='PREVIEW' AND r.created_by<>${ctx.userId}`;
  ensureUpdated(
    count,
    'A second administrator must approve the preview under its effective policy.'
  );
  return { id: data.reviewId, status: 'APPROVED' };
}
async function discardReview(ctx: UniversityContext, input: Form) {
  const review = id.parse(input.reviewId);
  await lock(ctx);
  const count = await ctx.db
    .$executeRaw`UPDATE university_retention_reviews SET status='DISCARDED',finished_by=${ctx.userId},finished_at=now()
    WHERE organization_id=${ctx.organizationId} AND id=${review} AND status IN ('PREVIEW','APPROVED')`;
  ensureUpdated(count, 'Choose an open review.');
  return { id: review, status: 'DISCARDED' };
}

async function lockSources(ctx: UniversityContext, review: string, kind: Kind) {
  const org = ctx.organizationId;
  if (kind === 'APPLICATION_DOCUMENT' || kind === 'INCOMPLETE_UPLOAD') {
    // Academic decisions and portal uploads must finish before the eligibility recheck.
    await ctx.db
      .$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('university-academics:' || ${org},0))`;
    await ctx.db
      .$queryRaw`SELECT p.id FROM university_people p WHERE p.organization_id=${org} AND EXISTS (
      SELECT FROM university_documents d JOIN university_retention_candidates c ON c.organization_id=d.organization_id AND c.target_key=d.id
      WHERE (d.organization_id,d.person_id)=(p.organization_id,p.id) AND c.review_id=${review}) ORDER BY p.id FOR UPDATE`;
    await ctx.db
      .$queryRaw`SELECT d.id FROM university_documents d JOIN university_retention_candidates c ON c.organization_id=d.organization_id AND c.target_key=d.id
      WHERE d.organization_id=${org} AND c.review_id=${review} ORDER BY d.id FOR UPDATE OF d`;
  } else if (kind === 'EXPIRED_CHALLENGE') {
    await ctx.db
      .$queryRaw`SELECT s.id FROM university_portal_challenges s JOIN university_retention_candidates c ON c.organization_id=s.organization_id AND c.target_key=s.id
      WHERE s.organization_id=${org} AND c.review_id=${review} ORDER BY s.id FOR UPDATE OF s`;
  } else {
    await ctx.db
      .$queryRaw`SELECT s.token_hash FROM university_portal_sessions s JOIN university_retention_candidates c ON c.organization_id=s.organization_id AND c.target_key=s.token_hash
      WHERE s.organization_id=${org} AND c.review_id=${review} ORDER BY s.token_hash FOR UPDATE OF s`;
  }
}

async function purge(ctx: UniversityContext, input: Form) {
  const review = id.parse(input.reviewId);
  await lock(ctx);
  const [batch] = await ctx.db.$queryRaw<
    { status: string; kind: Kind }[]
  >`SELECT r.status,p.kind FROM university_retention_reviews r JOIN university_retention_policies p
    ON (p.organization_id,p.id)=(r.organization_id,r.policy_id) WHERE r.organization_id=${ctx.organizationId} AND r.id=${review} FOR UPDATE OF r`;
  if (batch?.status === 'PURGED') return { reviewId: review, status: 'PURGED' };
  if (batch?.status !== 'APPROVED')
    throw new Error('Choose a preview approved by an independent administrator.');
  await lockSources(ctx, review, batch.kind);
  const candidates = await ctx.db.$queryRaw<
    { id: string; target_key: string }[]
  >`SELECT c.id,c.target_key FROM university_retention_candidates c JOIN university_retention_reviews r
    ON (r.organization_id,r.id)=(c.organization_id,c.review_id) JOIN university_retention_eligible e
    ON (e.organization_id,e.target_key,e.policy_id,e.reference_time)=(c.organization_id,c.target_key,r.policy_id,c.reference_time)
    WHERE c.organization_id=${ctx.organizationId} AND c.review_id=${review} AND c.status='PENDING'`;
  const keys = JSON.stringify(candidates.map((c) => c.target_key));
  let removed = 0;
  if (
    candidates.length &&
    (batch.kind === 'APPLICATION_DOCUMENT' || batch.kind === 'INCOMPLETE_UPLOAD')
  ) {
    await ctx.db
      .$executeRaw`INSERT INTO university_retained_access_audit(organization_id,candidate_id,actor_id,actor_realm,read_at)
      SELECT a.organization_id,c.id,a.actor_id,a.actor_realm,a.read_at FROM university_document_reads a JOIN university_retention_candidates c
        ON (c.organization_id,c.target_key)=(a.organization_id,a.document_id) WHERE c.organization_id=${ctx.organizationId} AND c.review_id=${review}
        AND c.target_key IN (SELECT jsonb_array_elements_text(${keys}::jsonb))`;
    removed = await ctx.db
      .$executeRaw`DELETE FROM university_documents WHERE organization_id=${ctx.organizationId} AND id IN (SELECT jsonb_array_elements_text(${keys}::jsonb))`;
  } else if (candidates.length && batch.kind === 'EXPIRED_CHALLENGE') {
    removed = await ctx.db
      .$executeRaw`DELETE FROM university_portal_challenges WHERE organization_id=${ctx.organizationId} AND expires_at<=now()
      AND id IN (SELECT jsonb_array_elements_text(${keys}::jsonb))`;
  } else if (candidates.length) {
    removed = await ctx.db
      .$executeRaw`DELETE FROM university_portal_sessions WHERE organization_id=${ctx.organizationId} AND expires_at<=now()
      AND token_hash IN (SELECT jsonb_array_elements_text(${keys}::jsonb))`;
  }
  if (removed !== candidates.length)
    throw new Error('The records changed during cleanup. Retry the reviewed batch.');
  await ctx.db.$executeRaw`UPDATE university_retention_candidates SET status=CASE WHEN target_key IN
    (SELECT jsonb_array_elements_text(${keys}::jsonb)) THEN 'PURGED' ELSE 'SKIPPED' END
    WHERE organization_id=${ctx.organizationId} AND review_id=${review} AND status='PENDING'`;
  await ctx.db
    .$executeRaw`UPDATE university_retention_reviews SET status='PURGED',finished_at=now(),finished_by=${ctx.userId}
    WHERE organization_id=${ctx.organizationId} AND id=${review}`;
  return { reviewId: review, status: 'PURGED', purged: removed };
}

async function read(ctx: UniversityContext) {
  admin(ctx);
  const org = ctx.organizationId;
  const monitor = await ctx.db.$queryRaw<Row[]>`SELECT 'Operations' AS record,
    (SELECT count(DISTINCT t.token_id)::int FROM university_events e JOIN university_connector_topics t ON (t.organization_id,t.kind)=(e.organization_id,e.kind)
     WHERE e.organization_id=${org} AND e.status='FAILED') AS connectors_with_failures,
    (SELECT count(*)::int FROM university_events WHERE organization_id=${org} AND status='FAILED') AS failed_deliveries,
    (SELECT count(*)::int FROM university_events WHERE organization_id=${org} AND status='PENDING') AS pending_deliveries,
    (SELECT count(*)::int FROM university_events e WHERE e.organization_id=${org} AND e.status<>'ACKNOWLEDGED'
      AND NOT EXISTS(SELECT FROM university_connector_topics t WHERE (t.organization_id,t.kind)=(e.organization_id,e.kind))) AS unrouted_deliveries,
    (SELECT count(*)::int FROM university_documents WHERE organization_id=${org} AND NOT complete) AS incomplete_uploads`;
  const policies = await ctx.db.$queryRaw<
    Row[]
  >`SELECT 'Policy' AS record,p.id,p.kind,p.retain_days,p.effective_on::text,p.authority_reference,
    CASE WHEN live.id IS NOT NULL THEN 'EFFECTIVE' WHEN p.approved_at IS NULL THEN 'PROPOSED' WHEN p.effective_on>(now() AT TIME ZONE 'Asia/Karachi')::date THEN 'SCHEDULED' ELSE 'SUPERSEDED' END AS status
    FROM university_retention_policies p LEFT JOIN university_active_retention_policies live ON (live.organization_id,live.id)=(p.organization_id,p.id)
    WHERE p.organization_id=${org} ORDER BY p.effective_on DESC,p.kind LIMIT 100`;
  const holds = await ctx.db.$queryRaw<
    Row[]
  >`SELECT 'Legal hold' AS record,id,scope,created_at,released_at,authority_reference FROM university_retention_holds
    WHERE organization_id=${org} ORDER BY (released_at IS NULL) DESC,created_at DESC LIMIT 100`;
  const reviews = await ctx.db.$queryRaw<
    Row[]
  >`SELECT 'Review' AS record,r.id,r.status,p.kind,r.created_at,r.approval_reference,
    count(c.id)::int AS candidates,count(c.id) FILTER(WHERE c.status='PURGED')::int AS purged,count(c.id) FILTER(WHERE c.status='SKIPPED')::int AS skipped
    FROM university_retention_reviews r JOIN university_retention_policies p ON (p.organization_id,p.id)=(r.organization_id,r.policy_id)
    LEFT JOIN university_retention_candidates c ON (c.organization_id,c.review_id)=(r.organization_id,r.id)
    WHERE r.organization_id=${org} GROUP BY r.organization_id,r.id,p.kind ORDER BY r.created_at DESC LIMIT 100`;
  return [...monitor, ...policies, ...holds, ...reviews];
}
async function inspectReview(ctx: UniversityContext, input: Form) {
  admin(ctx);
  const review = id.parse(input.reviewId);
  return ctx.db.$queryRaw<Row[]>`SELECT c.id AS candidate_id,p.kind,c.reference_time,c.status,
    EXISTS(SELECT FROM university_retention_eligible eligible WHERE (eligible.organization_id,eligible.policy_id,eligible.target_key,eligible.reference_time)=(c.organization_id,p.id,c.target_key,c.reference_time)) AS currently_eligible
    FROM university_retention_candidates c JOIN university_retention_reviews r ON (r.organization_id,r.id)=(c.organization_id,c.review_id)
    JOIN university_retention_policies p ON (p.organization_id,p.id)=(r.organization_id,r.policy_id)
    WHERE c.organization_id=${ctx.organizationId} AND c.review_id=${review} ORDER BY c.reference_time,c.id`;
}
const field = (name: string, label: string, required = true) => ({ name, label, required });
const policyField = field('policyId', 'Policy ID'),
  reviewField = field('reviewId', 'Review ID');
const actions: UniversityAction[] = [
  {
    key: 'propose',
    label: 'Propose retention policy',
    fields: [
      { name: 'kind', label: 'Record category', type: 'select', options: kinds, required: true },
      {
        name: 'days',
        label: 'Retention days after the eligibility clock starts',
        type: 'number',
        required: true,
      },
      { name: 'effectiveOn', label: 'Effective date in Pakistan', type: 'date', required: true },
      field('authority', 'Institution policy or resolution reference'),
    ],
    run: propose,
  },
  {
    key: 'approve-policy',
    label: 'Approve institutional policy',
    fields: [policyField],
    run: approvePolicy,
  },
  {
    key: 'hold',
    label: 'Place legal hold',
    fields: [
      { name: 'scope', label: 'Hold coverage', type: 'select', options: scopes, required: true },
      field('target', 'Person, document or candidate ID (blank for institution)', false),
      field('authority', 'Legal hold reference'),
    ],
    run: createHold,
  },
  {
    key: 'release-hold',
    label: 'Release legal hold',
    fields: [field('holdId', 'Hold ID'), field('reference', 'Release authority reference')],
    run: releaseHold,
  },
  {
    key: 'preview',
    label: 'Preview up to 100 eligible records',
    fields: [policyField],
    run: preview,
  },
  {
    key: 'inspect-review',
    label: 'Inspect review candidates',
    fields: [reviewField],
    run: inspectReview,
  },
  {
    key: 'approve-review',
    label: 'Approve reviewed cleanup',
    fields: [reviewField, field('reference', 'Review approval reference')],
    run: approveReview,
  },
  { key: 'discard', label: 'Discard review', fields: [reviewField], run: discardReview },
  {
    key: 'purge',
    label: 'Permanently purge approved records',
    confirmation: 'I confirm permanent deletion of the eligible records in this approved review.',
    fields: [reviewField],
    run: purge,
  },
];
export const retentionOffice: UniversityOffice = {
  title: 'Retention and operations',
  description:
    'Review integration health, institutional retention decisions, legal holds and approved cleanup batches.',
  moduleKey: 'university-core',
  roles: adminRoles,
  actions,
  read,
};

import 'server-only';

import { createHash } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const INSPECTION_PACK_SECTIONS = [
  ['licence-qualified-person-coverage', 'pharmacy_branch_regulatory_profiles', 'createdAt'],
  ['supplier-warranties', 'pharmacy_supplier_licences', 'createdAt'],
  ['purchases', 'pharmacy_purchase_orders', 'createdAt'],
  ['batches', 'pharmacy_manufacturing_batches', 'createdAt'],
  ['controlled-register', 'pharmacy_controlled_register_entries', 'createdAt'],
  ['sales-fiscal', 'pharmacy_sales', 'createdAt'],
  ['returns', 'pharmacy_sale_returns', 'createdAt'],
  ['recalls', 'pharmacy_recall_notices', 'createdAt'],
  ['audit', 'audit_logs', 'createdAt'],
] as const;

type JsonRecord = Record<string, unknown>;
export type InspectionSectionInput = { name: string; records: readonly JsonRecord[] };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as JsonRecord)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

export function buildInspectionManifest(input: {
  branchId: string;
  from: Date;
  to: Date;
  sections: readonly InspectionSectionInput[];
}) {
  const files = [...input.sections]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((section) => {
      const records = [...section.records].sort((a, b) => canonical(a).localeCompare(canonical(b)));
      const content = canonical(records);
      return {
        path: `${section.name}.json`,
        mediaType: 'application/json',
        recordCount: records.length,
        sha256: sha256(content),
        content,
      };
    });
  const manifest = {
    schemaVersion: 1,
    branchId: input.branchId,
    range: { from: input.from.toISOString(), to: input.to.toISOString() },
    files,
  };
  return { ...manifest, manifestSha256: sha256(canonical(manifest)) };
}

/**
 * DEV-829: the inspection pack's audit section. A branch-scoped safety grant
 * must not read the organization's administrative audit log, so this exports
 * only pharmacy regulatory events tied to the authorized branch — either aimed
 * at the branch itself or carrying it as `metadata.branchId`. Events without a
 * branch (organization-wide or administrative) are excluded; the full log stays
 * behind the admin-only audit listing. The projection names the actor and the
 * event, never request payloads, diffs, results, metadata, contact details,
 * network context, tokens or error text.
 */
export const INSPECTION_PACK_AUDIT_QUERY = `SELECT jsonb_build_object(
  'id', a."id",
  'createdAt', a."createdAt",
  'category', a."category",
  'operation', a."operation",
  'action', a."action",
  'targetType', a."targetType",
  'targetId', a."targetId",
  'outcome', a."outcome",
  'actorType', a."actorType",
  'actorName', a."actorName",
  'actorRole', a."actorRole"
) AS record
FROM "audit_logs" a
WHERE a."createdAt" >= $1 AND a."createdAt" <= $2
  AND a."category" LIKE 'PHARMACY%'
  AND (
    (a."targetType" = 'PharmacyBranch' AND a."targetId" = $3)
    OR a."metadata"->>'branchId' = $3
  )
ORDER BY a."createdAt", a."id"`;

export async function createInspectionPack(
  db: ScopedDb,
  input: { branchId: string; from: Date; to: Date }
) {
  const sections: InspectionSectionInput[] = [];
  for (const [name, table, timestamp] of INSPECTION_PACK_SECTIONS) {
    if (table === 'audit_logs') {
      // DEV-829: never the raw organization audit log — only this branch's
      // pharmacy regulatory events, as a minimal projection.
      const rows = await db.$queryRawUnsafe<{ record: JsonRecord }[]>(
        INSPECTION_PACK_AUDIT_QUERY,
        input.from,
        input.to,
        input.branchId
      );
      sections.push({ name, records: rows.map((row) => row.record) });
      continue;
    }
    const query =
      name === 'controlled-register'
        ? `SELECT (to_jsonb(t) - 'organizationId' - 'witnessedByUserId') || jsonb_build_object('witnessName', w."name") AS record FROM "${table}" t LEFT JOIN "users" w ON w."id" = t."witnessedByUserId" AND w."organizationId" = t."organizationId" WHERE t."${timestamp}" >= $1 AND t."${timestamp}" <= $2 AND (to_jsonb(t)->>'branchId' IS NULL OR to_jsonb(t)->>'branchId' = $3) ORDER BY t."${timestamp}", t."id"`
        : `SELECT to_jsonb(t) - 'organizationId' AS record FROM "${table}" t WHERE "${timestamp}" >= $1 AND "${timestamp}" <= $2 AND (to_jsonb(t)->>'branchId' IS NULL OR to_jsonb(t)->>'branchId' = $3) ORDER BY "${timestamp}", "id"`;
    const records = await db.$queryRawUnsafe<JsonRecord[]>(
      query,
      input.from,
      input.to,
      input.branchId
    );
    sections.push({ name, records: records.map((row) => row.record as JsonRecord) });
  }
  sections.push({
    name: INSPECTION_PACK_SOP_SECTION,
    records: await sopOccurrenceInspectionRecords(db, input),
  });
  return buildInspectionManifest({ ...input, sections });
}

/** DEV-751: SOP occurrences run at the pharmacy branch's SOP site. */
export const INSPECTION_PACK_SOP_SECTION = 'sop-occurrences';

/**
 * One record per SOP occurrence due in range at this pharmacy branch's SOP site,
 * with its steps, evidence references, verification decisions, pharmacy
 * record links and rework notes (what the worker said they changed after each
 * send-back). People appear by display name, not id. Evidence carries its
 * content hash, type, size and capture time only — never the storage location.
 * A branch without an SOP site yields no rows. Nested arrays are ordered so the
 * section hash is reproducible.
 */
export const SOP_OCCURRENCE_INSPECTION_QUERY = `SELECT jsonb_build_object(
  'occurrenceId', o."id",
  'template', tpl."name",
  'templateVersion', v."versionNumber",
  'businessDate', o."businessDate",
  'status', o."status",
  'dueAt', o."dueAt",
  'windowEndsAt', o."windowEndsAt",
  'startedAt', o."startedAt",
  'submittedAt', o."submittedAt",
  'resolvedAt', o."resolvedAt",
  'assignedTo', assignee."displayName",
  'claimedBy', claimer."displayName",
  'steps', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'stepOrder', ts."stepOrder",
      'title', ts."title",
      'completed', st."completed",
      'completedAt', st."completedAt",
      'completedBy', completer."displayName",
      'note', st."note"
    ) ORDER BY ts."stepOrder", st."id")
    FROM "restaurant_sop_occurrence_steps" st
    JOIN "restaurant_sop_template_steps" ts ON ts."id" = st."templateStepId"
    LEFT JOIN "restaurant_staff_profiles" completer
      ON completer."id" = st."completedByStaffProfileId" AND completer."organizationId" = st."organizationId"
    WHERE st."occurrenceId" = o."id" AND st."organizationId" = o."organizationId"
  ), '[]'::jsonb),
  'evidence', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'stepOrder', ets."stepOrder",
      'contentHash', e."contentHash",
      'mimeType', e."mimeType",
      'sizeBytes', e."sizeBytes",
      'capturedAt', e."capturedAt",
      'uploadedBy', uploader."displayName"
    ) ORDER BY e."capturedAt", e."id")
    FROM "restaurant_sop_evidence" e
    LEFT JOIN "restaurant_sop_occurrence_steps" est ON est."id" = e."occurrenceStepId"
    LEFT JOIN "restaurant_sop_template_steps" ets ON ets."id" = est."templateStepId"
    LEFT JOIN "restaurant_staff_profiles" uploader
      ON uploader."id" = e."uploaderStaffProfileId" AND uploader."organizationId" = e."organizationId"
    WHERE e."occurrenceId" = o."id" AND e."organizationId" = o."organizationId"
  ), '[]'::jsonb),
  'verifications', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'action', vf."action",
      'reason', vf."reason",
      'createdAt', vf."createdAt",
      'actor', verifier."displayName"
    ) ORDER BY vf."createdAt", vf."id")
    FROM "restaurant_sop_verifications" vf
    LEFT JOIN "restaurant_staff_profiles" verifier
      ON verifier."id" = vf."actorStaffProfileId" AND verifier."organizationId" = vf."organizationId"
    WHERE vf."occurrenceId" = o."id" AND vf."organizationId" = o."organizationId"
  ), '[]'::jsonb),
  'recordLinks', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'stepOrder', lts."stepOrder",
      'recordType', l."recordType",
      'recordId', l."recordId",
      'note', l."note",
      'createdAt', l."createdAt",
      'linkedBy', linker."displayName"
    ) ORDER BY l."createdAt", l."id")
    FROM "pharmacy_sop_record_links" l
    LEFT JOIN "restaurant_sop_occurrence_steps" lst ON lst."id" = l."occurrenceStepId"
    LEFT JOIN "restaurant_sop_template_steps" lts ON lts."id" = lst."templateStepId"
    LEFT JOIN "restaurant_staff_profiles" linker
      ON linker."id" = l."linkedByStaffProfileId" AND linker."organizationId" = l."organizationId"
    WHERE l."occurrenceId" = o."id" AND l."organizationId" = o."organizationId"
      AND l."pharmacyBranchId" = site."pharmacyBranchId"
  ), '[]'::jsonb),
  'reworkNotes', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'stepOrder', rts."stepOrder",
      'note', rn."note",
      'createdAt', rn."createdAt",
      'sentBackAt', rv."createdAt",
      'author', author."displayName"
    ) ORDER BY rn."createdAt", rn."id")
    FROM "pharmacy_sop_rework_notes" rn
    LEFT JOIN "restaurant_sop_verifications" rv
      ON rv."id" = rn."rejectionVerificationId" AND rv."organizationId" = rn."organizationId"
    LEFT JOIN "restaurant_sop_occurrence_steps" rst
      ON rst."id" = rn."occurrenceStepId" AND rst."organizationId" = rn."organizationId"
    LEFT JOIN "restaurant_sop_template_steps" rts ON rts."id" = rst."templateStepId"
    LEFT JOIN "restaurant_staff_profiles" author
      ON author."id" = rn."authorStaffProfileId" AND author."organizationId" = rn."organizationId"
    WHERE rn."occurrenceId" = o."id" AND rn."organizationId" = o."organizationId"
      AND rn."pharmacyBranchId" = site."pharmacyBranchId"
  ), '[]'::jsonb)
) AS record
FROM "pharmacy_sop_sites" site
JOIN "restaurant_sop_occurrences" o
  ON o."organizationId" = site."organizationId" AND o."branchId" = site."sopBranchId"
JOIN "restaurant_sop_template_versions" v ON v."id" = o."templateVersionId"
JOIN "restaurant_sop_templates" tpl ON tpl."id" = v."templateId"
LEFT JOIN "restaurant_staff_profiles" assignee
  ON assignee."id" = o."assignedStaffProfileId" AND assignee."organizationId" = o."organizationId"
LEFT JOIN "restaurant_staff_profiles" claimer
  ON claimer."id" = o."claimedByStaffProfileId" AND claimer."organizationId" = o."organizationId"
WHERE site."pharmacyBranchId" = $3 AND o."dueAt" >= $1 AND o."dueAt" <= $2
ORDER BY o."dueAt", o."id"`;

export async function sopOccurrenceInspectionRecords(
  db: ScopedDb,
  input: { branchId: string; from: Date; to: Date }
): Promise<JsonRecord[]> {
  const rows = await db.$queryRawUnsafe<{ record: JsonRecord }[]>(
    SOP_OCCURRENCE_INSPECTION_QUERY,
    input.from,
    input.to,
    input.branchId
  );
  return rows.map((row) => row.record);
}

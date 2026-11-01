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

export async function createInspectionPack(
  db: ScopedDb,
  input: { branchId: string; from: Date; to: Date }
) {
  const sections: InspectionSectionInput[] = [];
  for (const [name, table, timestamp] of INSPECTION_PACK_SECTIONS) {
    const branchPredicate =
      table === 'audit_logs'
        ? ''
        : "AND (to_jsonb(t)->>'branchId' IS NULL OR to_jsonb(t)->>'branchId' = $3)";
    const query =
      name === 'controlled-register'
        ? `SELECT (to_jsonb(t) - 'organizationId' - 'witnessedByUserId') || jsonb_build_object('witnessName', w."name") AS record FROM "${table}" t LEFT JOIN "users" w ON w."id" = t."witnessedByUserId" AND w."organizationId" = t."organizationId" WHERE t."${timestamp}" >= $1 AND t."${timestamp}" <= $2 AND (to_jsonb(t)->>'branchId' IS NULL OR to_jsonb(t)->>'branchId' = $3) ORDER BY t."${timestamp}", t."id"`
        : `SELECT to_jsonb(t) - 'organizationId' AS record FROM "${table}" t WHERE "${timestamp}" >= $1 AND "${timestamp}" <= $2 ${branchPredicate} ORDER BY "${timestamp}", "id"`;
    const records =
      table === 'audit_logs'
        ? await db.$queryRawUnsafe<JsonRecord[]>(query, input.from, input.to)
        : await db.$queryRawUnsafe<JsonRecord[]>(query, input.from, input.to, input.branchId);
    sections.push({ name, records: records.map((row) => row.record as JsonRecord) });
  }
  return buildInspectionManifest({ ...input, sections });
}

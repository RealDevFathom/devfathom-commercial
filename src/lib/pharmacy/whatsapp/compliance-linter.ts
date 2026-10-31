import 'server-only';

import { randomUUID } from 'node:crypto';
import { type ScopedDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { afterTenantTransaction } from '@/lib/side-effects/scope';

export const WHATSAPP_COMPLIANCE_LINTER_VERSION = '2026-10-29.2';

export type ComplianceOutcome = 'BLOCK' | 'WARN' | 'PASS';
export type ComplianceReason = {
  code: 'REGULATED_TERM' | 'UTILITY_PROMOTION';
  term: string;
  source: 'STATIC' | 'CATALOG';
};

export type ComplianceCatalog = { terms: string[] };

// Meta/DRAP-safe fail-closed categories. Catalog values add branch-specific brands,
// salts, aliases, misspellings, and Urdu/transliterated names at runtime.
const STATIC_REGULATED_TERMS = [
  'drug',
  'medicine',
  'medication',
  'pharmaceutical',
  'tablet',
  'capsule',
  'syrup',
  'antibiotic',
  'painkiller',
  'دوا',
  'گولی',
  'dawai',
  'dawa',
  'goli',
  'drugs',
  'medicines',
  'medications',
  'pharmaceuticals',
  'tablets',
  'capsules',
  'syrups',
  'antibiotics',
  'painkillers',
  'دوائیں',
  'دوائیاں',
  'گولیاں',
  'dawaiyan',
  'dawaian',
  'goliyan',
  'golian',
] as const;

const PROMOTIONAL_TERMS = [
  'discount',
  'sale',
  'offer',
  'save',
  'free',
  'buy now',
  'limited time',
] as const;

function normalized(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[\p{P}\p{S}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsTerm(text: string, term: string) {
  const haystack = ` ${normalized(text)} `;
  const needle = normalized(term);
  return needle.length >= 2 && haystack.includes(` ${needle} `);
}

function catalogNameTerms(value: string) {
  // Keep the full catalog value, and also recognize the name without a strength
  // suffix when optional brand/alias metadata has not been populated.
  const name = value.normalize('NFKC');
  const strength =
    /\s+\d+(?:[.,]\d+)?\s*(?:mcg|mg|kg|g|ml|l|iu|units?|%|[µμ]g)(?=$|[^\p{L}])/iu.exec(name);
  return strength ? [name, name.slice(0, strength.index)] : [name];
}

export function lintWhatsAppContent(input: {
  templateText: string;
  variables?: readonly string[];
  intent: 'UTILITY' | 'MARKETING';
  catalog?: ComplianceCatalog;
}) {
  const content = [input.templateText, ...(input.variables ?? [])].join(' ');
  const catalogTerms = Array.from(
    new Set((input.catalog?.terms ?? []).flatMap(catalogNameTerms).map(normalized).filter(Boolean))
  );
  const regulated = [
    ...STATIC_REGULATED_TERMS.map((term) => ({ term, source: 'STATIC' as const })),
    ...catalogTerms.map((term) => ({ term, source: 'CATALOG' as const })),
  ].find(({ term }) => containsTerm(content, term));
  const reasons: ComplianceReason[] = regulated
    ? [{ code: 'REGULATED_TERM', term: regulated.term, source: regulated.source }]
    : [];
  if (!regulated && input.intent === 'UTILITY') {
    const promotional = PROMOTIONAL_TERMS.find((term) => containsTerm(content, term));
    if (promotional)
      reasons.push({ code: 'UTILITY_PROMOTION', term: promotional, source: 'STATIC' });
  }
  return {
    outcome: (regulated ? 'BLOCK' : reasons.length ? 'WARN' : 'PASS') as ComplianceOutcome,
    reasons,
    version: WHATSAPP_COMPLIANCE_LINTER_VERSION,
  };
}

/** Organization catalog is deliberately broader than current stock: stale/off-branch drug names must not leak. */
export async function readComplianceCatalog(db: ScopedDb, organizationId: string) {
  const medicines = await db.medicine.findMany({
    where: { organizationId, productFamily: { not: 'FRONT_SHOP' } },
    select: {
      productName: true,
      brandName: true,
      aliases: { select: { value: true } },
      strengths: { select: { ingredient: { select: { name: true } } } },
    },
  });
  return {
    terms: medicines.flatMap((medicine) => [
      medicine.productName,
      medicine.brandName ?? '',
      ...medicine.aliases.map((alias) => alias.value),
      ...medicine.strengths.map((strength) => strength.ingredient.name),
    ]),
  };
}

export async function lintAndLogWhatsAppContent(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId?: string },
  input: {
    templateText: string;
    variables?: readonly string[];
    intent: 'UTILITY' | 'MARKETING';
    subject: string;
  },
  options: { retainBlockedDecision?: boolean } = {}
) {
  const result = lintWhatsAppContent({
    ...input,
    catalog: await readComplianceCatalog(db, scope.organizationId),
  });
  const log = {
    id: randomUUID(),
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    actorId: scope.actorId ?? null,
    subject: input.subject,
    intent: input.intent,
    outcome: result.outcome,
    reasons: result.reasons,
    linterVersion: result.version,
    createdAt: new Date(),
  };
  await db.pharmacyWhatsAppComplianceLog.create({ data: log });
  if (result.outcome === 'BLOCK' && options.retainBlockedDecision) {
    // The first insert enforces the caller's current tenant/branch RLS. After
    // its transaction ends, retain that same decision even if rejection rolled
    // it back. A stable id avoids duplicates if the caller committed instead.
    await afterTenantTransaction(() =>
      withTenantDb(
        scope.organizationId,
        async (evidenceDb) => {
          await evidenceDb.$queryRawUnsafe(
            "SELECT set_config('app.current_branch_id', $1, true)",
            scope.branchId
          );
          await evidenceDb.pharmacyWhatsAppComplianceLog.createMany({
            data: [log],
            skipDuplicates: true,
          });
        },
        { userId: scope.actorId, skipDrain: true }
      )
    );
  }
  return result;
}

import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { hasModule } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';

export type ImportedStockQuery = { q?: string | string[]; page?: string | string[] };
const PAGE_SIZE = 50;
const SOURCE_DECIMAL = '^[[:space:]]*[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)[[:space:]]*$';

/** Validate the reference, but return its exact text, including decimal precision. */
export function originalCount(value: unknown): string | null {
  return typeof value === 'string' && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value.trim())
    ? value
    : null;
}

type ImportedRow = {
  id: string;
  sourceId: string;
  batchId: string;
  rowNumber: number;
  productName: string | null;
  originalQty: string | null;
  originalPackQty: string | null;
  originalPackUnits: string | null;
};

export async function readImportedStock(query: ImportedStockQuery) {
  const actor = await resolveTenantActor();
  const user = actor?.session.user;
  if (
    !actor ||
    !user?.id ||
    user.organizationId !== actor.organization.id ||
    !evaluateSessionUser(user).ok
  )
    return null;

  // Reuse Inventory's active-session + licensed-module read permission. The
  // context factory only reads; calling its audited router would write an audit.
  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  const organizationId = actor.organization.id;
  if (
    ctx.organization?.id !== organizationId ||
    ctx.session?.user?.id !== user.id ||
    ctx.session.user.organizationId !== organizationId ||
    ctx.entitlements.organizationId !== organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-inventory')
  )
    return null;

  const search = typeof query.q === 'string' ? query.q.trim().slice(0, 160) : '';
  const requestedPage =
    typeof query.page === 'string' && /^[1-9][0-9]{0,8}$/.test(query.page) ? Number(query.page) : 1;
  // Prisma cannot project individual JSON keys with select. Parameterized SQL
  // keeps all other source columns outside the query result, even for admins.
  const source = Prisma.sql`
    FROM pharmacy_migration_rows r
    JOIN pharmacy_migration_batches b
      ON b.id = r."batchId" AND b."organizationId" = r."organizationId"
    WHERE r."organizationId" = ${organizationId}
      AND b."organizationId" = ${organizationId}
      AND b.status = 'PROFILED' AND r."targetModelKey" = 'med.product'
  `;
  const matches = Prisma.sql`strpos(lower(coalesce(r."productName", '')), lower(${search})) > 0`;
  const [totals] = await ctx.db.$queryRaw<
    {
      importedRows: number;
      reportedStockRows: number;
      matchingRows: number;
    }[]
  >(Prisma.sql`
    SELECT count(*)::int AS "importedRows",
      count(*) FILTER (WHERE jsonb_typeof(r."rawPayload"->'QTY') = 'string'
        AND r."rawPayload"->>'QTY' ~ ${SOURCE_DECIMAL}
        AND r."rawPayload"->>'QTY' !~ '^[[:space:]]*-'
        AND r."rawPayload"->>'QTY' ~ '[1-9]')::int AS "reportedStockRows",
      count(*) FILTER (WHERE ${matches})::int AS "matchingRows"
    ${source}
  `);
  // Count rows with positive source QTY using its digits/sign, never a numeric
  // cast, rounding, pack multiplication, or conversion into sellable units.
  const pages = Math.max(1, Math.ceil(totals.matchingRows / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const rows = await ctx.db.$queryRaw<ImportedRow[]>(Prisma.sql`
    SELECT r.id, b."sourceId", r."batchId", r."rowNumber", r."productName",
      CASE WHEN jsonb_typeof(r."rawPayload"->'QTY') = 'string'
        THEN r."rawPayload"->>'QTY' END AS "originalQty",
      CASE WHEN jsonb_typeof(r."rawPayload"->'PackQty') = 'string'
        THEN r."rawPayload"->>'PackQty' END AS "originalPackQty",
      CASE WHEN jsonb_typeof(r."rawPayload"->'PackUnits') = 'string'
        THEN r."rawPayload"->>'PackUnits' END AS "originalPackUnits"
    ${source} AND ${matches}
    ORDER BY r."batchId", r."rowNumber", r.id
    LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
  `);
  return {
    ...totals,
    search,
    page,
    pages,
    pageSize: PAGE_SIZE,
    rows: rows.map((row) => ({
      ...row,
      originalQty: originalCount(row.originalQty),
      originalPackQty: originalCount(row.originalPackQty),
      originalPackUnits: originalCount(row.originalPackUnits),
    })),
  };
}

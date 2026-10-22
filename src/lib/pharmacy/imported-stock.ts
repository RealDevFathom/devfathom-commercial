import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { hasModule } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';
import { importBranchIds, inImportTransaction } from './migration/import-authority';

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
  // Import 1/5: the PH-MIG tables are forced-RLS on organization AND branch, so each branch the
  // reader may see (every active branch for an admin, otherwise their assignments) is read under
  // its own binding inside one transaction, and the pages are merged in the same global order.
  const branches = await importBranchIds(ctx.db, {
    organizationId,
    actor: { userId: user.id, role: user.role },
  });
  // Prisma cannot project individual JSON keys with select. Parameterized SQL
  // keeps all other source columns outside the query result, even for admins.
  const source = (branchId: string) => Prisma.sql`
    FROM pharmacy_migration_rows r
    JOIN pharmacy_migration_batches b
      ON b.id = r."batchId" AND b."organizationId" = r."organizationId"
    WHERE r."organizationId" = ${organizationId}
      AND b."organizationId" = ${organizationId}
      AND r."branchId" = ${branchId} AND b."branchId" = ${branchId}
      AND b.status = 'PREVIEW' AND r."targetModelKey" = 'med.product'
  `;
  const matches = Prisma.sql`strpos(lower(coalesce(r."productName", '')), lower(${search})) > 0`;
  const read = await inImportTransaction(ctx.db, async (tx) => {
    const bind = (branchId: string) =>
      tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`);
    const sums = { importedRows: 0, reportedStockRows: 0, matchingRows: 0 };
    for (const branchId of branches) {
      await bind(branchId);
      const [counted] = await tx.$queryRaw<
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
        ${source(branchId)}
      `);
      sums.importedRows += counted.importedRows;
      sums.reportedStockRows += counted.reportedStockRows;
      sums.matchingRows += counted.matchingRows;
    }
    // Count rows with positive source QTY using its digits/sign, never a numeric
    // cast, rounding, pack multiplication, or conversion into sellable units.
    const pages = Math.max(1, Math.ceil(sums.matchingRows / PAGE_SIZE));
    const page = Math.min(requestedPage, pages);
    const window = page * PAGE_SIZE;
    const candidates: ImportedRow[] = [];
    for (const branchId of branches) {
      await bind(branchId);
      candidates.push(
        ...(await tx.$queryRaw<ImportedRow[]>(Prisma.sql`
          SELECT r.id, b."sourceId", r."batchId", r."rowNumber", r."productName",
            CASE WHEN jsonb_typeof(r."rawPayload"->'QTY') = 'string'
              THEN r."rawPayload"->>'QTY' END AS "originalQty",
            CASE WHEN jsonb_typeof(r."rawPayload"->'PackQty') = 'string'
              THEN r."rawPayload"->>'PackQty' END AS "originalPackQty",
            CASE WHEN jsonb_typeof(r."rawPayload"->'PackUnits') = 'string'
              THEN r."rawPayload"->>'PackUnits' END AS "originalPackUnits"
          ${source(branchId)} AND ${matches}
          ORDER BY r."batchId", r."rowNumber", r.id
          LIMIT ${window}
        `))
      );
    }
    // A batch belongs to one branch, so (batchId, rowNumber, id) is one global order.
    candidates.sort(
      (a, b) =>
        (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0) ||
        a.rowNumber - b.rowNumber ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return {
      totals: sums,
      page,
      pages,
      rows: candidates.slice((page - 1) * PAGE_SIZE, window),
    };
  });
  const { totals, page, pages, rows } = read;
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

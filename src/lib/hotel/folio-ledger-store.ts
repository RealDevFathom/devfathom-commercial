import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { HOTEL_FOLIO_CAPABILITY } from './folio-security';
import {
  createFolioLedgerService,
  type CatalogPrice,
  type FolioLedgerStore,
  type FolioScope,
} from './folio-ledger';

export type FolioLedgerRow = Readonly<Record<string, unknown>>;

/** The deliberately small surface also accepts an elevated Prisma handle. */
export interface FolioSqlClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

export function createPrismaFolioLedgerStore(
  db: FolioSqlClient,
  actorId: string
): FolioLedgerStore<FolioLedgerRow> {
  return {
    async read(scope, folioId) {
      const rows = await db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        SELECT * FROM hotel_folios
        WHERE id = ${folioId}
          AND "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}
        LIMIT 1`);
      return rows[0] ?? null;
    },
    readEntries(scope, folioId) {
      return db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        SELECT * FROM hotel_folio_entries
        WHERE "folioId" = ${folioId}
          AND "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}
        ORDER BY "createdAt", id`);
    },
    async catalogPrice(scope, catalogItemId) {
      const rows = await db.$queryRaw<CatalogPrice[]>(Prisma.sql`
        SELECT "priceMinor" AS "unitMinor",
          COALESCE(("postingRule"->>'taxBasisPoints')::integer, 0) AS "taxBasisPoints"
        FROM hotel_extras
        WHERE id = ${catalogItemId}
          AND "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}
          AND active = true
        LIMIT 1`);
      return rows[0] ?? null;
    },
    async insert(scope, posting) {
      const rows = await db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        INSERT INTO hotel_folio_entries
          (id, "organizationId", "branchId", "folioId", "catalogItemId", quantity,
           "unitMinor", "netMinor", "taxMinor", "grossMinor", "createdBy")
        SELECT ${randomUUID()}, f."organizationId", f."branchId", f.id, e.id,
          ${posting.quantity}, ${posting.unitMinor}, ${posting.netMinor},
          ${posting.taxMinor}, ${posting.grossMinor}, ${actorId}
        FROM hotel_folios f
        JOIN hotel_extras e
          ON e.id = ${posting.catalogItemId}
         AND e."organizationId" = ${scope.organizationId}
         AND e."branchId" = ${scope.branchId}
        WHERE f.id = ${posting.folioId}
          AND f."organizationId" = ${scope.organizationId}
          AND f."branchId" = ${scope.branchId}
        RETURNING hotel_folio_entries.*`);
      if (!rows[0]) throw new Error('Folio or catalog item is unavailable for this property.');
      return rows[0];
    },
    async reverse(scope, entryId, reason) {
      const rows = await db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        SELECT reverse_hotel_folio_entry(
          ${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, id, ${reason}, ${actorId}
        ) AS entry
        FROM hotel_folio_entries
        WHERE id = ${entryId}
          AND "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}`);
      if (!rows[0]) throw new Error('Folio entry is unavailable for this property.');
      return rows[0];
    },
  };
}

export type FolioPrincipal = Readonly<{
  id: string;
  capabilities: ReadonlySet<string>;
}>;

/** Production composition: authorization is not a caller-supplied callback. */
export function createProductionFolioLedgerService(db: FolioSqlClient, principal: FolioPrincipal) {
  const requireFolio = async (_scope: FolioScope) => {
    if (!principal.capabilities.has(HOTEL_FOLIO_CAPABILITY))
      throw new Error(`Missing capability: ${HOTEL_FOLIO_CAPABILITY}`);
  };
  return createFolioLedgerService(createPrismaFolioLedgerStore(db, principal.id), requireFolio);
}

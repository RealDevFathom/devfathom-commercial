import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { CatalogPrice, FolioLedgerStore } from './folio-ledger';

export type FolioLedgerRow = Readonly<Record<string, unknown>>;

/** The deliberately small surface the ledger needs from a Prisma client or transaction. */
export interface FolioSqlClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * The single folio ledger (`hotel_folio_entries`). Every statement carries both
 * tenant keys, so the store stays property-safe even on an elevated handle.
 * Amounts are server-derived snapshots; a reversal is a positive copy naming
 * the original (the database refuses anything else and a second reversal).
 */
export function createPrismaFolioLedgerStore(
  db: FolioSqlClient,
  actorId: string
): FolioLedgerStore<FolioLedgerRow> {
  return {
    async read(scope, folioId) {
      const rows = await db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        SELECT id, "reservationId", "folioNumber", status::text AS status, currency, version, "createdAt"
        FROM hotel_folios
        WHERE id = ${folioId}
          AND "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}
        LIMIT 1`);
      return rows[0] ?? null;
    },
    readEntries(scope, folioId) {
      return db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        SELECT id, kind::text AS kind, "catalogItemId", "serviceDate", description, quantity,
          "unitMinor", "netMinor", "taxMinor", "grossMinor", currency, "reversesEntryId", reason,
          "createdById", "createdAt"
        FROM hotel_folio_entries
        WHERE "folioId" = ${folioId}
          AND "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}
        ORDER BY "createdAt", id`);
    },
    async catalogPrice(scope, catalogItemId) {
      const rows = await db.$queryRaw<CatalogPrice[]>(Prisma.sql`
        SELECT "priceMinor" AS "unitMinor",
          -- An absent rate is no tax; anything but a plain whole number is
          -- reported as -1 so the service refuses it as an invalid rate
          -- instead of the cast failing the statement.
          CASE
            WHEN "postingRule"->'taxBasisPoints' IS NULL THEN 0
            WHEN jsonb_typeof("postingRule"->'taxBasisPoints') = 'number'
              AND ("postingRule"->>'taxBasisPoints') ~ '^[0-9]{1,9}$'
              THEN ("postingRule"->>'taxBasisPoints')::integer
            ELSE -1
          END AS "taxBasisPoints"
        FROM hotel_extras
        WHERE id = ${catalogItemId}
          AND "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}
          AND active = true
        LIMIT 1`);
      return rows[0] ?? null;
    },
    async insert(scope, posting) {
      // Catalog prices are in the property's currency, so an extra can only be
      // posted to an open folio held in that currency.
      const rows = await db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        INSERT INTO hotel_folio_entries
          (id, "organizationId", "branchId", "folioId", kind, "catalogItemId", description, quantity,
           "unitMinor", "netMinor", "taxMinor", "grossMinor", currency, "createdById")
        SELECT ${randomUUID()}, f."organizationId", f."branchId", f.id, 'EXTRA'::"HotelFolioEntryKind",
          e.id, e.name, ${posting.quantity}, ${BigInt(posting.unitMinor)}, ${BigInt(posting.netMinor)},
          ${BigInt(posting.taxMinor)}, ${BigInt(posting.grossMinor)}, f.currency, ${actorId}
        FROM hotel_folios f
        JOIN hotel_properties p
          ON p."organizationId" = f."organizationId"
         AND p."branchId" = f."branchId"
         AND p.currency = f.currency
        JOIN hotel_extras e
          ON e.id = ${posting.catalogItemId}
         AND e."organizationId" = ${scope.organizationId}
         AND e."branchId" = ${scope.branchId}
         AND e.active = true
        WHERE f.id = ${posting.folioId}
          AND f."organizationId" = ${scope.organizationId}
          AND f."branchId" = ${scope.branchId}
          AND f.status = 'OPEN'
        RETURNING id, kind::text AS kind, "catalogItemId", description, quantity, "unitMinor",
          "netMinor", "taxMinor", "grossMinor", currency, "createdAt"`);
      if (!rows[0]) throw new Error('Folio or catalog item is unavailable for this property.');
      return rows[0];
    },
    async reverse(scope, entryId, reason) {
      // Only an open folio's balance may move: a closed folio is settled.
      const rows = await db.$queryRaw<FolioLedgerRow[]>(Prisma.sql`
        INSERT INTO hotel_folio_entries
          (id, "organizationId", "branchId", "folioId", kind, "catalogItemId", "serviceDate",
           description, quantity, "unitMinor", "netMinor", "taxMinor", "grossMinor", currency,
           "reversesEntryId", reason, "createdById")
        SELECT ${randomUUID()}, e."organizationId", e."branchId", e."folioId", e.kind, e."catalogItemId",
          e."serviceDate", e.description, e.quantity, e."unitMinor", e."netMinor", e."taxMinor",
          e."grossMinor", e.currency, e.id, ${reason}, ${actorId}
        FROM hotel_folio_entries e
        JOIN hotel_folios f
          ON f."organizationId" = e."organizationId"
         AND f."branchId" = e."branchId"
         AND f.id = e."folioId"
        WHERE e.id = ${entryId}
          AND e."organizationId" = ${scope.organizationId}
          AND e."branchId" = ${scope.branchId}
          AND e."reversesEntryId" IS NULL
          AND f.status = 'OPEN'
        RETURNING id, kind::text AS kind, "reversesEntryId", reason, "grossMinor", currency, "createdAt"`);
      if (!rows[0]) throw new Error('Folio entry is unavailable on an open folio of this property.');
      return rows[0];
    },
  };
}

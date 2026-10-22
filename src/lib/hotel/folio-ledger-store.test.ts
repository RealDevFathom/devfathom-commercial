import { describe, expect, it, vi } from 'vitest';

import {
  createPrismaFolioLedgerStore,
  createProductionFolioLedgerService,
  type FolioSqlClient,
} from './folio-ledger-store';

const scope = { organizationId: 'org-1', branchId: 'branch-1' };

function sqlText(query: unknown): string {
  return (query as { strings: readonly string[] }).strings.join('?');
}

describe('Prisma folio ledger store', () => {
  it('puts organizationId and branchId predicates in every SQL operation', async () => {
    const queries: string[] = [];
    const db: FolioSqlClient = {
      $queryRaw: vi.fn(async (query) => {
        queries.push(sqlText(query));
        return [{}];
      }),
    };
    const store = createPrismaFolioLedgerStore(db, 'actor-1');

    await store.read(scope, 'folio-1');
    await store.readEntries(scope, 'folio-1');
    await store.catalogPrice(scope, 'extra-1');
    await store.insert(scope, {
      folioId: 'folio-1', catalogItemId: 'extra-1', quantity: 1,
      unitMinor: 100, netMinor: 100, taxMinor: 10, grossMinor: 110,
    });
    await store.reverse(scope, 'entry-1', 'Correction');

    expect(queries).toHaveLength(5);
    for (const query of queries) {
      expect(query).toContain('"organizationId" =');
      expect(query).toContain('"branchId" =');
    }
  });

  it('denies a principal without hotel:folio before an elevated DB read', async () => {
    const queryRaw = vi.fn(async () => []);
    const service = createProductionFolioLedgerService(
      { $queryRaw: queryRaw },
      { id: 'actor-1', capabilities: new Set(['hotel:front-desk']) }
    );

    await expect(service.get(scope, 'folio-1')).rejects.toThrow('hotel:folio');
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

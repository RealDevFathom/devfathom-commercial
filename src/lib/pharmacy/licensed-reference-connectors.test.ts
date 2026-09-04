import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  CommercialMedicineConnector,
  DrapReferenceConnector,
} from './licensed-reference-connectors';

const connector = () =>
  new DrapReferenceConnector({
    endpoint: 'https://feed.example.test/medicines',
    token: 'secret',
    rightsReference: 'DRAP agreement 7',
  });

afterEach(() => vi.unstubAllGlobals());

describe('licensed medicine reference feed boundary', () => {
  it('keeps licensed connectors disabled without configuration', () => {
    expect(new DrapReferenceConnector().enabled).toBe(false);
    expect(new CommercialMedicineConnector().enabled).toBe(false);
  });

  it('rebuilds trusted identity, source, provenance, and rights', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            batchId: 'upstream-1',
            rows: [
              { rowSourceKey: 'row-1', values: { productName: ' Panadol ', strength: '500 mg' } },
            ],
          }),
          { status: 200 }
        )
      )
    );

    const result = await connector().fetch();

    expect(result).toMatchObject({ connectorId: 'drap', batchId: 'drap:upstream-1' });
    expect(result.rows[0]?.assertions[0]).toMatchObject({
      source: 'DRAP licensed feed',
      sourceType: 'REGULATOR',
      rights: { acquisition: 'DRAP agreement 7' },
    });
  });

  it('rejects untrusted envelope fields and oversized feeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            connectorId: 'attacker',
            batchId: 'upstream-1',
            rows: [],
          }),
          { status: 200 }
        )
      )
    );
    await expect(connector().fetch()).rejects.toThrow();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            batchId: 'upstream-2',
            rows: Array.from({ length: 501 }, (_, index) => ({
              rowSourceKey: String(index),
              values: { productName: 'Medicine' },
            })),
          }),
          { status: 200 }
        )
      )
    );
    await expect(connector().fetch()).rejects.toThrow();
  });
});

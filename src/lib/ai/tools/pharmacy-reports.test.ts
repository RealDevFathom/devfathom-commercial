import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createAssistantHelpers } from '@/lib/ai/context';
import { PHARMACY_METRIC_CONTRACT } from '@/lib/pharmacy/reports';
import { buildPharmacyReportTools } from './pharmacy-reports';

const branchFindMany = vi.fn();
const queryRaw = vi.fn();
const count = vi.fn();
const abacCan = vi.fn();

vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: (...args: unknown[]) => abacCan(...args),
}));

function toolExecute() {
  const db = {
    pharmacyBranch: { findMany: branchFindMany },
    $queryRaw: queryRaw,
    pharmacyRecallNotice: { count },
    pharmacySupplierClaim: { count },
    pharmacyReceivingException: { count },
    branchRegulatoryProfile: { count },
  } as never;
  const helpers = createAssistantHelpers(
    {
      organizationId: 'org_1',
      userId: 'user_1',
      role: 'ADMIN',
      enabledModules: ['pharmacy-reports'],
    },
    db
  );
  return buildPharmacyReportTools(helpers).askPharmacyReports.execute! as (input: {
    metricKeys: string[];
    branch?: string | null;
    from?: string | null;
    to?: string | null;
  }) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  abacCan.mockResolvedValue(true);
  branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main Pharmacy' }]);
  queryRaw.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe('Ask Fathom pharmacy reports', () => {
  it('refuses an unauthorized branch without reading report figures', async () => {
    const result = await toolExecute()({
      metricKeys: ['openStockSignals'],
      branch: 'branch_outside_scope',
      from: '2026-09-05',
      to: '2026-09-05',
    });

    expect(result).toEqual({
      kind: 'refusal',
      message: 'I cannot answer that from the pharmacy reports you are authorized to see.',
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('maps every numeric claim to a complete metric contract citation', async () => {
    const result = await toolExecute()({
      metricKeys: ['salesMinor', 'openStockSignals'],
      branch: 'Main Pharmacy',
      from: '2026-09-05',
      to: '2026-09-05',
    });

    expect(result.kind).toBe('answer');
    const claims = result.claims as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      const contract = PHARMACY_METRIC_CONTRACT.find(({ key }) => key === claim.metricKey);
      expect(contract).toBeDefined();
      expect(claim).toMatchObject({
        definition: contract!.definition,
        source: contract!.source,
        scope: {
          contract: contract!.scope,
          branchIds: ['branch_1'],
          from: '2026-09-05',
          to: '2026-09-05',
        },
        freshness: expect.objectContaining({ status: 'CURRENT', asOf: expect.any(String) }),
        drillThrough: expect.stringMatching(/^\/pharmacy\//),
      });
      expect(typeof claim.value).toBe('number');
    }
  });

  it('returns cannot-answer for unknown or unavailable metrics without querying reports', async () => {
    await expect(
      toolExecute()({ metricKeys: ['patientDiagnosis'], branch: 'Main Pharmacy' })
    ).resolves.toEqual({
      kind: 'cannot_answer',
      message: 'I cannot answer that from authorized reports because no supporting metric exists.',
    });
    expect(branchFindMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('fails closed when financial permission or live report data is unavailable', async () => {
    abacCan.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(toolExecute()({ metricKeys: ['salesMinor'] })).resolves.toMatchObject({
      kind: 'refusal',
    });
    expect(branchFindMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    abacCan.mockResolvedValue(true);
    branchFindMany.mockRejectedValue(new Error('database offline'));
    await expect(toolExecute()({ metricKeys: ['openStockSignals'] })).resolves.toEqual({
      kind: 'unavailable',
      message: 'Pharmacy report data is currently unavailable. No stale figures were used.',
    });
  });
});

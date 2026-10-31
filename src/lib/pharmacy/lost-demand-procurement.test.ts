import { describe, expect, it, vi } from 'vitest';
import {
  actOnLostDemandAdvice,
  DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
  evaluateLostDemandScopes,
  evaluateLostDemandTriggers,
  loadLostDemandScopeAlerts,
  lostDemandWhatsAppText,
  suggestedProcurementQuantity,
  type LostDemandActionBoundary,
  type LostDemandAction,
  type LostDemandAdvice,
  type LostDemandTransaction,
} from './lost-demand-procurement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

describe('lost-demand procurement advice', () => {
  it('validates metrics/config and preserves inclusive thresholds', () => {
    const config = { ...DEFAULT_LOST_DEMAND_TRIGGER_CONFIG, requestsInWindow: 5 };
    expect(
      evaluateLostDemandTriggers(
        { requests: 5, estimatedLossMinor: 0, walkOuts: 0, visits: 0 },
        config
      )
    ).toEqual(['REQUESTS']);
    expect(
      evaluateLostDemandTriggers(
        { requests: 0, estimatedLossMinor: 1_000_000, walkOuts: 0, visits: 2 },
        config
      )
    ).toEqual(['ESTIMATED_LOSS']);
    expect(
      evaluateLostDemandTriggers(
        { requests: 0, estimatedLossMinor: 0, walkOuts: 11, visits: 100 },
        config
      )
    ).toEqual(['WALK_OUT_RATE']);
    expect(() =>
      evaluateLostDemandTriggers(
        { requests: Number.NaN, estimatedLossMinor: 0, walkOuts: 0, visits: 0 },
        config
      )
    ).toThrow('INVALID_LOST_DEMAND_METRICS');
    expect(() =>
      evaluateLostDemandTriggers(
        { requests: 0, estimatedLossMinor: 0, walkOuts: 2, visits: 1 },
        config
      )
    ).toThrow('INVALID_LOST_DEMAND_METRICS');
    expect(() =>
      evaluateLostDemandTriggers(
        { requests: 0, estimatedLossMinor: 0, walkOuts: 0, visits: 0 },
        { ...config, walkOutRateBps: -1 }
      )
    ).toThrow('INVALID_LOST_DEMAND_METRICS');
  });

  it('calculates schemes in logarithmic time and rejects overflow/incomplete terms', () => {
    expect(
      suggestedProcurementQuantity({
        forecastUnitsOverLeadTime: 92,
        safetyStockUnits: 30,
        onHandUnits: 17,
        onOrderUnits: 5,
        terms: { packUnits: 10, schemeBuyPacks: 5, schemeFreePacks: 1 },
      })
    ).toEqual({ requiredUnits: 100, orderedPacks: 9, bonusPacks: 1, suppliedUnits: 100 });
    expect(
      suggestedProcurementQuantity({
        forecastUnitsOverLeadTime: 2_000_000_000,
        safetyStockUnits: 0,
        onHandUnits: 0,
        onOrderUnits: 0,
        terms: { packUnits: 1, schemeBuyPacks: 5, schemeFreePacks: 1 },
      }).suppliedUnits
    ).toBeGreaterThanOrEqual(2_000_000_000);
    expect(() =>
      suggestedProcurementQuantity({
        forecastUnitsOverLeadTime: 1,
        safetyStockUnits: 0,
        onHandUnits: 0,
        onOrderUnits: 0,
        terms: { packUnits: 1, schemeBuyPacks: 2 },
      })
    ).toThrow('INCOMPLETE_BONUS_SCHEME');
    expect(() =>
      suggestedProcurementQuantity({
        forecastUnitsOverLeadTime: 2_147_483_647,
        safetyStockUnits: 1,
        onHandUnits: 0,
        onOrderUnits: 0,
        terms: { packUnits: 1 },
      })
    ).toThrow('INVALID_LOST_DEMAND_QUANTITY');
  });

  it('accepts safe aggregate totals above a single database integer', () => {
    const metrics = { requests: 0, estimatedLossMinor: 3_000_000_000, walkOuts: 0, visits: 0 };
    expect(evaluateLostDemandTriggers(metrics, DEFAULT_LOST_DEMAND_TRIGGER_CONFIG)).toEqual([
      'ESTIMATED_LOSS',
    ]);
    expect(
      evaluateLostDemandTriggers(metrics, {
        ...DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
        estimatedLossMinor: 3_000_000_000,
      })
    ).toEqual(['ESTIMATED_LOSS']);
    expect(() =>
      evaluateLostDemandTriggers(
        { ...metrics, estimatedLossMinor: Number.MAX_SAFE_INTEGER + 1 },
        DEFAULT_LOST_DEMAND_TRIGGER_CONFIG
      )
    ).toThrow('INVALID_LOST_DEMAND_METRICS');
  });

  const advice: LostDemandAdvice = {
    id: 'advice-1',
    organizationId: 'org-1',
    branchId: 'branch-2',
    medicineId: 'medicine-1',
    fired: ['REQUESTS'],
    metrics: { requests: 3, estimatedLossMinor: 250_000, walkOuts: 1, visits: 20 },
    quantity: { requiredUnits: 20, orderedPacks: 2, bonusPacks: 0, suppliedUnits: 20 },
    distributors: [
      { supplierId: 'supplier-1', lastPricePerPackMinor: 100, scheme: null, leadTimeDays: 2 },
    ],
    alternates: [],
    transfers: [{ fromBranchId: 'branch-1', surplusUnits: 12 }],
  };
  function fixture(overrides: Partial<LostDemandTransaction> = {}) {
    const writer: LostDemandTransaction = {
      loadCurrentAdvice: vi.fn(async () => advice),
      createPurchaseOrderDraft: vi.fn(async () => ({ id: 'po-1', status: 'DRAFT' as const })),
      createTransferDraft: vi.fn(async () => ({ id: 'transfer-1', status: 'DRAFT' as const })),
      appendAudit: vi.fn(async () => undefined),
      ...overrides,
    };
    const boundary: LostDemandActionBoundary = {
      authenticate: vi.fn(async ({ pin }) => {
        if (pin !== '1234') throw new Error('PIN_INVALID');
        return { organizationId: 'org-1', userId: 'owner-1' };
      }),
      transaction: vi.fn(async (work) => work(writer)),
    };
    return { writer, boundary };
  }

  it('rejects unknown actions before authentication or draft creation', async () => {
    const { writer, boundary } = fixture();
    await expect(
      actOnLostDemandAdvice({
        action: 'SEND_PO' as LostDemandAction,
        adviceId: advice.id,
        pin: '1234',
        fromBranchId: 'branch-1',
        boundary,
      })
    ).rejects.toThrow('INVALID_LOST_DEMAND_ACTION');
    expect(boundary.authenticate).not.toHaveBeenCalled();
    expect(boundary.transaction).not.toHaveBeenCalled();
    expect(writer.createTransferDraft).not.toHaveBeenCalled();
    expect(writer.appendAudit).not.toHaveBeenCalled();
  });

  it('rejects advice with a different ID from the approved request', async () => {
    const { writer, boundary } = fixture({
      loadCurrentAdvice: vi.fn(async () => ({ ...advice, id: 'other-advice' })),
    });
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_PO',
        adviceId: advice.id,
        pin: '1234',
        supplierId: 'supplier-1',
        boundary,
      })
    ).rejects.toThrow('LOST_DEMAND_ADVICE_NOT_AVAILABLE');
    expect(writer.createPurchaseOrderDraft).not.toHaveBeenCalled();
    expect(writer.appendAudit).not.toHaveBeenCalled();
  });

  it('derives actor/tenant/capability through PIN boundary and audits every action', async () => {
    const { writer, boundary } = fixture();
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_PO',
        adviceId: advice.id,
        pin: 'bad',
        supplierId: 'supplier-1',
        boundary,
      })
    ).rejects.toThrow('PIN_INVALID');
    expect(writer.loadCurrentAdvice).not.toHaveBeenCalled();
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_PO',
        adviceId: advice.id,
        pin: '1234',
        supplierId: 'supplier-1',
        boundary,
      })
    ).resolves.toEqual({ id: 'po-1', status: 'DRAFT' });
    expect(writer.createPurchaseOrderDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        createdByUserId: 'owner-1',
        status: 'DRAFT',
      })
    );
    expect(writer.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'owner-1', action: 'DRAFT_PO', draftId: 'po-1' })
    );
    await actOnLostDemandAdvice({ action: 'IGNORE', adviceId: advice.id, pin: '1234', boundary });
    expect(writer.appendAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'IGNORE' })
    );
  });

  it('refuses cross-tenant/stale advice, unlisted suppliers and empty drafts', async () => {
    const unlisted = fixture();
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_PO',
        adviceId: advice.id,
        pin: '1234',
        supplierId: 'other',
        boundary: unlisted.boundary,
      })
    ).rejects.toThrow('SUPPLIER_NOT_ELIGIBLE');
    expect(unlisted.writer.createPurchaseOrderDraft).not.toHaveBeenCalled();
    const crossTenant = fixture({
      loadCurrentAdvice: vi.fn(async () => ({ ...advice, organizationId: 'org-2' })),
    });
    await expect(
      actOnLostDemandAdvice({
        action: 'IGNORE',
        adviceId: advice.id,
        pin: '1234',
        boundary: crossTenant.boundary,
      })
    ).rejects.toThrow('LOST_DEMAND_ADVICE_NOT_AVAILABLE');
    const empty = fixture({
      loadCurrentAdvice: vi.fn(async () => ({
        ...advice,
        quantity: { requiredUnits: 0, orderedPacks: 0, bonusPacks: 0, suppliedUnits: 0 },
      })),
    });
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_PO',
        adviceId: advice.id,
        pin: '1234',
        supplierId: 'supplier-1',
        boundary: empty.boundary,
      })
    ).rejects.toThrow('NO_REPLENISHMENT_REQUIRED');
  });

  it('rolls back draft and audit together when audit fails', async () => {
    const { writer, boundary } = fixture({
      appendAudit: vi.fn(async () => {
        throw new Error('AUDIT_FAILED');
      }),
    });
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_TRANSFER',
        adviceId: advice.id,
        pin: '1234',
        fromBranchId: 'branch-1',
        boundary,
      })
    ).rejects.toThrow('AUDIT_FAILED');
    expect(boundary.transaction).toHaveBeenCalledOnce();
    expect(writer.createTransferDraft).toHaveBeenCalledWith(
      expect.objectContaining({ quantityUnits: 12, status: 'DRAFT' })
    );
  });

  it('keeps WhatsApp copy generic', () => {
    const text = lostDemandWhatsAppText(advice);
    expect(text).toContain('estimated demand');
    expect(text).not.toContain(advice.medicineId);
    expect(text).toContain('nothing has been sent');
  });

  describe('SKU/salt-scoped trailing windows', () => {
    const fact = (
      medicineId: string,
      requests: number,
      loss = 0,
      saltKey: string | null = null
    ) => ({
      medicineId,
      saltKey,
      requestsInRequestWindow: requests,
      estimatedLossMinorInLossWindow: loss,
    });

    it('never sums unrelated items into one request trigger', () => {
      expect(
        evaluateLostDemandScopes(
          [fact('a', 1), fact('b', 1), fact('c', 1)],
          DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
          { financial: true }
        )
      ).toEqual([]);
      expect(
        evaluateLostDemandScopes([fact('a', 3)], DEFAULT_LOST_DEMAND_TRIGGER_CONFIG, {
          financial: true,
        })
      ).toEqual([
        expect.objectContaining({ scope: 'SKU', key: 'a', requests: 3, fired: ['REQUESTS'] }),
      ]);
    });

    it('combines brands only when they share salt and strength', () => {
      const alerts = evaluateLostDemandScopes(
        [
          fact('a', 2, 0, 'para@500mg'),
          fact('b', 1, 0, 'para@500mg'),
          fact('c', 2, 0, 'ibu@200mg'),
        ],
        DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
        { financial: true }
      );
      expect(alerts).toEqual([
        expect.objectContaining({ scope: 'SALT', key: 'para@500mg', medicineIds: ['a', 'b'] }),
      ]);
    });

    it('excludes the loss metric and trigger without financial permission', () => {
      const facts = [fact('a', 0, 1_500_000), fact('b', 3, 1_500_000)];
      expect(
        evaluateLostDemandScopes(facts, DEFAULT_LOST_DEMAND_TRIGGER_CONFIG, { financial: true })
      ).toHaveLength(2);
      const restricted = evaluateLostDemandScopes(facts, DEFAULT_LOST_DEMAND_TRIGGER_CONFIG, {
        financial: false,
      });
      expect(restricted).toEqual([
        { scope: 'SKU', key: 'b', medicineIds: ['b'], requests: 3, fired: ['REQUESTS'] },
      ]);
    });

    it('queries each metric over its own window ending now and skips loss without permission', async () => {
      const groupBy = vi.fn().mockResolvedValue([]);
      const db = {
        unfulfilledDemandEvent: { groupBy },
        medicineStrengthComponent: { findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as ScopedDb;
      const at = new Date('2026-10-31T00:00:00.000Z');
      const scope = { organizationId: 'org', branchId: 'br' };
      await loadLostDemandScopeAlerts(db, scope, { financial: true, at });
      expect(groupBy.mock.calls.map(([args]) => args.where.createdAt)).toEqual([
        { gte: new Date('2026-10-24T00:00:00.000Z'), lt: at },
        { gte: new Date('2026-10-01T00:00:00.000Z'), lt: at },
      ]);
      expect(groupBy.mock.calls[0][0].where).toMatchObject({
        organizationId: 'org',
        branchId: 'br',
      });
      groupBy.mockClear();
      await loadLostDemandScopeAlerts(db, scope, { financial: false, at });
      expect(groupBy).toHaveBeenCalledOnce();
      expect(groupBy.mock.calls[0][0]._sum).toBeUndefined();
    });
  });
});

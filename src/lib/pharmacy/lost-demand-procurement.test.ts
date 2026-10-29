import { describe, expect, it, vi } from 'vitest';
import {
  actOnLostDemandAdvice,
  DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
  evaluateLostDemandTriggers,
  lostDemandWhatsAppText,
  suggestedProcurementQuantity,
  type LostDemandAdvice,
  type ProcurementDraftWriter,
} from './lost-demand-procurement';

describe('lost-demand procurement advice', () => {
  it('fires each inclusive branch-configured threshold independently and uses strict > for walk-outs', () => {
    const configured = { ...DEFAULT_LOST_DEMAND_TRIGGER_CONFIG, requestsInWindow: 5 };
    expect(
      evaluateLostDemandTriggers(
        { requests: 5, estimatedLossMinor: 0, walkOuts: 0, visits: 0 },
        configured
      )
    ).toEqual(['REQUESTS']);
    expect(
      evaluateLostDemandTriggers(
        { requests: 0, estimatedLossMinor: 1_000_000, walkOuts: 0, visits: 2 },
        configured
      )
    ).toEqual(['ESTIMATED_LOSS']);
    expect(
      evaluateLostDemandTriggers(
        { requests: 0, estimatedLossMinor: 0, walkOuts: 11, visits: 100 },
        configured
      )
    ).toEqual(['WALK_OUT_RATE']);
    expect(
      evaluateLostDemandTriggers(
        { requests: 0, estimatedLossMinor: 0, walkOuts: 10, visits: 100 },
        configured
      )
    ).toEqual([]);
  });

  it('subtracts on-hand/on-order and rounds supply to pack bonus terms', () => {
    expect(
      suggestedProcurementQuantity({
        forecastUnitsOverLeadTime: 92,
        safetyStockUnits: 30,
        onHandUnits: 17,
        onOrderUnits: 5,
        terms: { packUnits: 10, schemeBuyPacks: 5, schemeFreePacks: 1 },
      })
    ).toEqual({ requiredUnits: 100, orderedPacks: 9, bonusPacks: 1, suppliedUnits: 100 });
  });

  const advice: LostDemandAdvice = {
    branchId: 'branch-2',
    medicineId: 'medicine-secret',
    fired: ['REQUESTS'],
    metrics: { requests: 3, estimatedLossMinor: 250000, walkOuts: 1, visits: 20 },
    quantity: { requiredUnits: 20, orderedPacks: 2, bonusPacks: 0, suppliedUnits: 20 },
    distributors: [],
    alternates: [],
    transfers: [{ fromBranchId: 'branch-1', surplusUnits: 12 }],
  };
  const writer = (): ProcurementDraftWriter => ({
    createPurchaseOrderDraft: vi.fn(async (value) => ({ id: 'po-1', status: value.status })),
    createTransferDraft: vi.fn(async (value) => ({ id: 'transfer-1', status: value.status })),
    ignore: vi.fn(async () => undefined),
  });

  it('requires procurement permission and only writes DRAFT PO/transfer records', async () => {
    const denied = writer();
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_PO',
        advice,
        actorId: 'cashier',
        canProcure: false,
        supplierId: 'supplier-1',
        writer: denied,
      })
    ).rejects.toThrow('PROCUREMENT_PERMISSION_REQUIRED');
    expect(denied.createPurchaseOrderDraft).not.toHaveBeenCalled();

    const allowed = writer();
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_PO',
        advice,
        actorId: 'owner',
        canProcure: true,
        supplierId: 'supplier-1',
        writer: allowed,
      })
    ).resolves.toMatchObject({ status: 'DRAFT' });
    await expect(
      actOnLostDemandAdvice({
        action: 'DRAFT_TRANSFER',
        advice,
        actorId: 'owner',
        canProcure: true,
        fromBranchId: 'branch-1',
        writer: allowed,
      })
    ).resolves.toMatchObject({ status: 'DRAFT' });
    expect(allowed.createPurchaseOrderDraft).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DRAFT' })
    );
    expect(allowed.createTransferDraft).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DRAFT', quantityUnits: 12 })
    );
    expect(Object.keys(allowed)).not.toContain('send');
  });

  it('keeps WhatsApp copy generic and labels computed money as estimated', () => {
    const text = lostDemandWhatsAppText(advice);
    expect(text).toContain('estimated demand');
    expect(text).not.toContain(advice.medicineId);
    expect(text).toContain('nothing has been sent');
  });
});

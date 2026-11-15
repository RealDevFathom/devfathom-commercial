import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  approveMarketingTemplate,
  createMarketingDraft,
  MarketingWorkflowError,
} from './marketing-service';

// #718: only NON_DRUG_RETAIL items may be promoted; a medicine SKU refuses the template and campaign.
const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'Asia/Karachi',
};
const now = new Date('2026-11-15T07:00:00Z');
const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  productFamily: 'FRONT_SHOP',
  rx: false,
  restricted: false,
  controlled: false,
  ...overrides,
});

function database(products: ReturnType<typeof item>[], featuredMedicineIds: string[] = []) {
  const mock = {
    medicine: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        products.filter((product) => where.id.in.includes(product.id))
      ),
    },
    pharmacyMarketingTemplate: {
      create: vi.fn(async ({ data }) => ({ id: 'template-a', ...data })),
      findFirst: vi.fn(async () => ({
        id: 'template-a',
        body: 'Visit our store. Reply STOP to opt out.',
        approvedByUserId: 'owner-a',
        approvedAt: now,
        featuredMedicineIds,
      })),
    },
    pharmacyMarketingSegment: { create: vi.fn(async () => ({ id: 'segment-a' })) },
    pharmacyCampaign: { create: vi.fn(async ({ data }) => ({ id: 'campaign-a', ...data })) },
  };
  return { mock, db: mock as unknown as ScopedDb };
}

const templateInput = (featuredMedicineIds: string[]) => ({
  branchId: 'branch-a',
  name: 'Winter skincare',
  body: 'New winter skincare range in store. Reply STOP to opt out.',
  reviewed: true as const,
  featuredMedicineIds,
});
const draftInput = {
  branchId: 'branch-a',
  name: 'Winter offer',
  templateId: 'template-a',
  definition: {
    version: 1 as const,
    all: [{ field: 'receiptCount' as const, operator: 'gte' as const, value: 1 }],
  },
  scheduledAt: new Date('2026-11-20T07:00:00Z'),
  quietHours: { startHour: 22, endHour: 8 },
  frequencyCap: { max: 1, windowDays: 7 },
  promotesRegulatedItem: false as const,
};

describe('marketing product guard (#718)', () => {
  it('stores featured non-drug retail items on an approved template', async () => {
    const { db, mock } = database([item('lotion'), item('shampoo')]);
    await approveMarketingTemplate(db, scope, templateInput(['lotion', 'shampoo', 'lotion']), now);
    expect(mock.pharmacyMarketingTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ featuredMedicineIds: ['lotion', 'shampoo'] }),
    });
  });

  it.each([
    ['a pharmaceutical', item('panadol', { productFamily: 'PHARMACEUTICAL' })],
    ['an OTC medicine', item('panadol', { productFamily: 'PHARMACEUTICAL', otc: true })],
    ['a device', item('panadol', { productFamily: 'DEVICE' })],
    ['an Rx-flagged front-shop item', item('panadol', { rx: true })],
    ['a controlled front-shop item', item('panadol', { controlled: true })],
  ])('refuses a template featuring %s', async (_label, medicine) => {
    const { db, mock } = database([item('lotion'), medicine]);
    await expect(
      approveMarketingTemplate(db, scope, templateInput(['lotion', 'panadol']), now)
    ).rejects.toThrow('Medicines cannot be promoted');
    expect(mock.pharmacyMarketingTemplate.create).not.toHaveBeenCalled();
  });

  it('refuses an item outside this tenant catalogue as missing', async () => {
    const { db, mock } = database([item('lotion')]);
    await expect(
      approveMarketingTemplate(db, scope, templateInput(['lotion', 'foreign']), now)
    ).rejects.toBeInstanceOf(MarketingWorkflowError);
    expect(mock.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', id: { in: ['lotion', 'foreign'] } },
      })
    );
    expect(mock.pharmacyMarketingTemplate.create).not.toHaveBeenCalled();
  });

  it('refuses a campaign whose template features an item later reclassified as a medicine', async () => {
    const { db, mock } = database(
      [item('lotion', { productFamily: 'PHARMACEUTICAL' })],
      ['lotion']
    );
    await expect(createMarketingDraft(db, scope, draftInput)).rejects.toThrow(
      'Medicines cannot be promoted'
    );
    expect(mock.pharmacyCampaign.create).not.toHaveBeenCalled();
    expect(mock.pharmacyMarketingSegment.create).not.toHaveBeenCalled();
  });

  it('drafts a campaign whose template features only non-drug retail items', async () => {
    const { db, mock } = database([item('lotion')], ['lotion']);
    await createMarketingDraft(db, scope, draftInput);
    expect(mock.pharmacyCampaign.create).toHaveBeenCalledTimes(1);
  });
});

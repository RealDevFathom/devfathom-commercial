import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  approveMarketingTemplate,
  createMarketingDraft,
  MarketingWorkflowError,
} from './marketing-service';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'Asia/Karachi',
};
const now = new Date('2026-10-31T07:00:00Z');
const catalogue = [
  { id: 'shampoo', productFamily: 'FRONT_SHOP', rx: false, restricted: false, controlled: false },
  { id: 'diapers', productFamily: 'FRONT_SHOP', rx: false, restricted: false, controlled: false },
  {
    id: 'panadol',
    productFamily: 'PHARMACEUTICAL',
    rx: false,
    restricted: false,
    controlled: false,
  },
  { id: 'flagged', productFamily: 'FRONT_SHOP', rx: true, restricted: false, controlled: false },
];

function database(featuredMedicineIds: string[] = []) {
  const mock = {
    medicine: {
      findMany: vi.fn(
        async ({ where }: { where: { organizationId: string; id: { in: string[] } } }) =>
          catalogue.filter((item) => where.id.in.includes(item.id))
      ),
    },
    pharmacyMarketingTemplate: {
      create: vi.fn(async ({ data }) => ({ id: 'template-new', ...data })),
      findFirst: vi.fn(async () => ({
        id: 'template-a',
        body: 'New winter skincare range in store. Reply STOP to opt out.',
        approvedByUserId: 'owner-a',
        approvedAt: now,
        featuredMedicineIds,
      })),
    },
    pharmacyMarketingSegment: { create: vi.fn(async () => ({ id: 'segment-a' })) },
    pharmacyCampaign: { create: vi.fn(async ({ data }) => data) },
  };
  return { mock, db: mock as unknown as ScopedDb };
}

const template = (featuredMedicineIds: string[]) => ({
  branchId: 'branch-a',
  name: 'Winter skincare',
  body: 'New winter skincare range in store. Reply STOP to opt out.',
  reviewed: true as const,
  featuredMedicineIds,
});

const draft = {
  branchId: 'branch-a',
  name: 'Winter skincare',
  templateId: 'template-a',
  definition: {
    version: 1 as const,
    all: [{ field: 'receiptCount' as const, operator: 'gte' as const, value: 1 }],
  },
  scheduledAt: now,
  quietHours: { startHour: 22, endHour: 8 },
  frequencyCap: { max: 1, windowDays: 7 },
  promotesRegulatedItem: false as const,
};

describe('#718 marketing promotes only non-drug retail items', () => {
  it('approves a template featuring only non-drug items and stores them deduplicated', async () => {
    const { mock, db } = database();
    await approveMarketingTemplate(db, scope, template(['shampoo', 'diapers', 'shampoo']), now);
    expect(mock.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', id: { in: ['shampoo', 'diapers'] } },
      })
    );
    expect(mock.pharmacyMarketingTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ featuredMedicineIds: ['shampoo', 'diapers'] }),
    });
  });

  it('keeps legacy templates without featured items working', async () => {
    const { mock, db } = database();
    await approveMarketingTemplate(
      db,
      scope,
      {
        branchId: 'branch-a',
        name: 'Store visit',
        body: 'Visit our store this weekend. Reply STOP to opt out.',
        reviewed: true,
      },
      now
    );
    expect(mock.medicine.findMany).not.toHaveBeenCalled();
    expect(mock.pharmacyMarketingTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ featuredMedicineIds: [] }),
    });
  });

  it.each([
    [['shampoo', 'panadol'], 'Medicines cannot be promoted. Feature only non-drug retail items.'],
    [['flagged'], 'Medicines cannot be promoted. Feature only non-drug retail items.'],
    [['other-tenant-item'], 'A featured item is not in this catalogue.'],
  ])('refuses a template featuring %j before writing', async (ids, message) => {
    const { mock, db } = database();
    await expect(approveMarketingTemplate(db, scope, template(ids), now)).rejects.toThrow(
      new MarketingWorkflowError(message)
    );
    expect(mock.pharmacyMarketingTemplate.create).not.toHaveBeenCalled();
  });

  it('refuses a campaign whose template includes a medicine SKU', async () => {
    const { mock, db } = database(['shampoo', 'panadol']);
    await expect(createMarketingDraft(db, scope, draft)).rejects.toThrow(MarketingWorkflowError);
    expect(mock.pharmacyMarketingSegment.create).not.toHaveBeenCalled();
    expect(mock.pharmacyCampaign.create).not.toHaveBeenCalled();
  });

  it('drafts a campaign whose template features only non-drug items', async () => {
    const { mock, db } = database(['shampoo']);
    await createMarketingDraft(db, scope, draft);
    expect(mock.pharmacyCampaign.create).toHaveBeenCalledTimes(1);
  });
});

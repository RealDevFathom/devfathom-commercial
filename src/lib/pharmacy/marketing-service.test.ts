import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  approveMarketingCampaign,
  captureMarketingCampaign,
  createMarketingDraft,
  marketingConsent,
  marketingDraftInput,
  previewMarketingCampaign,
  renderMarketingBody,
  VOUCHER_FOOTER,
  requireCaptureWindow,
} from './marketing-service';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'Asia/Karachi',
};
const now = new Date('2026-10-06T07:00:00Z');
const campaign = () => ({
  id: 'campaign-a',
  ...scope,
  status: 'APPROVED',
  ownerApprovedByUserId: 'owner-a',
  ownerApprovedAt: now,
  templateId: 'template-a',
  segmentId: 'segment-a',
  scheduledAt: now,
  promotesRegulatedItem: false,
  quietHours: { startHour: 22, endHour: 8 },
  frequencyCap: { max: 1, windowDays: 7 },
  voucherEnabled: false,
  voucherDiscountMinor: null,
  eligibleCategoryAllowlist: ['FRONT_SHOP'],
});
let row: ReturnType<typeof campaign>;
let captures: Array<Record<string, unknown>>;
let exclusions: Array<Record<string, unknown>>;
let optIn: boolean | null;
let revokedAt: Date | null;
let db: ScopedDb;
let mock: ReturnType<typeof database>;
function database() {
  return {
    $queryRaw: vi.fn(async () => [{ id: 'patient-a', patientId: 'patient-a' }]),
    pharmacyCampaign: {
      findFirst: vi.fn(async () => row),
      create: vi.fn(async ({ data }) => data),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status !== row.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => Object.assign(row, data)),
    },
    pharmacyMarketingTemplate: {
      findFirst: vi.fn(async () => ({
        id: 'template-a',
        body: 'Visit our store. Reply STOP to opt out.',
        approvedByUserId: 'owner-a',
        approvedAt: now,
      })),
    },
    pharmacyMarketingSegment: {
      findFirst: vi.fn(async () => ({
        definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
      })),
      create: vi.fn(async () => ({ id: 'new-segment' })),
    },
    pharmacySale: {
      groupBy: vi.fn(async () => [
        {
          customerId: 'customer-a',
          _count: { _all: 2 },
          _max: { completedAt: new Date('2026-10-01T07:00:00Z') },
        },
      ]),
    },
    pharmacyCustomer: {
      findFirst: vi.fn(async () => ({
        id: 'customer-a',
        active: true,
        patientId: 'patient-a',
        whatsappOptIn: optIn,
      })),
    },
    patientConsent: {
      findFirst: vi.fn(async () => ({ granted: true, revokedAt, recordedAt: now })),
    },
    pharmacyCampaignCapture: {
      count: vi.fn(
        async ({ where }) =>
          captures.filter(
            (c) =>
              (!where.campaignId || c.campaignId === where.campaignId) &&
              (!where.customerId || c.customerId === where.customerId)
          ).length
      ),
      create: vi.fn(async ({ data }) => {
        captures.push(data);
        return data;
      }),
      findMany: vi.fn(async () => captures),
    },
    pharmacyCampaignExclusion: {
      create: vi.fn(async ({ data }) => {
        exclusions.push(data);
        return data;
      }),
    },
  };
}
beforeEach(() => {
  row = campaign();
  captures = [];
  exclusions = [];
  optIn = true;
  revokedAt = null;
  mock = database();
  db = mock as unknown as ScopedDb;
});

describe('persisted capture workflow', () => {
  it('creates a draft linked to an immutable reviewed template and stored retail rules', async () => {
    const input = {
      branchId: scope.branchId,
      name: 'Store update',
      templateId: 'template-a',
      definition: {
        version: 1 as const,
        all: [{ field: 'receiptCount' as const, operator: 'gte' as const, value: 1 }],
      },
      scheduledAt: now,
      quietHours: row.quietHours,
      frequencyCap: row.frequencyCap,
      promotesRegulatedItem: false as const,
      voucherEnabled: false,
      voucherDiscountMinor: null,
      eligibleCategoryAllowlist: ['FRONT_SHOP' as const],
    };
    expect(await createMarketingDraft(db, scope, input)).toMatchObject({
      status: 'DRAFT',
      segmentId: 'new-segment',
      organizationId: 'org-a',
    });
    expect(mock.pharmacyMarketingTemplate.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        id: 'template-a',
        channel: 'WHATSAPP',
      },
    });
  });
  it('automatically appends the bilingual exclusion footer to voucher messages', () => {
    const rendered = renderMarketingBody('Save on eligible essentials. Reply STOP.', true);
    expect(rendered).toContain(VOUCHER_FOOTER);
    expect(renderMarketingBody(rendered, true).match(new RegExp(VOUCHER_FOOTER, 'g'))).toHaveLength(
      1
    );
    expect(rendered.replace(VOUCHER_FOOTER, '')).not.toMatch(/\b(?:drug|medicine|rx|salt)\b/i);
  });
  it('rejects unsupported or clinical segment fields', () => {
    for (const field of ['medicine', 'otcOnly', 'familyAccount']) {
      expect(
        marketingDraftInput.safeParse({
          branchId: 'branch-a',
          name: 'a',
          templateId: 't',
          definition: { version: 1, all: [{ field, operator: 'eq', value: 1 }] },
          scheduledAt: now,
          quietHours: row.quietHours,
          frequencyCap: row.frequencyCap,
          promotesRegulatedItem: false,
        }).success
      ).toBe(false);
    }
  });
  it('requires draft state for owner approval', async () => {
    await expect(approveMarketingCampaign(db, scope, row.id, now)).rejects.toThrow('Only a draft');
    row.status = 'DRAFT';
    expect(await approveMarketingCampaign(db, scope, row.id, now)).toEqual({ status: 'APPROVED' });
    expect(row.ownerApprovedByUserId).toBe('owner-a');
  });
  it('previews without writes and captures once with the stable key', async () => {
    expect(await previewMarketingCampaign(db, scope, row.id, now)).toMatchObject({ prepared: 1 });
    expect(captures).toEqual([]);
    expect(mock.$queryRaw).not.toHaveBeenCalled();
    expect(await captureMarketingCampaign(db, scope, row.id, now)).toMatchObject({
      prepared: 1,
      replay: false,
    });
    expect(captures).toEqual([
      expect.objectContaining({
        idempotencyKey: 'marketing:campaign-a:customer-a:v1',
        channel: 'WHATSAPP',
        capturedAt: now,
      }),
    ]);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(3);
    expect(await captureMarketingCampaign(db, scope, row.id, now)).toMatchObject({
      prepared: 1,
      replay: true,
    });
    expect(captures).toHaveLength(1);
  });
  it('uses completed receipts without returns and selects no clinical lines', async () => {
    await previewMarketingCampaign(db, scope, row.id, now);
    expect(mock.pharmacySale.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['customerId'],
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          customerId: { not: null },
          status: 'COMPLETED',
          completedAt: { lte: now },
          returns: { none: {} },
        },
      })
    );
  });
  it.each([false, null])(
    'excludes global consent %s despite granted purpose consent',
    async (value) => {
      optIn = value;
      await captureMarketingCampaign(db, scope, row.id, now);
      expect(captures).toEqual([]);
      expect(exclusions[0]).toMatchObject({ reason: value === false ? 'OPTED_OUT' : 'NO_CONSENT' });
      expect(mock.patientConsent.findFirst).not.toHaveBeenCalled();
    }
  );
  it('reads latest MARKETING/WHATSAPP consent and honors revocation', async () => {
    revokedAt = now;
    expect(await marketingConsent(db, scope, 'customer-a', now)).toBe('OPTED_OUT');
    expect(mock.patientConsent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          patientId: 'patient-a',
          purpose: 'MARKETING',
          channel: 'WHATSAPP',
        },
        orderBy: [{ version: 'desc' }, { id: 'asc' }],
      })
    );
  });
  it('applies persisted caps across campaigns and branches', async () => {
    captures.push({
      campaignId: 'other-campaign',
      branchId: 'other-branch',
      customerId: 'customer-a',
    });
    expect(await captureMarketingCampaign(db, scope, row.id, now)).toMatchObject({
      prepared: 0,
      exclusions: { FREQUENCY_CAP: 1 },
    });
    expect(mock.pharmacyCampaignCapture.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        customerId: 'customer-a',
        channel: 'WHATSAPP',
        capturedAt: { gte: new Date('2026-09-29T07:00:00Z') },
      },
    });
  });
  it('checks workspace timezone, due time, approval, and regulatory gate', async () => {
    await expect(
      captureMarketingCampaign(db, scope, row.id, new Date('2026-10-06T18:00:00Z'))
    ).rejects.toThrow('quiet hours');
    row.scheduledAt = new Date('2026-10-07T07:00:00Z');
    await expect(captureMarketingCampaign(db, scope, row.id, now)).rejects.toThrow('not due');
    row.scheduledAt = now;
    row.status = 'DRAFT';
    await expect(captureMarketingCampaign(db, scope, row.id, now)).rejects.toThrow(
      'Owner approval'
    );
    row.status = 'APPROVED';
    row.promotesRegulatedItem = true;
    await expect(captureMarketingCampaign(db, scope, row.id, now)).rejects.toThrow('Regulated');
    expect(captures).toEqual([]);
  });
  it('reads quiet hours in UTC for a stored zone Intl refuses, instead of throwing', () => {
    const refused = { ...scope, timezone: 'PKT' };
    // 23:00 UTC is inside the 22:00-08:00 quiet hours; 12:00 UTC is not.
    expect(() =>
      requireCaptureWindow(campaign() as never, refused, new Date('2026-10-06T23:00:00Z'))
    ).toThrow('quiet hours');
    expect(() =>
      requireCaptureWindow(campaign() as never, refused, new Date('2026-10-06T12:00:00Z'))
    ).not.toThrow();
  });
  it('fails before mutation when the bounded audience is exceeded', async () => {
    mock.pharmacySale.groupBy.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => ({
        customerId: `customer-${index}`,
        _count: { _all: 1 },
        _max: { completedAt: now },
      }))
    );
    await expect(captureMarketingCampaign(db, scope, row.id, now)).rejects.toThrow('500-customer');
    expect(captures).toEqual([]);
  });
});

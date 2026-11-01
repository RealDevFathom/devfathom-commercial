import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Campaign } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { selectSegment, type Candidate } from './segments';
import { campaignCode, redeemCode, validateCode } from './codes';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_id: string, run: (db: unknown) => unknown) => run(holder.db),
}));
vi.mock('@/lib/pharmacy/consent-writer', () => ({ lockCustomerConsent: vi.fn() }));
import {
  advanceCampaigns,
  affordableReach,
  assertCampaignPolicy,
  campaignInput,
  createCampaign,
  dispatchCampaignMessage,
  renderCampaign,
  transitionCampaign,
} from './campaigns';
import { assertMarketingCopyAllowed } from './drug-guard';
import { type WhatsAppProvider } from '@/lib/pharmacy/whatsapp/provider';

const now = new Date('2026-10-21T08:00:00Z');
const day = 86400000;
function candidate(id: string, patch: Partial<Candidate> = {}): Candidate {
  return {
    id,
    active: true,
    whatsappOptIn: true,
    whatsappE164: '+923001234567',
    patient: { dateOfBirth: new Date('1995-10-22T00:00:00Z') },
    growthMetrics: {
      churnBand: 'high',
      nextRefillDueAt: new Date(now.getTime() + day),
      lastPurchaseAt: new Date(now.getTime() - 40 * day),
      spend90dMinor: 10000,
    },
    growthRecipients: [],
    ...patch,
  };
}
function campaign(patch = {}): Campaign {
  return {
    id: 'campaign-1',
    organizationId: 'org-1',
    kind: 'manual',
    status: 'approved',
    name: 'Front shop offer',
    segment: { type: 'all' },
    sendAt: now,
    discountType: 'fixed',
    discountValue: 100,
    codeExpiresAt: new Date(now.getTime() + day),
    budgetCapMinor: 300,
    spentMinor: 0,
    templateId: 'template-1',
    estimatedReach: 0,
    createdBy: 'owner-1',
    approvedBy: 'owner-1',
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
    rationale: null,
    ...patch,
  };
}

describe('G5 segments', () => {
  const a = candidate('a'),
    b = candidate('b', {
      growthMetrics: { ...a.growthMetrics!, churnBand: 'low', spend90dMinor: 20000 },
    });
  it.each([
    [{ type: 'all' }, ['a', 'b']],
    [{ type: 'churn_band', band: 'high' }, ['a']],
    [{ type: 'birthday', month: 10, dayWindow: 2 }, ['a', 'b']],
    [{ type: 'refill_due', withinDays: 3 }, ['a', 'b']],
    [{ type: 'random', pct: 100, seed: 'stable' }, ['a', 'b']],
    [{ type: 'top_spenders', n: 1 }, ['b']],
    [{ type: 'inactive_days', min: 30, max: 50 }, ['a', 'b']],
  ])('resolves %j', (segment, expected) =>
    expect(selectSegment([a, b], segment, now)).toEqual(expected)
  );
  it('ranks top spenders by BigInt 90-day spend beyond the safe integer range', () => {
    const big = candidate('big', {
      growthMetrics: {
        ...a.growthMetrics!,
        spend90dMinor: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2),
      },
    });
    const bigger = candidate('bigger', {
      growthMetrics: {
        ...a.growthMetrics!,
        spend90dMinor: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(3),
      },
    });
    expect(selectSegment([big, a, bigger], { type: 'top_spenders', n: 2 }, now)).toEqual([
      'bigger',
      'big',
    ]);
  });
  it('excludes missing consent/number, inactive and seven-day cooldown', () => {
    expect(
      selectSegment(
        [
          candidate('no-consent', { whatsappOptIn: false }),
          candidate('no-number', { whatsappE164: null }),
          candidate('inactive', { active: false }),
          candidate('cooldown', { growthRecipients: [{ sentAt: now }] }),
          a,
        ],
        { type: 'all' },
        now
      )
    ).toEqual(['a']);
  });
  it('samples deterministically and handles missing metrics and birthday bounds', () => {
    const input = Array.from({ length: 100 }, (_, i) => candidate(String(i)));
    const segment = { type: 'random', pct: 25, seed: 'seed' };
    const result = selectSegment(input, segment, now);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(100);
    expect(selectSegment(input, segment, now)).toEqual(result);
    expect(
      selectSegment(
        [candidate('none', { growthMetrics: null })],
        { type: 'inactive_days', min: 0, max: 100 },
        now
      )
    ).toEqual([]);
    expect(selectSegment([a], { type: 'birthday', month: 11, dayWindow: 2 }, now)).toEqual([]);
    expect(() => selectSegment([a], { type: 'sql' }, now)).toThrow();
  });
});

describe('G5 policy, rendering and budgets', () => {
  it.each(['دوائی', 'dawai', 'Panadol', 'x a n a x'])(
    'rejects prohibited create copy %s',
    async (word) => {
      const db = {
        medicine: { findMany: vi.fn(async () => []) },
        messageTemplate: {
          findFirstOrThrow: vi.fn(async () => ({ body: `Offer ${word}. STOP`, key: 'generic' })),
        },
        campaign: { create: vi.fn() },
      };
      const input = {
        kind: 'manual' as const,
        name: 'Offer',
        segment: { type: 'all' },
        sendAt: now,
        templateId: 'template-1',
        discountType: 'none' as const,
        discountValue: 0,
        budgetCapMinor: 100,
      };
      await expect(
        createCampaign(db as unknown as ScopedDb, 'org-1', 'maker', input)
      ).rejects.toThrow();
      expect(db.messageTemplate.findFirstOrThrow).toHaveBeenCalled();
      expect(db.campaign.create).not.toHaveBeenCalled();
    }
  );

  it('checks rendered products and tenant-specific drug names, failing closed on lookup errors', async () => {
    const db = {
      medicine: {
        findMany: vi.fn(async () => [
          { productName: 'LocalBrand', brandName: null, aliases: [], strengths: [] },
        ]),
      },
    };
    for (const product of ['Xanax', 'LocalBrand']) {
      await expect(
        assertMarketingCopyAllowed(
          db,
          'org-1',
          renderCampaign('Offer {{product}} STOP', { product })
        )
      ).rejects.toThrow();
    }
    expect(db.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) })
    );
    db.medicine.findMany.mockRejectedValue(new Error('lookup unavailable'));
    await expect(assertMarketingCopyAllowed(db, 'org-1', 'Hello STOP')).rejects.toThrow();
  });
  it('shrinks fixed and percent reach against campaign and monthly caps', () => {
    expect(affordableReach(100, campaign(), 10000, 80)).toBe(10);
    expect(
      affordableReach(100, campaign({ discountType: 'percent', discountValue: 10 }), 10000, 10000)
    ).toBe(3);
    expect(affordableReach(100, campaign({ discountType: 'none', discountValue: 0 }), 0, 0)).toBe(
      100
    );
    expect(
      affordableReach(100, campaign({ discountType: 'percent', discountValue: 10 }), 0, 500)
    ).toBe(0);
  });
  it('requires valid discounts and expiry, STOP and complete variables', () => {
    expect(renderCampaign('Hello {{name}}. STOP', { name: 'Saad' })).toBe('Hello Saad. STOP');
    expect(() => renderCampaign('{{code}} STOP', {})).toThrow('Missing');
    expect(() => renderCampaign('Hello', {})).toThrow();
    expect(
      campaignInput.safeParse({ ...campaign(), discountValue: 101, discountType: 'percent' })
        .success
    ).toBe(false);
    expect(campaignCode('Demo Pharmacy')).toMatch(/^DEMO-[A-Z2-7]{6}$/);
  });
  it('blocks medicine/Rx offers and keeps refill reminders utility-only', () => {
    for (const word of ['medicine', 'drug', 'Rx', 'prescription', '{{product}}'])
      expect(() => assertCampaignPolicy(campaign(), `Sale on ${word}. STOP`, 'generic')).toThrow();
    const refill = campaign({
      kind: 'refill',
      discountType: 'none',
      discountValue: 0,
      segment: { type: 'refill_due', withinDays: 3 },
    });
    expect(() =>
      assertCampaignPolicy(refill, 'Your {{product}} may be running low. STOP', 'refill_reminder')
    ).not.toThrow();
    expect(() =>
      assertCampaignPolicy({ ...refill, discountValue: 5 }, 'Reminder STOP', 'refill_reminder')
    ).toThrow();
    expect(() => assertCampaignPolicy(refill, 'Special offer STOP', 'refill_reminder')).toThrow();
    expect(() =>
      assertCampaignPolicy(campaign({ segment: refill.segment }), 'Hi STOP', 'generic')
    ).toThrow();
  });
});

function fixture(patch = {}) {
  const c = {
    ...campaign(patch),
    template: { body: 'Hello {{name}}! {{discount}}. Code {{code}}. STOP', key: 'generic' },
  };
  const recipients: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const customers = ['a', 'b', 'c'].map((id) => ({
    ...candidate(id),
    displayName: id,
    patientId: id,
  }));
  const settings = {
    monthlyBudgetMinor: 10000,
    quietHoursStart: 21,
    quietHoursEnd: 9,
    maxMsgsPerDay: 3,
    minSecondsBetweenMsgs: 4,
  };
  const db = {
    $executeRawUnsafe: vi.fn(async () => 0),
    medicine: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    organization: {
      findUniqueOrThrow: async () => ({ displayName: 'Demo Pharmacy', timezone: 'Asia/Karachi' }),
    },
    growthSettings: { findUnique: async () => settings, findUniqueOrThrow: async () => settings },
    customerMetrics: {
      aggregate: async () => ({ _sum: { spend90dMinor: BigInt(30000), orders90d: 3 } }),
    },
    pharmacyCustomer: {
      findMany: async () => customers,
      findFirstOrThrow: async ({ where }: { where: { id: string } }) =>
        customers.find((x) => x.id === where.id),
    },
    campaign: {
      findMany: async ({ where }: { where: { id?: unknown } }) => (where.id ? [] : [{ ...c }]),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (where.id !== c.id) return c;
          Object.assign(c, data);
          return c;
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { organizationId: string; status: { in: string[] }; createdBy?: { not: string } };
          data: object;
        }) => {
          if (
            where.organizationId !== c.organizationId ||
            where.createdBy?.not === c.createdBy ||
            !where.status.in.includes(c.status)
          )
            return { count: 0 };
          Object.assign(c, data);
          return { count: 1 };
        }
      ),
    },
    campaignRecipient: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        recipients.push(...data.map((r, i) => ({ ...r, id: `recipient-${i}`, campaign: c })));
      },
      findMany: async () => [],
      count: async () => recipients.filter((r) => r.status === 'queued').length,
      findFirst: async () =>
        c.status === 'sending' ? recipients.find((r) => r.status === 'queued') : null,
      update: async ({ where, data }: { where: { id: string }; data: object }) => {
        const r = recipients.find((r) => r.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async () => {
        for (const r of recipients) if (r.status === 'queued') r.status = 'skipped';
      },
    },
    pharmacyMessageLog: {
      findMany: async () => logs.map((l) => ({ createdAt: l.createdAt })).reverse(),
      createManyAndReturn: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        if (logs.some((l) => l.dedupeKey === data[0].dedupeKey)) return [];
        const log = {
          ...data[0],
          id: `log-${logs.length}`,
          createdAt: new Date(now.getTime() + logs.length * 5000),
        };
        logs.push(log);
        return [{ id: log.id }];
      },
      update: async ({ where, data }: { where: { id: string }; data: object }) => {
        const l = logs.find((l) => l.id === where.id)!;
        Object.assign(l, data);
        return l;
      },
    },
  };
  holder.db = db;
  return { db: db as unknown as ScopedDb, raw: db, c, recipients, logs, customers, settings };
}
function provider() {
  return {
    name: 'mock',
    sendText: vi.fn(async () => ({ providerMessageId: 'accepted', acceptedByProvider: true })),
  } as unknown as WhatsAppProvider;
}
beforeEach(() => vi.clearAllMocks());
describe('G5 lifecycle and existing outbox', () => {
  it('rejects creator approval while allowing another actor', async () => {
    const f = fixture({ status: 'proposed' });
    await expect(transitionCampaign(f.db, 'org-1', 'owner-1', f.c.id, 'approve')).rejects.toThrow();
    expect(f.c.status).toBe('proposed');
    await transitionCampaign(f.db, 'org-1', 'reviewer', f.c.id, 'approve');
    expect(f.c.approvedBy).toBe('reviewer');
  });
  it('logs a broken campaign and advances the following campaign', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.raw.campaign.findMany = async ({ where }) =>
      where.id
        ? []
        : [{ ...f.c, id: 'bad', template: { ...f.c.template, body: 'Rx sale STOP' } }, f.c];
    await advanceCampaigns(f.db, 'org-1', now);
    expect(f.c.status).toBe('scheduled');
    expect(log).toHaveBeenCalledWith(
      'Campaign tick failed',
      expect.objectContaining({ campaignId: 'bad' })
    );
    expect(f.raw.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT growth_campaign');
    log.mockRestore();
  });
  it.each(['Xanax', 'زاناکس', 'Xаnаx', 'x a n a x'])(
    'blocks rendered customer drug text %s before claiming or sending',
    async (name) => {
      const f = fixture();
      const p = provider();
      await advanceCampaigns(f.db, 'org-1', now);
      await advanceCampaigns(f.db, 'org-1', now);
      f.customers[0].displayName = name;
      await expect(dispatchCampaignMessage('org-1', now, p)).rejects.toThrow();
      expect(p.sendText).not.toHaveBeenCalled();
      expect(f.logs).toHaveLength(0);
    }
  );
  it('moves three recipients approved → scheduled → sending → sent in three ticks', async () => {
    const f = fixture();
    const p = provider();
    await advanceCampaigns(f.db, 'org-1', now);
    expect(f.c.status).toBe('scheduled');
    expect(f.recipients).toHaveLength(3);
    expect(new Set(f.recipients.map((r) => r.code)).size).toBe(3);
    await advanceCampaigns(f.db, 'org-1', now);
    expect(f.c.status).toBe('sending');
    for (let i = 0; i < 3; i++)
      await dispatchCampaignMessage('org-1', new Date(now.getTime() + i * 5000), p);
    await advanceCampaigns(f.db, 'org-1', new Date(now.getTime() + 15000));
    expect(f.c.status).toBe('sent');
    expect(p.sendText).toHaveBeenCalledTimes(3);
    expect(f.logs.every((l) => l.status === 'SENT' && l.campaignId === f.c.id)).toBe(true);
    await dispatchCampaignMessage('org-1', new Date(now.getTime() + 20000), p);
    expect(p.sendText).toHaveBeenCalledTimes(3);
  });
  it('records budget trimming and refuses wrong-tenant/duplicate approval', async () => {
    const f = fixture({ budgetCapMinor: 8 });
    await advanceCampaigns(f.db, 'org-1', now);
    expect(f.recipients).toHaveLength(1);
    expect(f.c.rationale).toContain('from 3 to 1');
    await expect(
      transitionCampaign(f.db, 'other-org', 'owner', f.c.id, 'approve')
    ).rejects.toThrow();
    await expect(transitionCampaign(f.db, 'org-1', 'owner', f.c.id, 'approve')).rejects.toThrow();
    await transitionCampaign(f.db, 'org-1', 'owner', f.c.id, 'cancel');
    expect(f.c.status).toBe('cancelled');
    expect(f.recipients[0].status).toBe('skipped');
  });
  it('rechecks consent and respects quiet hours, spacing, and daily cap', async () => {
    const f = fixture();
    const p = provider();
    await advanceCampaigns(f.db, 'org-1', now);
    await advanceCampaigns(f.db, 'org-1', now);
    await dispatchCampaignMessage('org-1', new Date('2026-10-21T17:00:00Z'), p);
    expect(p.sendText).not.toHaveBeenCalled();
    f.customers[0].whatsappOptIn = false;
    await dispatchCampaignMessage('org-1', now, p);
    expect(f.recipients[0].status).toBe('skipped');
    await dispatchCampaignMessage('org-1', now, p);
    await dispatchCampaignMessage('org-1', now, p);
    expect(p.sendText).toHaveBeenCalledTimes(1);
    f.settings.maxMsgsPerDay = 1;
    await dispatchCampaignMessage('org-1', new Date(now.getTime() + 10000), p);
    expect(p.sendText).toHaveBeenCalledTimes(1);
  });
  it('does not call mock preparation a successful send or retry unknown delivery', async () => {
    const f = fixture();
    const p = provider();
    vi.mocked(p.sendText).mockRejectedValue(new Error('transport failed'));
    await advanceCampaigns(f.db, 'org-1', now);
    await advanceCampaigns(f.db, 'org-1', now);
    expect(await dispatchCampaignMessage('org-1', now, p)).toBe('UNKNOWN');
    expect(f.recipients[0].status).toBe('unknown');
    expect(f.logs[0].status).toBe('PENDING');
  });
});

describe('G5 POS redemption', () => {
  it('rejects walk-ins, then redeems once for the matching customer and exhausts budget', async () => {
    const c = campaign({ status: 'sent', budgetCapMinor: 100 });
    const r = {
      id: 'recipient',
      code: 'DEMO-ABCDEF',
      customerId: 'a',
      status: 'sent',
      redeemedAt: null as Date | null,
      campaign: c,
    };
    const sale = {
      id: 'sale',
      status: 'OPEN',
      discountCode: null as string | null,
      customerId: null as string | null,
      lines: [
        {
          id: 'line',
          quantity: 1,
          unitPriceMinor: 1000,
          unitCostMinor: 500,
          discountMinor: 0,
          medicine: {
            productFamily: 'FRONT_SHOP',
            rx: false,
            controlled: false,
            restricted: false,
          },
        },
      ],
    };
    const db = {
      organization: { findUniqueOrThrow: async () => ({ timezone: 'Asia/Karachi' }) },
      $queryRaw: vi.fn(),
      growthSettings: { findUniqueOrThrow: async () => ({ monthlyBudgetMinor: 1000 }) },
      campaignRecipient: {
        findFirst: async ({ where }: { where: { organizationId: string } }) =>
          where.organizationId === 'org-1' ? r : null,
        findMany: async () => [],
        update: async ({ data }: { data: object }) => Object.assign(r, data),
      },
      pharmacySale: {
        findFirst: async () => sale,
        findFirstOrThrow: async () => sale,
        updateMany: async () => ({ count: 1 }),
        update: async ({ data }: { data: object }) => Object.assign(sale, data),
      },
      pharmacySaleLine: { update: vi.fn(async () => ({})) },
      campaign: {
        update: async ({
          data,
        }: {
          data: { status?: string; spentMinor: { increment: number } };
        }) => {
          c.spentMinor += data.spentMinor.increment;
          c.status = data.status ?? c.status;
        },
      },
    };
    await expect(
      redeemCode(
        db as unknown as ScopedDb,
        'other-org',
        { code: r.code, saleId: 'sale', branchId: 'branch' },
        now
      )
    ).rejects.toThrow();
    await expect(
      redeemCode(
        db as unknown as ScopedDb,
        'org-1',
        { code: r.code, saleId: 'sale', branchId: 'branch' },
        now
      )
    ).rejects.toThrow('unavailable');
    expect(sale.customerId).toBeNull();
    expect(db.pharmacySaleLine.update).not.toHaveBeenCalled();
    sale.customerId = 'a';
    const result = await redeemCode(
      db as unknown as ScopedDb,
      'org-1',
      { code: r.code, saleId: 'sale', branchId: 'branch' },
      now
    );
    expect(result).toEqual({ customerId: 'a', discountMinor: 100 });
    expect(sale.customerId).toBe('a');
    expect(c.status).toBe('exhausted');
    expect(r.status).toBe('redeemed');
    expect(db.pharmacySaleLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discountMinor: 100, discountKind: 'PROMOTION' }),
      })
    );
    await expect(
      redeemCode(
        db as unknown as ScopedDb,
        'org-1',
        { code: r.code, saleId: 'sale', branchId: 'branch' },
        now
      )
    ).rejects.toThrow();
  });
  it('refuses expiry, wrong customer, redeemed, cancelled, and exhausted codes', () => {
    const r = { redeemedAt: null, status: 'sent', customerId: 'a' };
    const c = campaign({ status: 'sent' });
    expect(() => validateCode(r, c, 'a', now)).not.toThrow();
    expect(() => validateCode({ ...r, status: 'unknown' }, c, 'a', now)).not.toThrow();
    for (const bad of [
      { ...c, status: 'cancelled' },
      { ...c, status: 'exhausted' },
      { ...c, codeExpiresAt: now },
      { ...c, spentMinor: 300 },
    ])
      expect(() => validateCode(r, bad, 'a', now)).toThrow();
    expect(() => validateCode(r, c, 'b', now)).toThrow();
    expect(() => validateCode({ ...r, redeemedAt: now }, c, 'a', now)).toThrow();
  });
});

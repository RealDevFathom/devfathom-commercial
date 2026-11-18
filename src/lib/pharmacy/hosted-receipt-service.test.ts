import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CounterReceipt } from './counter-receipt';
import { hashHostedReceiptToken } from './hosted-receipt';
import { MockWhatsAppProvider, readWhatsAppConfig } from './whatsapp/provider';

type Link = {
  id: string;
  organizationId: string;
  branchId: string;
  saleId: string;
  customerId: string;
  tokenHash: string;
  rxProtected: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
  createdByUserId: string;
};

const state = vi.hoisted(() => ({
  links: [] as Link[],
  claims: [] as Record<string, unknown>[],
  claimResult: 'log-1' as string | null,
  sale: null as Record<string, unknown> | null,
  customer: null as Record<string, unknown> | null,
  branchName: 'Gulberg Branch',
  claimCommitted: true,
  deliveries: [] as Promise<unknown>[],
}));

vi.mock('./whatsapp/message-log', () => ({
  claimMessageLogInTransaction: vi.fn(async (_db: unknown, entry: Record<string, unknown>) => {
    state.claims.push(entry);
    return state.claimResult;
  }),
  sendClaimedMessage: vi.fn(
    async (_entry: unknown, _logId: string, send: () => Promise<unknown>) => {
      await send();
      return 'PREPARED';
    }
  ),
}));

vi.mock('./medicine-names', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./medicine-names')>();
  return {
    ...actual,
    readTenantMedicineNames: vi.fn(async () => actual.medicineNameSet(['Calpol', 'Paracetamol'])),
  };
});

vi.mock('@/lib/tenancy/host-routing', () => ({
  tenantHostUrl: (slug: string, path: string) => `https://${slug}.devfathom.app${path}`,
}));

function counterReceipt(): CounterReceipt {
  return {
    saleId: 'sale-1',
    receiptNumber: 1042,
    branchName: state.branchName,
    businessDate: '2026-11-15',
    completedAt: '2026-11-15T07:00:00.000Z',
    cashierName: 'Cashier Name',
    currency: 'PKR',
    lines: [
      {
        saleLineId: 'line-1',
        identityStatus: 'ISSUED',
        medicineName: 'Augmentin',
        strength: '625 mg',
        presentation: 'Tablet',
        batchNumber: 'B-77',
        expiresAt: '2027-12-01',
        saleUnit: 'STRIP',
        quantity: 2,
        canonicalUnits: 12,
        unitPriceMinor: 50_000,
        discountMinor: 0,
        lineTotalMinor: 100_000,
      },
      {
        saleLineId: 'line-2',
        identityStatus: 'ISSUED',
        medicineName: 'Calpol',
        strength: '500 mg',
        presentation: 'Tablet',
        batchNumber: 'B-12',
        expiresAt: '2027-06-01',
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnits: 10,
        unitPriceMinor: 20_000,
        discountMinor: 0,
        lineTotalMinor: 20_000,
      },
    ],
    tenders: [
      {
        tenderId: 'tender-1',
        type: 'CASH',
        amountMinor: 120_000,
        cashReceivedMinor: 120_000,
        changeGivenMinor: 0,
      },
    ],
    totals: {
      grossMinor: 120_000,
      discountMinor: 0,
      netMinor: 120_000,
      tenderedMinor: 120_000,
      changeMinor: 0,
    },
  };
}

vi.mock('./counter', () => ({ readCounterReceipt: vi.fn(async () => counterReceipt()) }));

function matches(link: Link, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && link.id !== where.id) return false;
  if (where.tokenHash !== undefined && link.tokenHash !== where.tokenHash) return false;
  if (where.revokedAt === null && link.revokedAt !== null) return false;
  const expires = where.expiresAt as { gt: Date } | undefined;
  if (expires && !(link.expiresAt > expires.gt)) return false;
  return true;
}

function applyUpdate(link: Link, data: Record<string, unknown>) {
  Object.assign(link, data);
}

const db = {
  organization: {
    findUnique: vi.fn(async () => ({ slug: 'acme', timezone: 'Asia/Karachi', currency: 'PKR' })),
  },
  pharmacyBranch: { findFirst: vi.fn(async () => ({ name: state.branchName })) },
  pharmacySale: { findFirst: vi.fn(async () => state.sale) },
  pharmacyCustomer: { findFirst: vi.fn(async () => state.customer) },
  pharmacyHostedReceipt: {
    create: vi.fn(
      async ({
        data,
      }: {
        data: Pick<
          Link,
          | 'organizationId'
          | 'branchId'
          | 'saleId'
          | 'customerId'
          | 'tokenHash'
          | 'rxProtected'
          | 'expiresAt'
          | 'createdByUserId'
        >;
      }) => {
        const link: Link = {
          id: `link-${state.links.length + 1}`,
          revokedAt: null,
          ...data,
        };
        state.links.push(link);
        return { id: link.id };
      }
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const link = state.links.find((row) => matches(row, where));
      return link ? { ...link } : null;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const link = state.links.find((row) => row.id === where.id);
        if (link) applyUpdate(link, data);
        return { count: link ? 1 : 0 };
      }
    ),
  },
  $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db)),
  pharmacyMessageLog: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.claimCommitted ? { id: where.id } : null
    ),
  },
};

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (tx: unknown) => Promise<unknown>) =>
    run(db)
  ),
}));

const { openHostedReceipt, sendWhatsAppReceiptLink } = await import('./hosted-receipt-service');
const { readCounterReceipt } = await import('./counter');
const { HostedReceiptError } = await import('./hosted-receipt');

const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org-1',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'phone-1',
  PHARMACY_WHATSAPP_TEMPLATE_RECEIPT_LINK: 'receipt_link_v1',
});
const scope = { organizationId: 'org-1', branchId: 'branch-1' };
const now = new Date('2026-11-15T07:05:00.000Z');

function saleWith(line: { rx?: boolean; prescriptionLineId?: string | null } = {}) {
  return {
    status: 'COMPLETED',
    receiptNumber: 1042,
    completedAt: new Date('2026-11-15T07:00:00.000Z'),
    customerId: 'customer-1',
    lines: [
      {
        prescriptionLineId: line.prescriptionLineId ?? null,
        medicine: {
          rx: line.rx ?? false,
          controlled: false,
          restricted: false,
          productName: 'Augmentin 625mg Tablet',
          brandName: 'Augmentin',
          strengths: [{ ingredient: { name: 'Amoxicillin' } }],
        },
      },
    ],
  };
}

async function send(
  options: { provider?: MockWhatsAppProvider; env?: Record<string, string> } = {}
) {
  const result = await sendWhatsAppReceiptLink({
    db: db as never,
    scope,
    saleId: 'sale-1',
    actorUserId: 'cashier-1',
    now,
    config,
    provider: options.provider ?? new MockWhatsAppProvider(config),
    env: options.env ?? {},
    // Stands in for "after the request transaction ends".
    defer: (work) => {
      state.deliveries.push(work());
    },
  });
  await Promise.all(state.deliveries);
  return result;
}

async function delivered() {
  return Promise.all(state.deliveries);
}

function tokenFrom(provider: MockWhatsAppProvider): string {
  const call = provider.calls[0];
  if (call?.kind !== 'template') throw new Error('no template call');
  return call.parameters[4]!.split('/receipt/')[1]!;
}

beforeEach(() => {
  state.links = [];
  state.claims = [];
  state.claimResult = 'log-1';
  state.branchName = 'Gulberg Branch';
  state.claimCommitted = true;
  state.deliveries = [];
  state.sale = saleWith();
  state.customer = {
    id: 'customer-1',
    patientId: 'patient-1',
    active: true,
    whatsappOptIn: true,
    patient: { phone: '0300 1234567' },
  };
  vi.clearAllMocks();
});

describe('DEV-16 sendWhatsAppReceiptLink', () => {
  it('sends a neutral template with branch, number, total, method and an expiring link only', async () => {
    const provider = new MockWhatsAppProvider(config);
    const result = await send({ provider });

    expect(result).toEqual({
      outcome: 'QUEUED',
      expiresAt: '2026-12-15T07:05:00.000Z',
      rxProtected: false,
    });
    await expect(delivered()).resolves.toEqual(['PREPARED']);
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call).toMatchObject({
      kind: 'template',
      to: '923001234567',
      template: 'receiptLink',
      templateName: 'receipt_link_v1',
    });
    const parameters = call.kind === 'template' ? call.parameters : [];
    expect(parameters.slice(0, 4)).toEqual(['Gulberg Branch', '1042', 'PKR 1200.00', 'Cash']);
    expect(parameters[4]).toMatch(
      /^https:\/\/acme\.devfathom\.app\/receipt\/[0-9a-hjkmnp-tv-z]{32}$/
    );
    const text = parameters.join(' ').toLowerCase();
    for (const item of [
      'augmentin',
      'amoxicillin',
      'calpol',
      '625',
      '500',
      'strip',
      'tablet',
      'b-77',
    ])
      expect(text).not.toContain(item);

    const token = tokenFrom(provider);
    expect(state.links).toHaveLength(1);
    expect(state.links[0]).toMatchObject({
      saleId: 'sale-1',
      customerId: 'customer-1',
      tokenHash: hashHostedReceiptToken(token),
      rxProtected: false,
      createdByUserId: 'cashier-1',
    });
    expect(JSON.stringify(state.links[0])).not.toContain(token);
    expect(state.claims[0]).toMatchObject({
      kind: 'RECEIPT_LINK',
      dedupeKey: 'receipt-link:sale-1:2026-11-15',
      phoneLast4: '4567',
    });
  });

  it('uses the configured expiry, bounded to 90 days', async () => {
    await expect(send({ env: { PHARMACY_RECEIPT_LINK_TTL_DAYS: '60' } })).resolves.toMatchObject({
      expiresAt: '2027-01-14T07:05:00.000Z',
    });
    await expect(send({ env: { PHARMACY_RECEIPT_LINK_TTL_DAYS: '400' } })).resolves.toMatchObject({
      expiresAt: '2027-02-13T07:05:00.000Z',
    });
  });

  it('records for audit whether the sale had Rx lines', async () => {
    state.sale = saleWith({ rx: true });
    await expect(send()).resolves.toMatchObject({ rxProtected: true });
    state.sale = saleWith({ prescriptionLineId: 'rx-line-1' });
    await expect(send()).resolves.toMatchObject({ rxProtected: true });
  });

  it('refuses text that would name a medicine, its salt or category, and sends nothing', async () => {
    for (const branchName of [
      'Augmentin Corner',
      'Amoxicillin Point',
      'Calpol House',
      'Rx Store',
    ]) {
      state.branchName = branchName;
      const provider = new MockWhatsAppProvider(config);
      await expect(send({ provider })).rejects.toMatchObject({ reason: 'NOT_NEUTRAL' });
      expect(provider.calls).toHaveLength(0);
    }
    expect(state.claims).toHaveLength(0);
    expect(state.links).toHaveLength(0);
  });

  it('sends only to an opted-in customer with a valid number on a settled sale', async () => {
    const provider = new MockWhatsAppProvider(config);
    state.customer = { ...state.customer!, whatsappOptIn: null };
    await expect(send({ provider })).rejects.toMatchObject({ reason: 'NO_CONSENT' });
    state.customer = { ...state.customer!, whatsappOptIn: true, patient: { phone: '12' } };
    await expect(send({ provider })).rejects.toMatchObject({ reason: 'NO_PHONE' });
    state.sale = { ...saleWith(), customerId: null };
    await expect(send({ provider })).rejects.toMatchObject({ reason: 'NO_CUSTOMER' });
    state.sale = { ...saleWith(), status: 'OPEN', receiptNumber: null };
    await expect(send({ provider })).rejects.toBeInstanceOf(HostedReceiptError);
    expect(provider.calls).toHaveLength(0);
    expect(state.links).toHaveLength(0);
  });

  it('refuses when the sender is not this tenant’s or the template is not approved', async () => {
    await expect(
      sendWhatsAppReceiptLink({
        db: db as never,
        scope,
        saleId: 'sale-1',
        actorUserId: 'cashier-1',
        config: { ...config, organizationId: 'other-org' },
      })
    ).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    await expect(
      sendWhatsAppReceiptLink({
        db: db as never,
        scope,
        saleId: 'sale-1',
        actorUserId: 'cashier-1',
        config: { ...config, templates: { ...config.templates, receiptLink: null } },
      })
    ).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
  });

  it('never sends inside the request transaction, only after it commits', async () => {
    const provider = new MockWhatsAppProvider(config);
    let deferred: (() => Promise<unknown>) | null = null;
    const result = await sendWhatsAppReceiptLink({
      db: db as never,
      scope,
      saleId: 'sale-1',
      actorUserId: 'cashier-1',
      now,
      config,
      provider,
      env: {},
      defer: (work) => {
        deferred = work;
      },
    });
    expect(result.outcome).toBe('QUEUED');
    expect(state.claims).toHaveLength(1);
    expect(state.links).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
    await deferred!();
    expect(provider.calls).toHaveLength(1);
  });

  it('defers delivery to the tenant transaction by default', async () => {
    const { bindSideEffects } = await import('@/lib/side-effects/scope');
    const provider = new MockWhatsAppProvider(config);
    const scopeAfter = await bindSideEffects(async (sideEffects) => {
      await sendWhatsAppReceiptLink({
        db: db as never,
        scope,
        saleId: 'sale-1',
        actorUserId: 'cashier-1',
        now,
        config,
        provider,
        env: {},
      });
      return sideEffects.afterTransaction;
    });
    expect(scopeAfter).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
    for (const work of scopeAfter) work();
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  });

  it('sends nothing when the request transaction rolled the claim back', async () => {
    state.claimCommitted = false;
    const provider = new MockWhatsAppProvider(config);
    await send({ provider });
    await expect(delivered()).resolves.toEqual(['SKIPPED']);
    expect(provider.calls).toHaveLength(0);
  });

  it('revokes the link when WhatsApp definitively refuses the message', async () => {
    const { sendClaimedMessage } = await import('./whatsapp/message-log');
    vi.mocked(sendClaimedMessage).mockResolvedValueOnce('FAILED');
    await send();
    await expect(delivered()).resolves.toEqual(['FAILED']);
    expect(state.links[0]!.revokedAt).toEqual(now);
  });

  it('needs only the receipt-link template: no code template or code message exists', async () => {
    const provider = new MockWhatsAppProvider(config);
    state.sale = saleWith({ rx: true });
    await expect(send({ provider })).resolves.toMatchObject({ outcome: 'QUEUED' });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ template: 'receiptLink' });
    expect(Object.keys(config.templates)).not.toContain('receiptOtp');
    expect(state.claims.map((claim) => claim.kind)).toEqual(['RECEIPT_LINK']);
  });

  it('sends at most one receipt message per sale per day', async () => {
    state.claimResult = null;
    const provider = new MockWhatsAppProvider(config);
    await expect(send({ provider })).resolves.toMatchObject({ outcome: 'DUPLICATE' });
    expect(provider.calls).toHaveLength(0);
    expect(state.links).toHaveLength(0);
  });
});

describe('DEV-16 hosted receipt access', () => {
  const fullReceipt = {
    branchName: 'Gulberg Branch',
    receiptNumber: 1042,
    counterLabel: null,
    offlineReference: null,
    completedAt: '2026-11-15T07:00:00.000Z',
    currency: 'PKR',
    lines: [
      {
        id: 'line-1',
        name: 'Augmentin',
        strength: '625 mg',
        quantity: 2,
        saleUnit: 'strip',
        lineTotalMinor: 100_000,
      },
      {
        id: 'line-2',
        name: 'Calpol',
        strength: '500 mg',
        quantity: 1,
        saleUnit: 'strip',
        lineTotalMinor: 20_000,
      },
    ],
    tenders: [{ id: 'tender-1', label: 'Cash', amountMinor: 120_000 }],
    totals: { grossMinor: 120_000, discountMinor: 0, netMinor: 120_000 },
  };

  for (const [kind, line] of [
    ['an over-the-counter', { rx: false }],
    ['a prescription', { rx: true, prescriptionLineId: 'rx-line-1' }],
  ] as const) {
    it(`shows the link holder every purchased line of ${kind} receipt, with no code`, async () => {
      state.sale = saleWith(line);
      const provider = new MockWhatsAppProvider(config);
      await send({ provider });
      const token = tokenFrom(provider);

      const opened = await openHostedReceipt('org-1', token, now);
      expect(opened).toEqual(fullReceipt);
      // Only this link's sale is read; staff identity and batch never leave the counter.
      expect(readCounterReceipt).toHaveBeenLastCalledWith(
        db,
        { organizationId: 'org-1', branchId: 'branch-1' },
        'sale-1',
        // DEV-943: the receipt time is read on the organisation's own clock.
        { name: 'Gulberg Branch', currency: 'PKR', timeZone: 'Asia/Karachi' }
      );
      for (const hidden of ['Cashier Name', 'B-77', 'B-12'])
        expect(JSON.stringify(opened)).not.toContain(hidden);
      // Nothing is sent to the customer when the page opens.
      expect(provider.calls).toHaveLength(1);
      expect(state.claims.map((claim) => claim.kind)).toEqual(['RECEIPT_LINK']);
    });
  }

  it('shows nothing for a wrong, malformed or expired token', async () => {
    state.sale = saleWith({ rx: true });
    const provider = new MockWhatsAppProvider(config);
    await send({ provider });
    const token = tokenFrom(provider);
    vi.mocked(readCounterReceipt).mockClear();

    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    await expect(openHostedReceipt('org-1', wrong, now)).resolves.toBeNull();
    await expect(
      openHostedReceipt('org-1', '0123456789abcdefghjkmnpqrstvwxyz', now)
    ).resolves.toBeNull();
    await expect(openHostedReceipt('org-1', 'not-a-token', now)).resolves.toBeNull();
    await expect(openHostedReceipt('org-1', token.toUpperCase(), now)).resolves.toBeNull();
    await expect(
      openHostedReceipt('org-1', token, new Date('2026-12-15T07:05:00.001Z'))
    ).resolves.toBeNull();
    expect(readCounterReceipt).not.toHaveBeenCalled();
  });

  it('never shows a revoked link', async () => {
    const provider = new MockWhatsAppProvider(config);
    await send({ provider });
    state.links[0]!.revokedAt = now;
    await expect(openHostedReceipt('org-1', tokenFrom(provider), now)).resolves.toBeNull();
  });

  it('shows nothing once the sale is no longer completed', async () => {
    const provider = new MockWhatsAppProvider(config);
    await send({ provider });
    state.sale = { ...saleWith(), status: 'VOIDED' };
    await expect(openHostedReceipt('org-1', tokenFrom(provider), now)).resolves.toBeNull();
  });
});

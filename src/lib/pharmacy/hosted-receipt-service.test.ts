import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CounterReceipt } from './counter-receipt';
import { hashHostedReceiptToken, hashHostedReceiptOtp } from './hosted-receipt';
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
  otpHash: string | null;
  otpExpiresAt: Date | null;
  otpSendCount: number;
  otpFailedAttempts: number;
  lastOtpSentAt: Date | null;
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
    ],
    tenders: [
      {
        tenderId: 'tender-1',
        type: 'CASH',
        amountMinor: 100_000,
        cashReceivedMinor: 100_000,
        changeGivenMinor: 0,
      },
    ],
    totals: {
      grossMinor: 100_000,
      discountMinor: 0,
      netMinor: 100_000,
      tenderedMinor: 100_000,
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
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value)
      (link as Record<string, unknown>)[key] =
        ((link as Record<string, unknown>)[key] as number) +
        (value as { increment: number }).increment;
    else (link as Record<string, unknown>)[key] = value;
  }
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
          otpHash: null,
          otpExpiresAt: null,
          otpSendCount: 0,
          otpFailedAttempts: 0,
          lastOtpSentAt: null,
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
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const link = state.links.find((row) => row.id === where.id)!;
        applyUpdate(link, data);
        return { ...link };
      }
    ),
  },
  $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db)),
  pharmacyMessageLog: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.claimCommitted ? { id: where.id } : null
    ),
  },
  $queryRaw: vi.fn(async () => []),
};

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (tx: unknown) => Promise<unknown>) =>
    run(db)
  ),
}));

const { openHostedReceipt, sendHostedReceiptOtp, sendWhatsAppReceiptLink, verifyHostedReceiptOtp } =
  await import('./hosted-receipt-service');
const { HostedReceiptError } = await import('./hosted-receipt');

const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org-1',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'phone-1',
  PHARMACY_WHATSAPP_TEMPLATE_RECEIPT_LINK: 'receipt_link_v1',
  PHARMACY_WHATSAPP_TEMPLATE_RECEIPT_OTP: 'receipt_code_v1',
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
    expect(parameters.slice(0, 4)).toEqual(['Gulberg Branch', '1042', 'PKR 1000.00', 'Cash']);
    expect(parameters[4]).toMatch(
      /^https:\/\/acme\.devfathom\.app\/receipt\/[0-9a-hjkmnp-tv-z]{32}$/
    );
    const text = parameters.join(' ').toLowerCase();
    for (const item of ['augmentin', 'amoxicillin', '625', 'strip', 'tablet', 'b-77'])
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

  it('marks a sale with Rx lines as needing a one-time code', async () => {
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

  it('refuses an Rx receipt when the one-time code template is not set up', async () => {
    state.sale = saleWith({ rx: true });
    await expect(
      sendWhatsAppReceiptLink({
        db: db as never,
        scope,
        saleId: 'sale-1',
        actorUserId: 'cashier-1',
        now,
        config: { ...config, templates: { ...config.templates, receiptOtp: null } },
        defer: () => undefined,
      })
    ).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    expect(state.claims).toHaveLength(0);
    expect(state.links).toHaveLength(0);
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
  it('shows a non-Rx receipt to the link holder until it expires', async () => {
    const provider = new MockWhatsAppProvider(config);
    await send({ provider });
    const token = tokenFrom(provider);

    const opened = await openHostedReceipt('org-1', token, now);
    expect(opened).toMatchObject({
      kind: 'receipt',
      receipt: { receiptNumber: 1042, branchName: 'Gulberg Branch', totals: { netMinor: 100_000 } },
    });
    // Staff identity and batch detail never reach the hosted page.
    expect(JSON.stringify(opened)).not.toContain('Cashier Name');
    expect(JSON.stringify(opened)).not.toContain('B-77');

    await expect(
      openHostedReceipt('org-1', token, new Date('2026-12-15T07:05:00.001Z'))
    ).resolves.toBeNull();
    await expect(openHostedReceipt('org-1', 'not-a-token', now)).resolves.toBeNull();
    await expect(
      openHostedReceipt('org-1', '0123456789abcdefghjkmnpqrstvwxyz', now)
    ).resolves.toBeNull();
  });

  it('never shows a revoked link', async () => {
    const provider = new MockWhatsAppProvider(config);
    await send({ provider });
    state.links[0]!.revokedAt = now;
    await expect(openHostedReceipt('org-1', tokenFrom(provider), now)).resolves.toBeNull();
  });

  it('requires a one-time code before an Rx receipt shows any line', async () => {
    state.sale = saleWith({ rx: true });
    const linkProvider = new MockWhatsAppProvider(config);
    await send({ provider: linkProvider });
    const token = tokenFrom(linkProvider);

    const gated = await openHostedReceipt('org-1', token, now);
    expect(gated).toEqual({
      kind: 'otp',
      branchName: 'Gulberg Branch',
      receiptNumber: 1042,
      phoneLast4: '4567',
    });
    expect(JSON.stringify(gated)).not.toContain('Augmentin');

    // Verifying before any code is sent reveals nothing.
    await expect(
      verifyHostedReceiptOtp({ organizationId: 'org-1', token, otp: '123456', now })
    ).resolves.toBeNull();

    const otpProvider = new MockWhatsAppProvider(config);
    await expect(
      sendHostedReceiptOtp({ organizationId: 'org-1', token, now, config, provider: otpProvider })
    ).resolves.toBe('SENT');
    const call = otpProvider.calls[0]!;
    expect(call).toMatchObject({ kind: 'template', template: 'receiptOtp', to: '923001234567' });
    const otp = call.kind === 'template' ? call.parameters[0]! : '';
    expect(otp).toMatch(/^\d{6}$/);
    expect(state.links[0]!.otpHash).not.toContain(otp);
    expect(state.claims.at(-1)).toMatchObject({ kind: 'RECEIPT_OTP' });

    const wrong = String((Number(otp) + 1) % 1_000_000).padStart(6, '0');
    await expect(
      verifyHostedReceiptOtp({ organizationId: 'org-1', token, otp: wrong, now })
    ).resolves.toBeNull();
    expect(state.links[0]!.otpFailedAttempts).toBe(1);

    const revealed = await verifyHostedReceiptOtp({ organizationId: 'org-1', token, otp, now });
    expect(revealed).toMatchObject({ receiptNumber: 1042, lines: [{ name: 'Augmentin' }] });

    // The code is single use.
    await expect(
      verifyHostedReceiptOtp({ organizationId: 'org-1', token, otp, now })
    ).resolves.toBeNull();
  });

  it('expires codes, locks after repeated failures and throttles resends', async () => {
    state.sale = saleWith({ rx: true });
    const linkProvider = new MockWhatsAppProvider(config);
    await send({ provider: linkProvider });
    const token = tokenFrom(linkProvider);
    const link = state.links[0]!;

    await expect(
      sendHostedReceiptOtp({ organizationId: 'org-1', token, now, config })
    ).resolves.toBe('SENT');
    await expect(
      sendHostedReceiptOtp({ organizationId: 'org-1', token, now, config })
    ).resolves.toBe('WAIT');

    link.otpHash = hashHostedReceiptOtp('111111');
    link.otpFailedAttempts = 5;
    await expect(
      verifyHostedReceiptOtp({ organizationId: 'org-1', token, otp: '111111', now })
    ).resolves.toBeNull();

    link.otpFailedAttempts = 0;
    link.otpExpiresAt = new Date(now.getTime() - 1);
    await expect(
      verifyHostedReceiptOtp({ organizationId: 'org-1', token, otp: '111111', now })
    ).resolves.toBeNull();

    link.lastOtpSentAt = null;
    link.otpSendCount = 5;
    await expect(
      sendHostedReceiptOtp({ organizationId: 'org-1', token, now, config })
    ).resolves.toBe('UNAVAILABLE');
  });

  it('sends no code for a non-Rx link or to a customer who opted out', async () => {
    const provider = new MockWhatsAppProvider(config);
    await send({ provider });
    const token = tokenFrom(provider);
    const otpProvider = new MockWhatsAppProvider(config);
    await expect(
      sendHostedReceiptOtp({ organizationId: 'org-1', token, now, config, provider: otpProvider })
    ).resolves.toBe('UNAVAILABLE');

    state.links[0]!.rxProtected = true;
    state.customer = { ...state.customer!, whatsappOptIn: false };
    await expect(
      sendHostedReceiptOtp({ organizationId: 'org-1', token, now, config, provider: otpProvider })
    ).resolves.toBe('UNAVAILABLE');
    expect(otpProvider.calls).toHaveLength(0);
  });
});

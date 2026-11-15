import { describe, expect, it, vi } from 'vitest';

vi.mock('./khata-repayment', () => ({
  recordKhataRepayment: vi.fn(async () => ({ receiptReference: 'KP-ABC' })),
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  cancelPortalRequest,
  confirmPortalKhataPayment,
  createPortalRequest,
  decidePortalRequest,
  hashPortalOtp,
  hashPortalSecret,
  maskPhone,
  mintPortalLink,
  PharmacyPortalError,
  portalCodeSender,
  portalCodeMessage,
  portalOtpMatches,
  readPortalSession,
  startPortalSignIn,
  verifyPortalSignIn,
} from './customer-portal';
import { portalManifest } from './customer-portal-manifest';
import { MetaWhatsAppProvider, readWhatsAppConfig } from './whatsapp/provider';
import { recordKhataRepayment } from './khata-repayment';
import { isNonDrugOfferCopy } from './rfm-winback';

const ORG = 'org-1';
const scope = { organizationId: ORG, branchId: 'branch-1', actorId: 'pharmacist-1' };
const session = { sessionId: 's-1', organizationId: ORG, branchId: 'branch-1', customerId: 'c-1' };
const TOKEN = 'pcl_0123456789abcdefghjkmnpqrs';
const asDb = (value: unknown) => value as ScopedDb;

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    organizationId: ORG,
    branchId: 'branch-1',
    customerId: 'c-1',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    otpHash: null,
    otpExpiresAt: null,
    otpFailedAttempts: 0,
    branch: { name: 'Model Town', active: true },
    customer: { active: true, displayName: 'Ayesha' },
    ...overrides,
  };
}

const customerRow = {
  id: 'c-1',
  displayName: 'Ayesha',
  patient: { phone: '0300 1234567' },
};

describe('DEV-15 customer PWA sign-in', () => {
  it('mints a link only for a customer with a phone on file', async () => {
    const create = vi.fn(async () => ({ id: 'link-1', expiresAt: new Date() }));
    const db = asDb({
      pharmacyCustomer: { findFirst: async () => customerRow },
      pharmacyCustomerPortalLink: { create },
    });
    const minted = await mintPortalLink(db, scope, 'c-1');
    expect(minted.path).toMatch(/^\/my-pharmacy\/join\/pcl_[0-9a-hjkmnp-tv-z]{26}$/);
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    // Only a hash is stored, and the link names exactly this customer.
    expect(data.customerId).toBe('c-1');
    expect(data.tokenHash).toBe(hashPortalSecret(minted.path.split('/').pop()!));
    expect(JSON.stringify(data)).not.toContain(minted.path.split('/').pop());

    const noPhone = asDb({
      pharmacyCustomer: {
        findFirst: async () => ({ ...customerRow, patient: { phone: null } }),
      },
      pharmacyCustomerPortalLink: { create },
    });
    await expect(mintPortalLink(noPhone, scope, 'c-1')).rejects.toMatchObject({
      reason: 'PHONE_REQUIRED',
    });
  });

  it('sends the code to the customer’s stored phone with no medicine wording', async () => {
    const update = vi.fn(async () => ({}));
    const sent: Array<{ to: string; body: string }> = [];
    const db = asDb({
      pharmacyCustomer: { findFirst: async () => customerRow },
      pharmacyCustomerPortalLink: { findUnique: async () => linkRow(), update },
    });
    const result = await startPortalSignIn(db, ORG, TOKEN, async (message) => {
      sent.push(message);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('923001234567');
    const otp = /(\d{6})/.exec(sent[0].body)![1];
    const stored = (update.mock.calls[0] as unknown as [{ data: { otpHash: string } }])[0].data;
    expect(portalOtpMatches(stored.otpHash, otp)).toBe(true);
    expect(stored.otpHash).not.toContain(otp);
    expect(isNonDrugOfferCopy(sent[0].body)).toBe(true);
    expect(result.sentTo).toBe('•••• 4567');
  });

  it('refuses a link from another tenant, revoked or expired', async () => {
    for (const row of [
      linkRow({ organizationId: 'org-2' }),
      linkRow({ revokedAt: new Date() }),
      linkRow({ expiresAt: new Date(Date.now() - 1) }),
      linkRow({ customer: { active: false, displayName: 'x' } }),
    ]) {
      const db = asDb({
        pharmacyCustomer: { findFirst: async () => customerRow },
        pharmacyCustomerPortalLink: { findUnique: async () => row, update: vi.fn() },
      });
      await expect(startPortalSignIn(db, ORG, TOKEN, async () => {})).rejects.toMatchObject({
        reason: 'LINK_INVALID',
      });
    }
  });

  it('opens a session for exactly the link’s customer on the right code, once', async () => {
    const otpHash = hashPortalOtp('123456');
    const createSession = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = asDb({
      pharmacyCustomerPortalLink: {
        findUnique: async () => linkRow({ otpHash, otpExpiresAt: new Date(Date.now() + 60_000) }),
        update: vi.fn(),
        updateMany,
      },
      pharmacyCustomerPortalSession: { create: createSession },
    });
    const result = await verifyPortalSignIn(db, ORG, TOKEN, '123456');
    expect(result.ok).toBe(true);
    const data = (createSession.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(data).toMatchObject({ customerId: 'c-1', branchId: 'branch-1', linkId: 'link-1' });
    if (result.ok) expect(data.tokenHash).toBe(hashPortalSecret(result.sessionToken));
    // The code is consumed so it cannot open a second session.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'link-1', otpHash },
      data: { otpHash: null, otpExpiresAt: null, otpFailedAttempts: 0 },
    });
  });

  it('counts a wrong code and locks out after five attempts or expiry', async () => {
    const otpHash = hashPortalOtp('123456');
    const update = vi.fn(async () => ({}));
    const createSession = vi.fn();
    const make = (overrides: Record<string, unknown>) =>
      asDb({
        pharmacyCustomerPortalLink: {
          findUnique: async () =>
            linkRow({ otpHash, otpExpiresAt: new Date(Date.now() + 60_000), ...overrides }),
          update,
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        pharmacyCustomerPortalSession: { create: createSession },
      });
    expect(await verifyPortalSignIn(make({}), ORG, TOKEN, '654321')).toEqual({ ok: false });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { otpFailedAttempts: { increment: 1 } },
    });
    expect(await verifyPortalSignIn(make({ otpFailedAttempts: 5 }), ORG, TOKEN, '123456')).toEqual({
      ok: false,
    });
    expect(
      await verifyPortalSignIn(
        make({ otpExpiresAt: new Date(Date.now() - 1) }),
        ORG,
        TOKEN,
        '123456'
      )
    ).toEqual({ ok: false });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects revoked, expired or cross-tenant sessions', async () => {
    const token = `pcs_${'a'.repeat(43)}`;
    const row = {
      id: 's-1',
      organizationId: ORG,
      branchId: 'branch-1',
      customerId: 'c-1',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      customer: { active: true },
      link: { revokedAt: null },
    };
    const read = (value: unknown) =>
      readPortalSession(
        asDb({ pharmacyCustomerPortalSession: { findUnique: async () => value } }),
        ORG,
        token
      );
    expect(await read(row)).toEqual(session);
    expect(await read({ ...row, organizationId: 'org-2' })).toBeNull();
    expect(await read({ ...row, revokedAt: new Date() })).toBeNull();
    expect(await read({ ...row, link: { revokedAt: new Date() } })).toBeNull();
    expect(await read({ ...row, expiresAt: new Date(Date.now() - 1) })).toBeNull();
    expect(await readPortalSession(asDb({}), ORG, 'not-a-token')).toBeNull();
  });

  it('keeps the code message free of medicine wording', () => {
    const body = portalCodeMessage('Model Town Pharmacy', '000111');
    expect(body).toContain('000111');
    expect(isNonDrugOfferCopy(body)).toBe(true);
    expect(isNonDrugOfferCopy('20% off paracetamol 500 mg')).toBe(false);
    expect(maskPhone('03001234567')).toBe('•••• 4567');
  });
});

describe('DEV-15 customer requests', () => {
  it('only refills one of the customer’s own completed receipts', async () => {
    const findFirst = vi.fn(async () => null);
    const db = asDb({ pharmacySale: { findFirst }, pharmacyCustomerPortalRequest: {} });
    await expect(
      createPortalRequest(db, session, { kind: 'REFILL', saleId: 'sale-of-someone-else' })
    ).rejects.toMatchObject({ reason: 'SALE_NOT_FOUND' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerId: 'c-1', status: 'COMPLETED' }),
      })
    );
  });

  it('queues a prescription-photo order as pending for a pharmacist', async () => {
    const create = vi.fn(async (input: unknown) => input);
    const db = asDb({ pharmacyCustomerPortalRequest: { create } });
    await createPortalRequest(db, session, {
      kind: 'RX_ORDER',
      prescriptionFileRef: '/api/pharmacy/prescription-files?id=x',
    });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ kind: 'RX_ORDER', customerId: 'c-1' });
    // Status is left to the database default: PENDING until a pharmacist decides.
    expect(data.status).toBeUndefined();
  });

  it('accepts a khata payment notice only for the customer’s own account with Raast set up', async () => {
    const make = (account: unknown, settings: unknown) =>
      asDb({
        pharmacyFamilyAccount: { findFirst: async () => account },
        pharmacyBranch: { findFirst: async () => ({ manualPaymentSettings: settings }) },
        pharmacyCustomerPortalRequest: { create: vi.fn(async () => ({ id: 'r-1' })) },
      });
    const input = {
      kind: 'KHATA_PAYMENT' as const,
      familyAccountId: 'fa-1',
      amountMinor: 50_000,
      payerReference: '1234',
    };
    await expect(createPortalRequest(make(null, {}), session, input)).rejects.toMatchObject({
      reason: 'ACCOUNT_NOT_FOUND',
    });
    await expect(
      createPortalRequest(make({ id: 'fa-1' }, {}), session, input)
    ).rejects.toMatchObject({ reason: 'RAAST_NOT_CONFIGURED' });
    await expect(
      createPortalRequest(
        make({ id: 'fa-1' }, { RAAST: { destination: 'PK00RAAST', allowReferenceSkip: false } }),
        session,
        input
      )
    ).resolves.toEqual({ id: 'r-1' });
  });

  it('lets a customer cancel only their own pending request', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    await expect(
      cancelPortalRequest(asDb({ pharmacyCustomerPortalRequest: { updateMany } }), session, 'r-9')
    ).rejects.toBeInstanceOf(PharmacyPortalError);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'r-9', organizationId: ORG, customerId: 'c-1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });
});

describe('DEV-15 staff decisions', () => {
  function staffDb(kind: string, status = 'PENDING') {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    return {
      updateMany,
      db: asDb({
        pharmacyCustomerPortalRequest: {
          findFirst: async () => ({
            id: 'r-1',
            kind,
            status,
            familyAccountId: kind === 'KHATA_PAYMENT' ? 'fa-1' : null,
            amountMinor: kind === 'KHATA_PAYMENT' ? 50_000 : null,
            payerReference: kind === 'KHATA_PAYMENT' ? '1234' : null,
          }),
          updateMany,
        },
        organization: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) },
      }),
    };
  }

  it('requires the pharmacist permission to verify a prescription-photo order', async () => {
    const { db, updateMany } = staffDb('RX_ORDER');
    await expect(
      decidePortalRequest(db, scope, { requestId: 'r-1', decision: 'VERIFY' }, ['KHATA_PAYMENT'])
    ).rejects.toMatchObject({ reason: 'KIND_NOT_ALLOWED' });
    expect(updateMany).not.toHaveBeenCalled();

    await decidePortalRequest(db, scope, { requestId: 'r-1', decision: 'VERIFY' }, [
      'REFILL',
      'RX_ORDER',
    ]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'r-1', organizationId: ORG, branchId: 'branch-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'VERIFIED', decidedByUserId: 'pharmacist-1' }),
    });
  });

  it('never marks a payment verified without posting it to the khata ledger', async () => {
    const { db } = staffDb('KHATA_PAYMENT');
    await expect(
      decidePortalRequest(db, scope, { requestId: 'r-1', decision: 'VERIFY' }, ['KHATA_PAYMENT'])
    ).rejects.toMatchObject({ reason: 'KIND_NOT_ALLOWED' });
  });

  // 2026-11-15 00:30 in Karachi is still 2026-11-14 in UTC.
  const NOW = new Date('2026-11-14T19:30:00.000Z');
  const TODAY = new Date('2026-11-15T00:00:00.000Z');

  it.each([
    ['a past day', new Date('2026-11-13T00:00:00.000Z')],
    ['a future day', new Date('2026-11-17T00:00:00.000Z')],
    ['the UTC day, already yesterday in Karachi', new Date('2026-11-14T00:00:00.000Z')],
  ])('refuses to post a payment on %s the client sent', async (_, businessDate) => {
    vi.mocked(recordKhataRepayment).mockClear();
    const { db, updateMany } = staffDb('KHATA_PAYMENT');
    await expect(
      confirmPortalKhataPayment(db, scope, { requestId: 'r-1', businessDate }, NOW)
    ).rejects.toMatchObject({ reason: 'BUSINESS_DATE_NOT_CURRENT' });
    expect(recordKhataRepayment).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('books on today in the workspace zone when the client sends no date', async () => {
    vi.mocked(recordKhataRepayment).mockClear();
    const { db } = staffDb('KHATA_PAYMENT');
    await confirmPortalKhataPayment(db, scope, { requestId: 'r-1' }, NOW);
    expect(vi.mocked(recordKhataRepayment).mock.calls[0][2]).toMatchObject({
      businessDate: TODAY,
    });
  });

  it('posts a confirmed Raast payment through the counter repayment path', async () => {
    vi.mocked(recordKhataRepayment).mockClear();
    const { db, updateMany } = staffDb('KHATA_PAYMENT');
    const businessDate = TODAY;
    await confirmPortalKhataPayment(db, scope, { requestId: 'r-1', businessDate }, NOW);
    expect(recordKhataRepayment).toHaveBeenCalledWith(db, scope, {
      familyAccountId: 'fa-1',
      amountMinor: 50_000,
      tender: 'RAAST',
      payerReference: '1234',
      businessDate,
      idempotencyKey: 'portal-request:r-1',
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'VERIFIED', khataReceiptReference: 'KP-ABC' }),
      })
    );
  });

  it('refuses to decide an already-decided request', async () => {
    const { db } = staffDb('REFILL', 'VERIFIED');
    await expect(
      decidePortalRequest(db, scope, { requestId: 'r-1', decision: 'REJECT' }, ['REFILL'])
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });
});

describe('DEV-15 installable manifest', () => {
  it('is installable and scoped to the customer app', () => {
    const manifest = portalManifest();
    expect(manifest).toMatchObject({
      start_url: '/my-pharmacy',
      scope: '/my-pharmacy',
      display: 'standalone',
    });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512'])
    );
  });
});

describe('DEV-15 sign-in code delivery', () => {
  const message = {
    to: '923001234567',
    otp: '123456',
    body: 'Model Town: your sign-in code is 123456.',
  };
  const provider = () => ({
    sendText: vi.fn(async () => ({ providerMessageId: 't' })),
    sendTemplate: vi.fn(async () => ({ providerMessageId: 'm' })),
  });
  const meta = (overrides: Record<string, unknown> = {}) => ({
    provider: 'meta' as const,
    organizationId: ORG,
    templates: {
      refillReminder: null,
      khataReminder: null,
      receiptLink: null,
      portalSignInCode: 'portal_code',
    },
    ...overrides,
  });

  it('sends live codes through the approved authentication template, not free text', async () => {
    const sender = provider();
    await portalCodeSender(meta(), sender, ORG)(message);
    expect(sender.sendTemplate).toHaveBeenCalledWith({
      to: '923001234567',
      template: 'portalSignInCode',
      parameters: ['123456'],
    });
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('never sends another tenant’s customer a code from the configured sender', async () => {
    const sender = provider();
    await expect(portalCodeSender(meta(), sender, 'org-2')(message)).rejects.toMatchObject({
      reason: 'SEND_FAILED',
    });
    await expect(
      portalCodeSender(
        meta({
          templates: {
            refillReminder: null,
            khataReminder: null,
            receiptLink: null,
            portalSignInCode: null,
          },
        }),
        sender,
        ORG
      )(message)
    ).rejects.toMatchObject({ reason: 'SEND_FAILED' });
    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('puts the code on the authentication template body and copy-code button', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 })
    );
    const config = readWhatsAppConfig({
      PHARMACY_WHATSAPP_PROVIDER: 'meta',
      PHARMACY_WHATSAPP_ACCESS_TOKEN: 'token',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: '1',
      PHARMACY_WHATSAPP_TEMPLATE_PORTAL_SIGN_IN_CODE: 'portal_code',
    });
    expect(config.templates.portalSignInCode).toBe('portal_code');
    await new MetaWhatsAppProvider(config, fetchImpl as unknown as typeof fetch).sendTemplate({
      to: '923001234567',
      template: 'portalSignInCode',
      parameters: ['123456'],
    });
    const sent = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body
    );
    expect(sent.template.name).toBe('portal_code');
    expect(sent.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '123456' }],
      },
    ]);
  });
});

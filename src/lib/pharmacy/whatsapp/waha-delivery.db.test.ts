// @vitest-environment node
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/pharmacy/whatsapp/webhook/route';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { decryptSecret } from '@/lib/secret-crypto';
import { guardedWahaSend } from './waha-policy';
import { prepareWahaSession, readWahaSession } from './waha-session';
import { wahaMessageId } from './waha-client';
import { portalCodeSender } from '../customer-portal';
import { createWhatsAppProvider, readWhatsAppConfig, bindWhatsAppTenant } from './provider';

const phone = '12025550101';
const secret = randomBytes(32).toString('hex');
let mode = 'ok',
  attempts = 0,
  lifecycle = 0;
const server = createServer(async (req, res) => {
  if (req.headers['x-api-key'] !== secret) {
    res.writeHead(401).end();
    return;
  }
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (path === '/api/contacts/check-exists') {
    res.end(JSON.stringify({ numberExists: mode !== 'absent', chatId: phone + '@c.us' }));
    return;
  }
  if (path === '/api/sendText') {
    attempts++;
    if (mode === 'ambiguous') {
      req.socket.destroy();
      return;
    }
    if (mode === '463' || mode === '475') {
      res
        .writeHead(500)
        .end(
          JSON.stringify({
            exception: { message: 'server returned error ' + mode },
            request: { body: { text: 'private synthetic payload' } },
          })
        );
      return;
    }
    res.end(JSON.stringify({ id: randomUUID() }));
    return;
  }
  lifecycle++;
  res.writeHead(404).end();
});
const url = process.env.TEST_DATABASE_URL;
async function fixture() {
  const org = 'waha_' + randomUUID(),
    patient = randomUUID(),
    customer = randomUUID();
  const localHour = new Date().getUTCHours();
  const offset = ((12 - localHour + 36) % 24) - 12;
  const zone = offset === 0 ? 'UTC' : 'Etc/GMT' + (offset > 0 ? '-' : '+') + Math.abs(offset);
  const row = await withTenantDb(org, async (db) => {
    const [role] = await db.$queryRaw<
      { safe: boolean }[]
    >`SELECT NOT rolsuper AND NOT rolbypassrls AS safe FROM pg_roles WHERE rolname=current_user`;
    expect(role.safe).toBe(true);
    await db.organization.create({
      data: {
        id: org,
        slug: org,
        displayName: 'Synthetic pharmacy',
        legalName: 'Synthetic pharmacy',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: zone,
      },
    });
    await db.pharmacyPatient.create({
      data: { id: patient, organizationId: org, displayName: 'Synthetic patient', phone },
    });
    await db.pharmacyCustomer.create({
      data: {
        id: customer,
        organizationId: org,
        patientId: patient,
        displayName: 'Synthetic customer',
        whatsappOptIn: true,
      },
    });
    await prepareWahaSession(db, org, secret);
    await db.$executeRaw`UPDATE pharmacy_waha_sessions SET status='WORKING',"perDay"=10 WHERE "organizationId"=${org}`;
    return (await readWahaSession(db, org))!;
  });
  return { org, customer, row, zone };
}
async function webhook(
  row: Awaited<ReturnType<typeof fixture>>['row'],
  data: object,
  requestId = randomUUID(),
  stamp = Date.now(),
  key = decryptSecret(row.encryptedWebhookSecret)
) {
  const raw = JSON.stringify(data);
  const response = await POST(
    new Request(
      'http://localhost/api/pharmacy/whatsapp/webhook?endpoint=' + encodeURIComponent(row.selector),
      {
        method: 'POST',
        headers: {
          'x-webhook-hmac-algorithm': 'sha512',
          'x-webhook-hmac': createHmac('sha512', key).update(raw).digest('hex'),
          'x-webhook-request-id': requestId,
          'x-webhook-timestamp': String(stamp),
        },
        body: raw,
      }
    )
  );
  return response.status;
}
describe.skipIf(!url)('WAHA business entry points on PostgreSQL 16', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('PHARMACY_WHATSAPP_PROVIDER', 'waha');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw Error('missing port');
    vi.stubEnv('PHARMACY_WAHA_BASE_URL', 'http://127.0.0.1:' + addr.port);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('verifies the signed business before dispatch, persists STOP once, and preserves distinct ordered acknowledgements', async () => {
    const a = await fixture(),
      b = await fixture();
    const event = {
      event: 'message',
      id: randomUUID(),
      session: a.row.sessionName,
      timestamp: Date.now(),
      payload: {
        fromMe: false,
        id: randomUUID(),
        from: phone + '@c.us',
        body: 'STOP',
        timestamp: Math.floor(Date.now() / 1000),
      },
    };
    expect(
      await webhook(
        b.row,
        event,
        randomUUID(),
        Date.now(),
        decryptSecret(a.row.encryptedWebhookSecret)
      )
    ).toBe(401);
    expect(await webhook(b.row, event)).toBe(400);
    expect(await webhook(a.row, event, randomUUID(), Date.now() - 600000)).toBe(401);
    expect(await webhook(a.row, event)).toBe(200);
    expect(await webhook(a.row, { ...event, id: randomUUID() })).toBe(200);
    for (const [business, opted] of [
      [a, false],
      [b, true],
    ] as const) {
      const state = await withTenantDb(business.org, async (db) => ({
        customer: await db.pharmacyCustomer.findUniqueOrThrow({
          where: { id: business.customer },
          select: { whatsappOptIn: true },
        }),
        entries: await db.pharmacyMessageLog.count({ where: { kind: 'OPT_OUT' } }),
      }));
      expect(state.customer.whatsappOptIn).toBe(opted);
      expect(state.entries).toBe(opted ? 0 : 1);
    }
    const message = randomUUID(),
      request = randomUUID();
    const ack = (rank: number) => ({
      ...event,
      id: randomUUID(),
      event: 'message.ack',
      payload: { fromMe: true, id: message, ack: rank },
    });
    expect(await webhook(a.row, ack(2), request)).toBe(200);
    expect(await webhook(a.row, ack(3), request)).toBe(200);
    expect(await webhook(a.row, ack(2))).toBe(200);
    const result = await withTenantDb(a.org, (db) =>
      db.pharmacyMessageLog.create({
        data: {
          organizationId: a.org,
          direction: 'OUTBOUND',
          kind: 'RECEIPT_LINK',
          status: 'SENT',
          dedupeKey: randomUUID(),
          providerMessageId: wahaMessageId(message),
        },
        select: { wahaAck: true },
      })
    );
    expect(result.wahaAck).toBe(3);
  });
  it.each(['463', '475'])(
    'latches restriction %s without any lifecycle operation',
    async (code) => {
      const { org } = await fixture();
      mode = code;
      const before = attempts;
      await expect(
        guardedWahaSend(org, phone, 'test', { text: 'Synthetic notice' })
      ).rejects.toMatchObject({ reason: 'WAHA_POLICY' });
      mode = 'ok';
      await expect(
        guardedWahaSend(org, phone, 'test', { text: 'Synthetic notice' })
      ).rejects.toMatchObject({ reason: 'WAHA_POLICY' });
      expect((await withTenantDb(org, (db) => readWahaSession(db, org)))?.restrictionCode).toBe(
        Number(code)
      );
      expect(attempts - before).toBe(1);
      expect(lifecycle).toBe(0);
    }
  );
  it('requires consent, the local sending window and separate portal approval before dispatch', async () => {
    const { org, customer, zone } = await fixture(),
      before = attempts;
    const config = bindWhatsAppTenant(
      readWhatsAppConfig({
        PHARMACY_WHATSAPP_PROVIDER: 'waha',
        PHARMACY_WAHA_PORTAL_CODE_EN: 'Your sign-in code is {{1}}.',
      }),
      org
    );
    const send = portalCodeSender(config, createWhatsAppProvider(config), org);
    const input = {
      to: phone,
      otp: randomBytes(4).readUInt32LE().toString().slice(-6),
      body: 'unused',
    };
    await expect(send(input)).rejects.toMatchObject({ reason: 'WAHA_POLICY' });
    await withTenantDb(org, async (db) => {
      await db.$executeRaw`UPDATE pharmacy_waha_sessions SET "portalCodes"=true WHERE "organizationId"=${org}`;
      await db.pharmacyCustomer.update({ where: { id: customer }, data: { whatsappOptIn: false } });
    });
    await expect(send(input)).rejects.toMatchObject({ reason: 'WAHA_POLICY' });
    const hour = new Date().getUTCHours(),
      off = hour > 12 ? 24 - hour : -hour;
    await withTenantDb(org, async (db) => {
      await db.pharmacyCustomer.update({ where: { id: customer }, data: { whatsappOptIn: true } });
      await db.organization.update({
        where: { id: org },
        data: { timezone: off === 0 ? 'UTC' : 'Etc/GMT' + (off > 0 ? '-' : '+') + Math.abs(off) },
      });
    });
    await expect(send(input)).rejects.toMatchObject({ reason: 'WAHA_POLICY' });
    await withTenantDb(org, (db) =>
      db.organization.update({ where: { id: org }, data: { timezone: zone } })
    );
    await expect(send(input)).resolves.toMatchObject({ acceptedByProvider: true });
    expect(attempts - before).toBe(1);
  });
});

import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import { isLiveOrganizationOwner } from '../owner-data-export';
import { recordAudit } from '@/server/audit';
import type { TRPCContext } from '@/server/trpc';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { tenantHostUrl } from '@/lib/tenancy/host-routing';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';
import { normalizeWhatsAppNumber } from './messages';
import { guardedWahaSend } from './waha-policy';
import { WahaClient, WahaFailure } from './waha-client';
import { prepareWahaSession, readWahaSession } from './waha-session';
import { WhatsAppProviderError } from './provider';

const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('refresh') }).strict(),
  z.object({ action: z.literal('disconnect'), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('test'), phone: z.string().min(8).max(32) }).strict(),
  z
    .object({
      action: z.literal('settings'),
      minute: z.number().int().min(1).max(60),
      day: z.number().int().min(0).max(1000),
      portal: z.boolean(),
    })
    .strict(),
]);
export type WahaCommand = z.infer<typeof command>;
export type WahaView = {
  access: boolean;
  configured: boolean;
  status: string;
  number: string | null;
  qr: string | null;
  paused: boolean;
  minute: number;
  day: number;
  portal: boolean;
  notice: string | null;
};
const empty: WahaView = {
  access: false,
  configured: false,
  status: 'DISCONNECTED',
  number: null,
  qr: null,
  paused: false,
  minute: 1,
  day: 0,
  portal: false,
  notice: null,
};
export async function manageWaha(ctx: TRPCContext, input: WahaCommand): Promise<WahaView> {
  const user = ctx.session?.user,
    org = ctx.organization;
  const checked = command.safeParse(input);
  const action = checked.success ? checked.data.action : 'invalid';
  const audit = (status: number, phase: string) =>
    recordAudit(
      {
        organizationId: org?.id ?? ctx.entitlements.organizationId,
        actorType: 'USER',
        actorId: user?.id,
        actorRole: user?.role,
        source: 'SYSTEM',
        operation: action === 'refresh' ? 'READ' : 'UPDATE',
        category: 'PHARMACY_WHATSAPP',
        action: 'pharmacy.whatsapp.' + action,
        path: '/pharmacy/settings/whatsapp',
        httpMethod: action === 'refresh' ? 'GET' : 'POST',
        statusCode: status,
        outcome: status < 400 ? 'SUCCESS' : 'FAILURE',
        metadata: { phase },
      },
      ctx.db
    );
  if (
    !user?.id ||
    user.isSupportSession ||
    !org ||
    org.id !== user.organizationId ||
    org.id !== ctx.entitlements.organizationId ||
    org.isDemo ||
    org.vertical !== 'PHARMACY' ||
    !isTenantLifecycleAccessible(org.status) ||
    !hasModule(ctx.entitlements, 'pharmacy-core') ||
    !(await isLiveOrganizationOwner(ctx.db, org.id, user.id))
  ) {
    await audit(403, 'denied');
    return empty;
  }
  if (!checked.success || process.env.PHARMACY_WHATSAPP_PROVIDER !== 'waha') {
    await audit(400, 'unavailable');
    return { ...empty, access: true, notice: 'WAHA is unavailable for this workspace.' };
  }
  await audit(200, 'requested');
  const cmd = checked.data;
  let notice: string | null = null;
  try {
    // Commit the binding before contacting WAHA. A retry always uses the original session.
    if (cmd.action === 'start')
      await withTenantDb(org.id, async (db) => {
        await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'waha:prepare:' + org.id},0))`;
        if (!(await readWahaSession(db, org.id)))
          await prepareWahaSession(db, org.id, randomBytes(32).toString('hex'));
      });
    if (cmd.action === 'test') {
      const phone = normalizeWhatsAppNumber(cmd.phone);
      if (!phone) throw new Error('Invalid recipient');
      await guardedWahaSend(org.id, phone, 'test', {
        text: 'This is a test message from your pharmacy.',
      });
      notice = 'WhatsApp accepted the test message.';
    }
    const view = await withTenantDb(org.id, async (db) => {
      await db.$queryRaw`SELECT "organizationId" FROM pharmacy_waha_sessions WHERE "organizationId"=${org.id} FOR UPDATE`;
      const row = await readWahaSession(db, org.id);
      if (!row) return { ...empty, access: true };
      let client = new WahaClient(row.sessionName, decryptSecret(row.encryptedApiKey));
      if (cmd.action === 'settings') {
        await db.$executeRaw`UPDATE pharmacy_waha_sessions SET "perMinute"=${cmd.minute},"perDay"=${cmd.day},"portalCodes"=${cmd.portal} WHERE "organizationId"=${org.id}`;
        row.perMinute = cmd.minute;
        row.perDay = cmd.day;
        row.portalCodes = cmd.portal;
        notice = 'Send settings saved.';
      }
      if (cmd.action === 'start' && !row.restrictionCode) {
        const rootKey = process.env.PHARMACY_WAHA_PROVISIONING_KEY;
        const callback = tenantHostUrl(
          org.slug,
          '/api/pharmacy/whatsapp/webhook?endpoint=' + encodeURIComponent(row.selector)
        );
        if (!rootKey || !callback) throw new WahaFailure('UNAVAILABLE', true);
        const provisioner = new WahaClient(row.sessionName, rootKey);
        let state;
        try {
          state = await provisioner.status();
        } catch (e) {
          if (!(e instanceof WahaFailure) || e.httpStatus !== 404) throw e;
        }
        if (!state) await provisioner.start(callback, decryptSecret(row.encryptedWebhookSecret));
        if (state?.status === 'STOPPED') await provisioner.activate();
        try {
          await client.status();
        } catch (e) {
          if (!(e instanceof WahaFailure) || !(e.httpStatus === 401 || e.httpStatus === 403))
            throw e;
          const key = await provisioner.issueSessionKey();
          await db.$executeRaw`UPDATE pharmacy_waha_sessions SET "encryptedApiKey"=${encryptSecret(key)} WHERE "organizationId"=${org.id}`;
          client = new WahaClient(row.sessionName, key);
        }
      }
      if (cmd.action === 'disconnect' && !row.restrictionCode) await client.disconnect();
      let current: { status: string; number: string | null } = {
        status: 'DISCONNECTED',
        number: null,
      };
      let qr: string | null = null;
      try {
        current = await client.status();
        if (current.status === 'SCAN_QR_CODE' && !row.restrictionCode) qr = await client.qr();
      } catch {
        notice = 'WhatsApp is disconnected. Check the WAHA server and refresh.';
      }
      await db.$executeRaw`UPDATE pharmacy_waha_sessions SET status=${current.status},"connectedNumber"=${current.number},"statusAt"=now() WHERE "organizationId"=${org.id}`;
      return {
        access: true,
        configured: true,
        status: current.status,
        number: current.number,
        qr,
        paused: !!row.restrictionCode,
        minute: row.perMinute,
        day: row.perDay,
        portal: row.portalCodes,
        notice,
      };
    });
    await audit(200, 'completed');
    return view;
  } catch (error) {
    await audit(503, 'failed');
    const message =
      error instanceof WhatsAppProviderError && error.reason === 'NOT_ON_WHATSAPP'
        ? 'This number is not on WhatsApp.'
        : cmd.action === 'test'
          ? 'The test was not confirmed. Check consent, quiet hours, send limits and connection status before trying again.'
          : 'WhatsApp is unavailable. Check the server and refresh.';
    return { ...empty, access: true, notice: message };
  }
}

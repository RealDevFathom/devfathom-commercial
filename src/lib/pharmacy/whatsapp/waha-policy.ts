import 'server-only';
import { lockCustomerConsent } from '../consent-writer';
import { randomUUID } from 'node:crypto';
import { decryptSecret } from '@/lib/secret-crypto';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { readTenantMedicineNames } from '../medicine-names';
import { lintWhatsAppMessage } from './compliance-linter';
import { findCustomerByWhatsApp } from './inbound';
import { canMessageCustomer } from './messages';
import { readWahaSession } from './waha-session';
import { WahaClient, WahaFailure, type WahaContent } from './waha-client';
import { isUtilityReminderQuietHour, reminderLocalHour } from './reminder-quiet-hours';
import { WhatsAppProviderError } from './provider';

export function wahaSendAllowed(input: {
  optedIn: boolean;
  quiet: boolean;
  restricted: boolean;
  portalAllowed: boolean;
  connected: boolean;
  minute: number;
  day: number;
  minuteCap: number;
  dayCap: number;
  lastCold: number | null;
  hasInbound: boolean;
  now: number;
}) {
  return (
    input.optedIn &&
    !input.quiet &&
    !input.restricted &&
    input.portalAllowed &&
    input.connected &&
    input.minute < input.minuteCap &&
    input.day < input.dayCap &&
    (input.hasInbound || input.lastCold === null || input.now - input.lastCold >= 120000)
  );
}

export async function guardedWahaSend(
  organizationId: string,
  to: string,
  purpose: string,
  content: WahaContent
) {
  if (['test', 'portalSignInCode', 'media', 'consentReply'].includes(purpose)) {
    // The normal utility flows already hold this lock in sendClaimedMessage.
    return withTenantDb(organizationId, async (db) => {
      const customer = await findCustomerByWhatsApp(db, organizationId, to);
      if (!customer) throw new WhatsAppProviderError('WAHA_POLICY');
      await lockCustomerConsent(db, organizationId, customer.id);
      return reserveAndSend(organizationId, to, purpose, content);
    });
  }
  return reserveAndSend(organizationId, to, purpose, content);
}
async function reserveAndSend(
  organizationId: string,
  to: string,
  purpose: string,
  content: WahaContent
) {
  const id = randomUUID();
  const reservation = await withTenantDb(organizationId, async (db) => {
    await db.$queryRaw`SELECT "organizationId" FROM pharmacy_waha_sessions WHERE "organizationId"=${organizationId} FOR NO KEY UPDATE`;
    const session = await readWahaSession(db, organizationId);
    if (session?.restrictionCode) throw new WhatsAppProviderError('WAHA_POLICY');
    if (
      !session ||
      session.status !== 'WORKING' ||
      decryptSecret(session.encryptedApiKey).startsWith('unissued:')
    )
      throw new WhatsAppProviderError('WAHA_DISCONNECTED');
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true, vertical: true, status: true, isDemo: true },
    });
    const customer = await findCustomerByWhatsApp(db, organizationId, to);
    if (
      !org ||
      org.isDemo ||
      org.vertical !== 'PHARMACY' ||
      !isTenantLifecycleAccessible(org.status) ||
      !customer
    )
      throw new WhatsAppProviderError('WAHA_POLICY');
    const now = new Date();
    const hasInbound = !!(await db.pharmacyMessageLog.findFirst({
      where: { organizationId, customerId: customer.id, direction: 'INBOUND', channel: 'WHATSAPP' },
      select: { id: true },
    }));
    const [usage] = await db.$queryRaw<{ minute: number; day: number; lastCold: Date | null }[]>`
      SELECT count(*) FILTER (WHERE "createdAt" > now()-interval '1 minute')::int AS minute,
      count(*)::int AS day, max("createdAt") FILTER (WHERE cold) AS "lastCold"
      FROM pharmacy_waha_attempts WHERE "organizationId"=${organizationId} AND "createdAt">now()-interval '24 hours'`;
    if (
      !wahaSendAllowed({
        ...usage,
        now: now.getTime(),
        lastCold: usage.lastCold?.getTime() ?? null,
        hasInbound,
        minuteCap: session.perMinute,
        dayCap: session.perDay,
        restricted: !!session.restrictionCode,
        connected: session.status === 'WORKING',
        portalAllowed: purpose !== 'portalSignInCode' || session.portalCodes,
        optedIn: canMessageCustomer(customer),
        quiet: isUtilityReminderQuietHour(reminderLocalHour(now, workspaceTimezone(org.timezone))),
      })
    )
      throw new WhatsAppProviderError('WAHA_POLICY');
    if (
      'text' in content &&
      lintWhatsAppMessage({
        purpose: 'UTILITY',
        template: content.text,
        catalogNames: await readTenantMedicineNames(db),
      }).outcome === 'BLOCK'
    )
      throw new WhatsAppProviderError('WAHA_POLICY');
    await db.$executeRaw`INSERT INTO pharmacy_waha_attempts (id,"organizationId",cold,purpose) VALUES (${id}::uuid,${organizationId},${!hasInbound},${purpose})`;
    return { session: session.sessionName, apiKey: decryptSecret(session.encryptedApiKey) };
  });
  const client = new WahaClient(reservation.session, reservation.apiKey);
  let result;
  try {
    result = await client.send(to, content);
  } catch (error) {
    const failure = error instanceof WahaFailure ? error : new WahaFailure('UNKNOWN', false);
    await withTenantDb(organizationId, async (db) => {
      if (failure.restriction)
        await db.$executeRaw`UPDATE pharmacy_waha_sessions SET "restrictionCode"=${failure.restriction} WHERE "organizationId"=${organizationId}`;
      await db.$executeRaw`UPDATE pharmacy_waha_attempts SET outcome=${failure.reason} WHERE id=${id}::uuid`;
    });
    if (failure.restriction) throw new WhatsAppProviderError('WAHA_POLICY');
    throw new WhatsAppProviderError(
      failure.reason === 'NOT_ON_WHATSAPP' ? 'NOT_ON_WHATSAPP' : 'SEND_FAILED',
      undefined,
      failure.definitive
    );
  }
  await withTenantDb(
    organizationId,
    (db) =>
      db.$executeRaw`UPDATE pharmacy_waha_attempts SET outcome='ACCEPTED',"providerMessageId"=${result.providerMessageId} WHERE id=${id}::uuid`
  );
  return result;
}

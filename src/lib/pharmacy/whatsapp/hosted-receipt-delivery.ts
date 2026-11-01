import 'server-only';

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { trackSideEffect } from '@/lib/side-effects/scope';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { createReceiptOtpCode } from './hosted-receipt';
import {
  authorizeHostedReceiptRecord,
  tenantHostedReceiptRecipientOptedOut,
} from './hosted-receipt-store';
import { sendAndLog } from './message-log';
import { phoneLast4 } from './messages';
import { createWhatsAppProvider } from './provider';

export const HOSTED_RECEIPT_EFFECT = 'pharmacy-hosted-receipt';
const deliverySchema = z.object({
  organizationId: z.string().min(1),
  recordId: z.string().min(1),
  token: z.string().min(1),
  phone: z.string().regex(/^[1-9]\d{7,14}$/),
  message: z.string().min(1),
});
type Delivery = z.infer<typeof deliverySchema>;

function deliveryKey(secret: string) {
  if (secret.length < 32) throw new Error('Receipt service unavailable.');
  return createHmac('sha256', secret).update('pharmacy-hosted-receipt-delivery-v1').digest();
}

/** Persist the delivery intent in the same transaction as the receipt. */
export async function queueHostedReceiptDelivery(db: ScopedDb, delivery: Delivery, secret: string) {
  // Outbox payloads must not expose the bearer link, message, or full phone.
  // Bind ciphertext to the tenant that owns the outbox row.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deliveryKey(secret), iv);
  cipher.setAAD(Buffer.from(delivery.organizationId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(delivery)), cipher.final()]);
  const ciphertext = [iv, encrypted, cipher.getAuthTag()]
    .map((value) => value.toString('base64url'))
    .join('.');
  const work = db.outboundEffect.create({
    data: {
      organizationId: delivery.organizationId,
      kind: HOSTED_RECEIPT_EFFECT,
      payload: { ciphertext },
      status: 'PENDING',
    },
  });
  trackSideEffect(work);
  await work;
}

/** Called only by the existing drainer, outside the owning transaction. */
export async function deliverHostedReceipt(payload: Prisma.JsonValue, organizationId: string) {
  const secret = process.env.PHARMACY_HOSTED_RECEIPT_SECRET;
  if (!secret) throw new Error('Receipt service unavailable.');
  const { ciphertext } = z.object({ ciphertext: z.string() }).parse(payload);
  const [iv, encrypted, tag] = ciphertext.split('.').map((value) => Buffer.from(value, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', deliveryKey(secret), iv);
  decipher.setAAD(Buffer.from(organizationId));
  decipher.setAuthTag(tag);
  const delivery = deliverySchema.parse(
    JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'))
  );
  if (delivery.organizationId !== organizationId) throw new Error('Receipt link is unavailable.');

  // Eligibility and STOP may have changed while the committed intent waited.
  const { id, receipt } = await authorizeHostedReceiptRecord(delivery.token, secret);
  if (id !== delivery.recordId || receipt.organizationId !== organizationId)
    throw new Error('Receipt link is unavailable.');
  if (await tenantHostedReceiptRecipientOptedOut(organizationId, delivery.phone, receipt.saleId))
    return;

  const provider = createWhatsAppProvider();
  const dedupeKey = `hosted-receipt:${id}`;
  const entry = {
    organizationId,
    branchId: receipt.branchId,
    kind: 'HOSTED_RECEIPT' as const,
    phoneLast4: phoneLast4(delivery.phone),
    orderId: receipt.saleId,
  };
  const outcome = await sendAndLog({ ...entry, dedupeKey }, () =>
    provider.sendText({ to: delivery.phone, body: delivery.message })
  );
  // Read the durable acknowledgement even on a duplicate drain. If recording
  // receipt metadata failed after a send, a retry repairs it without resending.
  const log = await withTenantDb(organizationId, (db) =>
    db.pharmacyMessageLog.findFirst({
      where: { organizationId, dedupeKey },
      select: { status: true, providerMessageId: true },
    })
  );
  if (log?.providerMessageId)
    await withTenantDb(organizationId, (db) =>
      db.pharmacyHostedReceipt.updateMany({
        where: { organizationId, id },
        data: {
          providerMessageId: log.providerMessageId,
          ...(log.status === 'SENT' ? { deliveredAt: new Date() } : {}),
        },
      })
    );

  if (receipt.rx && (outcome === 'SENT' || outcome === 'PREPARED' || log?.providerMessageId)) {
    const now = new Date();
    await sendAndLog(
      { ...entry, dedupeKey: `hosted-receipt-code:${id}:${Math.floor(now.getTime() / 300_000)}` },
      () =>
        provider.sendText({
          to: delivery.phone,
          body: `Your receipt verification code is ${createReceiptOtpCode(delivery.token, secret, now)}. It expires in 5 minutes.`,
        })
    );
  }
  // Provider outcomes are retained in pharmacy_message_logs. A consumed claim
  // is never automatically resent, including an uncertain provider response.
}

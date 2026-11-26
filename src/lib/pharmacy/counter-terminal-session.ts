import 'server-only';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { hashDeviceSecret } from '@/lib/retail-terminal/device-secret';
import type { LedgerScope } from './stock-ledger';

const id = z.string().min(1).max(160);

export class CounterTransportError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400
  ) {
    super(code);
  }
}

const sessionSchema = z
  .object({
    actorId: id,
    organizationId: id,
    branchId: id,
    deviceId: id,
    credentialHash: z.string(),
    expiresAt: z.number(),
    nonce: z.string(),
  })
  .strict();
function sessionMac(payload: string) {
  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) throw new CounterTransportError('session_unavailable', 503);
  return createHmac('sha256', key)
    .update('pharmacy-counter-session:v1\n')
    .update(payload)
    .digest('hex');
}
/** Opaque evidence that this till retired a matching person's step for this action. */
export function counterChoiceProof(
  scope: LedgerScope,
  deviceId: string,
  kind: string,
  authenticatorId: string,
  staffProfileId: string,
  step: number
) {
  return sessionMac('counter-approval-choice:v1\n' + JSON.stringify([
    scope.organizationId, scope.branchId, scope.actorId, deviceId, kind, authenticatorId, staffProfileId, step,
  ]));
}

export function establishToken(ctx: {
  scope: LedgerScope;
  deviceId: string;
  deviceSecret: string;
}) {
  const payload = Buffer.from(
    JSON.stringify({
      ...ctx.scope,
      actorId: ctx.scope.actorId,
      deviceId: ctx.deviceId,
      credentialHash: hashDeviceSecret(ctx.deviceSecret),
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      nonce: randomUUID(),
    })
  ).toString('base64url');
  return payload + '.' + sessionMac(payload);
}
export function verifyToken(
  token: string,
  ctx: { scope: LedgerScope; deviceId: string; credentialHash: string }
) {
  const [payload, signature, ...extra] = token.split('.');
  if (
    !payload ||
    !signature ||
    extra.length ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sessionMac(payload), 'hex'))
  )
    throw new CounterTransportError('invalid_terminal_session', 401);
  const parsed = sessionSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  if (
    !parsed.success ||
    parsed.data.expiresAt <= Date.now() ||
    parsed.data.actorId !== ctx.scope.actorId ||
    parsed.data.organizationId !== ctx.scope.organizationId ||
    parsed.data.branchId !== ctx.scope.branchId ||
    parsed.data.deviceId !== ctx.deviceId ||
    parsed.data.credentialHash !== ctx.credentialHash
  )
    throw new CounterTransportError('invalid_terminal_session', 401);
}

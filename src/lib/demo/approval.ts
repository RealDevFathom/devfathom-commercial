import 'server-only';

import { createHmac } from 'node:crypto';

export function demoApproverEmail(seat: number): string {
  if (!Number.isInteger(seat) || seat < 1 || seat > 25) {
    throw new Error('Demo seat must be an integer from 1 to 25.');
  }
  return `approver.seat${seat}@demo.devfathom.invalid`;
}

export function deriveDemoApproverPin(organizationId: string): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error('AUTH_SECRET is required for demo approval.');
  if (!organizationId || organizationId.length > 128) {
    throw new Error('A valid organization identifier is required for demo approval.');
  }
  const digest = createHmac('sha256', secret)
    .update(`restaurant-demo-approver-pin:v1:${organizationId}`)
    .digest();
  return (digest.readBigUInt64BE() % BigInt(100_000_000)).toString().padStart(8, '0');
}

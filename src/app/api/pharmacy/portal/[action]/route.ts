import { z } from 'zod';

import {
  readPortalRequestBody,
  portalContext,
  portalResponse,
} from '@/lib/pharmacy/customer-portal-http';

export const runtime = 'nodejs';

/**
 * DEV-15 (#762): the customer PWA's public API. Tenant identity comes only from
 * the host; customer identity comes only from the signed-in portal session.
 */
const actionSchema = z.enum(['start', 'verify', 'me', 'request', 'cancel', 'sign-out']);

export async function GET(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const action = actionSchema.safeParse((await params).action);
  if (!action.success || action.data !== 'me') return portalResponse.notFound();
  let context;
  try {
    context = await portalContext(request);
  } catch {
    return portalResponse.unexpected();
  }
  if (!context) return portalResponse.notFound();
  return context.handle('me', null);
}

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const action = actionSchema.safeParse((await params).action);
  if (!action.success || action.data === 'me') return portalResponse.notFound();
  let context;
  try {
    context = await portalContext(request);
  } catch {
    return portalResponse.unexpected();
  }
  if (!context) return portalResponse.notFound();
  const input = await readPortalRequestBody(request);
  if (!input) return portalResponse.tooLarge();
  return context.handle(action.data, input.body);
}

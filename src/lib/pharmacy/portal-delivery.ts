import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  readWhatsAppConfig,
  WhatsAppProviderError,
  type WhatsAppConfig,
} from './whatsapp/provider';

export function reportPortalFailure(reason: 'SEND_FAILED' | 'UNEXPECTED') {
  const reference = randomUUID();
  console.error('pharmacy.portal', { reason, reference });
  return reference;
}

// Error names and messages can carry arbitrary remote data. Classify locally
// and read only the numeric HTTP status recorded by the WhatsApp adapter.
export function safePortalDeliveryFailure(error: unknown) {
  if (error instanceof WhatsAppProviderError) {
    const status = error.httpStatus;
    return {
      errorName: 'WhatsAppProviderError',
      providerStatus:
        status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
          ? status
          : null,
    };
  }
  return { errorName: error instanceof Error ? 'Error' : 'UnknownError', providerStatus: null };
}

export function portalWhatsAppReady(
  organizationId: string,
  config: WhatsAppConfig = readWhatsAppConfig()
): boolean {
  return Boolean(
    config.provider === 'meta' &&
    config.liveSendApproved &&
    config.organizationId === organizationId &&
    config.accessToken &&
    config.phoneNumberId &&
    config.templates.portalSignInCode
  );
}

/** Explicit local fixture transport. Only a demo tenant, loopback test database
 * and a North American fictional-use number can receive a console code. */
export function portalSyntheticSender(
  organization: { isDemo: boolean },
  host: string,
  config: WhatsAppConfig = readWhatsAppConfig()
) {
  if (
    process.env.PHARMACY_PORTAL_LOG_SYNTHETIC_CODES !== '1' ||
    (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') ||
    (process.env.DEPLOY_ENV &&
      !['development', 'test', 'local'].includes(process.env.DEPLOY_ENV)) ||
    process.env.VERCEL_ENV === 'production' ||
    !organization.isDemo ||
    !host.endsWith('.localhost') ||
    config.provider !== 'mock'
  )
    return null;

  try {
    const db = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(db.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(db.hostname) ||
      db.search ||
      db.hash ||
      !/(?:^|[_-])(?:test|e2e|disposable|tmp)(?:$|[_-])/i.test(db.pathname.slice(1))
    )
      return null;
  } catch {
    return null;
  }

  return async ({ to, otp }: { to: string; otp: string }) => {
    if (!/^120255501\d{2}$/.test(to) || !/^\d{6}$/.test(otp))
      throw new Error('Synthetic destination required.');
    console.info(`Synthetic portal code: ${otp}`);
  };
}

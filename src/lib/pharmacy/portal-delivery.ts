import 'server-only';

import { readWhatsAppConfig, type WhatsAppConfig } from './whatsapp/provider';

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

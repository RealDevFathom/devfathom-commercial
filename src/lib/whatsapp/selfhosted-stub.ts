import type {
  WhatsAppAdapterPort,
  WhatsAppSendInput,
  WhatsAppSendResult,
} from '@/lib/ai/shared/wa-adapter.types';

type Env = Record<string, string | undefined>;

/**
 * EXPERIMENTAL — DO NOT ENABLE IN PRODUCTION.
 *
 * Unofficial self-hosted WhatsApp automation can violate WhatsApp's terms and
 * can cause the connected account to be banned. This adapter intentionally
 * performs no work, even when the experimental flag is enabled.
 */
export class SelfHostedWhatsAppNotEnabledError extends Error {
  constructor() {
    super('NotEnabled');
    this.name = 'NotEnabled';
  }
}

/** Default-off feature flag. Only the exact value `true` opts in. */
export const WHATSAPP_SELFHOSTED_EXPERIMENTAL =
  process.env.WHATSAPP_SELFHOSTED_EXPERIMENTAL === 'true';

export class SelfHostedWhatsAppAdapter implements WhatsAppAdapterPort {
  async send(_input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    throw new SelfHostedWhatsAppNotEnabledError();
  }
}

/**
 * Composition helper that fails closed, keeping the stub out of the default
 * adapter selection path. Passing env makes the policy straightforward to test.
 */
export function createSelfHostedWhatsAppAdapter(
  env: Env = process.env
): WhatsAppAdapterPort | null {
  if (env.WHATSAPP_SELFHOSTED_EXPERIMENTAL !== 'true') return null;
  return new SelfHostedWhatsAppAdapter();
}

import {
  WhatsAppProviderError,
  type WhatsAppConfig,
  type WhatsAppProvider,
  type WhatsAppTemplateKey,
  type WhatsAppTemplateLanguage,
} from './provider';
import type { WahaContent } from './waha-client';

export type WahaWording = Partial<
  Record<WhatsAppTemplateKey, Partial<Record<WhatsAppTemplateLanguage, string>>>
>;
export function readWahaWording(env: Record<string, string | undefined>): WahaWording {
  const names = {
    refillReminder: 'REFILL',
    khataReminder: 'KHATA',
    receiptLink: 'RECEIPT',
    backInStock: 'BACK_IN_STOCK',
    portalSignInCode: 'PORTAL_CODE',
  } as const;
  const wording: WahaWording = {};
  for (const key of Object.keys(names) as WhatsAppTemplateKey[]) {
    const entry: Partial<Record<WhatsAppTemplateLanguage, string>> = {};
    for (const lang of ['en', 'ur'] as const) {
      const body = env['PHARMACY_WAHA_' + names[key] + '_' + lang.toUpperCase()]?.trim();
      if (body && body.length <= 1024) entry[lang] = body;
    }
    wording[key] = entry;
  }
  return wording;
}
export class WahaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'waha' as const;
  constructor(private readonly config: WhatsAppConfig) {}
  private async deliver(to: string, purpose: string, content: WahaContent) {
    if (!this.config.organizationId) throw new WhatsAppProviderError('NOT_CONFIGURED');
    const { guardedWahaSend } = await import('./waha-policy');
    return guardedWahaSend(this.config.organizationId, to, purpose, content);
  }
  async sendTemplate({
    to,
    template,
    language,
    parameters,
  }: Parameters<WhatsAppProvider['sendTemplate']>[0]) {
    const lang = language ?? (this.config.templateLanguage === 'ur' ? 'ur' : 'en');
    const wording = this.config.wahaWording?.[template]?.[lang];
    const expected =
      template === 'khataReminder'
        ? this.config.khataParameterOrder[lang]?.length
        : ({ refillReminder: 1, receiptLink: 5, backInStock: 3, portalSignInCode: 1 } as const)[
            template
          ];
    if (!wording || !expected || parameters.length !== expected)
      throw new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED');
    const used = new Set<number>();
    const text = wording.replace(/\{\{(\d+)\}\}/g, (_, raw: string) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > expected)
        throw new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED');
      used.add(n);
      return parameters[n - 1];
    });
    if (used.size !== expected || /[{}]/.test(text))
      throw new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED');
    return this.deliver(to, template, { text });
  }
  sendText({ to, body }: Parameters<WhatsAppProvider['sendText']>[0]) {
    return this.deliver(to, 'reply', { text: body });
  }
  sendMedia({
    to,
    bytes,
    mime,
  }: {
    to: string;
    bytes: Uint8Array;
    mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  }) {
    if (!bytes.length || bytes.length > 5 * 1024 * 1024)
      throw new WhatsAppProviderError('WAHA_POLICY');
    return this.deliver(to, 'media', { bytes, mime });
  }
  // The Meta route cannot verify or dispatch a WAHA event. The WAHA receiver must also bind its signed session.
  verifyWebhook() {
    return false;
  }
  parseInbound() {
    return [];
  }
}

/** Merge boundary for the WhatsApp provider work developed on another branch. */
export type WhatsAppOutboundMessage = {
  organizationId: string;
  customerId: string;
  to: string;
  body: string;
};

export type WhatsAppSendReceipt = { providerMessageId: string };

export interface WhatsAppAdapterPort {
  /** Server-side configuration check; implementations must never expose the secret. */
  isProviderConfigured(organizationId: string): Promise<boolean>;
  send(message: WhatsAppOutboundMessage): Promise<WhatsAppSendReceipt>;
}

export const unimplementedWhatsAppAdapter: WhatsAppAdapterPort = {
  async isProviderConfigured() {
    return false;
  },
  async send() {
    throw new Error('NotImplemented: WhatsApp adapter');
  },
};

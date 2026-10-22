/** Provider-neutral WhatsApp transport contract. */
export interface WhatsAppAdapter {
  sendTemplate(input: WhatsAppTemplateSend): Promise<WhatsAppSendResult>;
  sendSessionText(input: WhatsAppSessionTextSend): Promise<WhatsAppSendResult>;
  /** Validate an X-Hub-Signature-256 value against the unmodified request bytes. */
  verifyWebhook(rawBody: string | Uint8Array, signature: string | null): boolean;
  parseWebhook(payload: unknown): WhatsAppInboundMessage[];
}

export type WhatsAppSendGate = {
  /** The tenant's WhatsApp channel must be explicitly enabled. */
  organizationWhatsAppEnabled: boolean;
  /** Sending requires an explicit customer opt-in; null is not consent. */
  customerOptIn: boolean | null;
};

export type WhatsAppTemplateSend = WhatsAppSendGate & {
  to: string;
  templateName: string;
  languageCode: string;
  parameters?: string[];
};

export type WhatsAppSessionTextSend = WhatsAppSendGate & {
  to: string;
  body: string;
};

export type WhatsAppSendResult = { providerMessageId: string };

export type WhatsAppInboundMessage = {
  providerMessageId: string;
  from: string;
  text: string;
  receivedAt: Date;
  phoneNumberId: string | null;
};

export type WhatsAppSendRefusal = 'ORGANIZATION_DISABLED' | 'CUSTOMER_NOT_OPTED_IN';

export class WhatsAppSendRefusedError extends Error {
  constructor(readonly reason: WhatsAppSendRefusal) {
    super(`WhatsApp send refused: ${reason}.`);
    this.name = 'WhatsAppSendRefusedError';
  }
}

/** Fail-closed shared send guard. */
export function assertWhatsAppSendAllowed(gate: WhatsAppSendGate): void {
  if (gate.organizationWhatsAppEnabled !== true) {
    throw new WhatsAppSendRefusedError('ORGANIZATION_DISABLED');
  }
  if (gate.customerOptIn !== true) {
    throw new WhatsAppSendRefusedError('CUSTOMER_NOT_OPTED_IN');
  }
}

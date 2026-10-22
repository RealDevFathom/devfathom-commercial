/** Minimal transport seam shared with the WhatsApp adapter work. */
export type WhatsAppSendInput = {
  organizationId: string;
  to: string;
  text: string;
};

export type WhatsAppSendResult = {
  messageId: string;
};

/** Injectable port; implementations must preserve the organization boundary. */
export interface WhatsAppAdapterPort {
  send(input: WhatsAppSendInput): Promise<WhatsAppSendResult>;
}

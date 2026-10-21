export type WhatsAppSendResult = { providerMessageId: string };

export type WhatsAppConnection = 'connected' | 'needs_pairing' | 'unavailable';

/** Evolution (and a future Cloud API engine) sit behind this pair of calls. */
export interface WhatsAppProvider {
  sendText(to: string, body: string): Promise<WhatsAppSendResult>;
  getStatus(): Promise<WhatsAppConnection>;
}

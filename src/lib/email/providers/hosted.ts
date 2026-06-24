import type {
  AdapterCredentials,
  ListResult,
  MailAdapter,
  NormalizedMessage,
  SendOptions,
} from '../adapter';

/**
 * RESERVED — a future self-hosted @domain mailbox (e.g. you@yourcompany.com).
 *
 * It exists only so the {@link MailAdapter} seam is proven end-to-end: when
 * hosting is built, fill these methods in and it plugs into the factory without
 * any change to the email router or the UI. Do NOT implement hosting here now.
 */
export class HostedAdapter implements MailAdapter {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_creds: AdapterCredentials) {}

  private notImplemented(): never {
    throw new Error('Hosted mailboxes are not available yet.');
  }

  async listMessages(): Promise<ListResult> {
    return this.notImplemented();
  }
  async sync(): Promise<ListResult> {
    return this.notImplemented();
  }
  async getMessage(): Promise<NormalizedMessage | null> {
    return this.notImplemented();
  }
  async sendMessage(_opts: SendOptions): Promise<{ providerMessageId: string | null }> {
    return this.notImplemented();
  }
}

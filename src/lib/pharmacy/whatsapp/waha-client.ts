import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { wahaOrigin } from './waha-session';

export type WahaContent =
  | { text: string }
  | { bytes: Uint8Array; caption?: string; mime: 'application/pdf' | 'image/png' | 'image/jpeg' };
export class WahaFailure extends Error {
  constructor(
    readonly reason: 'UNAVAILABLE' | 'NOT_ON_WHATSAPP' | 'RESTRICTED' | 'UNKNOWN',
    readonly definitive: boolean,
    readonly restriction?: 463 | 475,
    readonly httpStatus?: number
  ) {
    super(reason);
  }
}
export function wahaMessageId(id: string) {
  return 'waha:' + createHash('sha256').update(id).digest('hex');
}
const restriction = (value: unknown): 463 | 475 | undefined => {
  const data = z
    .object({
      exception: z.object({ message: z.string() }).optional(),
      error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
      message: z.string().optional(),
    })
    .safeParse(value);
  if (!data.success) return;
  const error = data.data.error;
  const match = /\bserver returned error (463|475)\b/i.exec(
    typeof error === 'string'
      ? error
      : (error?.message ?? data.data.exception?.message ?? data.data.message ?? '')
  );
  return match?.[1] === '463' ? 463 : match?.[1] === '475' ? 475 : undefined;
};

export class WahaClient {
  constructor(
    private readonly session: string,
    private readonly apiKey: string
  ) {}
  private async request(
    path: string,
    method = 'GET',
    body?: unknown,
    send = false
  ): Promise<unknown> {
    const origin = wahaOrigin();
    if (!origin) throw new WahaFailure('UNAVAILABLE', true);
    try {
      const res = await fetch(origin + path, {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code =
          restriction(json) ?? (res.status === 463 || res.status === 475 ? res.status : undefined);
        if (code) throw new WahaFailure('RESTRICTED', true, code);
        throw new WahaFailure(send ? 'UNKNOWN' : 'UNAVAILABLE', !send, undefined, res.status);
      }
      return json;
    } catch (e) {
      if (e instanceof WahaFailure) throw e;
      throw new WahaFailure(send ? 'UNKNOWN' : 'UNAVAILABLE', !send);
    }
  }
  async send(to: string, content: WahaContent) {
    if (!/^[1-9]\d{7,14}$/.test(to)) throw new WahaFailure('NOT_ON_WHATSAPP', true);
    const query = new URLSearchParams({ phone: to, session: this.session });
    const result = z
      .object({ numberExists: z.boolean(), chatId: z.string().optional() })
      .safeParse(await this.request('/api/contacts/check-exists?' + query));
    if (!result.success) throw new WahaFailure('UNAVAILABLE', true);
    if (!result.data.numberExists) throw new WahaFailure('NOT_ON_WHATSAPP', true);
    const chatId = result.data.chatId;
    if (!chatId || !/^\d{6,20}@(c\.us|lid)$/.test(chatId))
      throw new WahaFailure('UNAVAILABLE', true);
    const target = { session: this.session, chatId };
    let response: unknown;
    if ('text' in content) {
      response = await this.request(
        '/api/sendText',
        'POST',
        { ...target, text: content.text, linkPreview: false },
        true
      );
    } else {
      const pdf = content.mime === 'application/pdf';
      response = await this.request(
        pdf ? '/api/sendFile' : '/api/sendImage',
        'POST',
        {
          ...target,
          ...(content.caption ? { caption: content.caption } : {}),
          file: {
            mimetype: content.mime,
            filename: pdf
              ? 'document.pdf'
              : content.mime === 'image/png'
                ? 'image.png'
                : 'image.jpg',
            data: Buffer.from(content.bytes).toString('base64'),
          },
        },
        true
      );
    }
    const parsed = z.object({ id: z.string().min(1).max(1024) }).safeParse(response);
    if (!parsed.success) throw new WahaFailure('UNKNOWN', false);
    return { providerMessageId: wahaMessageId(parsed.data.id), acceptedByProvider: true };
  }

  private get path() {
    return '/api/sessions/' + encodeURIComponent(this.session);
  }
  async start(callback: string, webhookSecret: string) {
    await this.request('/api/sessions', 'POST', {
      name: this.session,
      start: true,
      config: {
        debug: false,
        webhooks: [
          {
            url: callback,
            events: ['message', 'message.ack', 'session.status'],
            retries: { attempts: 3, delaySeconds: 2, policy: 'constant' },
            hmac: { key: webhookSecret },
          },
        ],
      },
    });
  }
  async activate() {
    await this.request(this.path + '/start', 'POST');
  }
  async disconnect() {
    await this.request(this.path + '/logout', 'POST', {});
    await this.request(this.path + '/stop', 'POST');
  }
  async issueSessionKey() {
    const dto = z
      .object({
        session: z.literal(this.session),
        isAdmin: z.literal(false),
        isActive: z.literal(true),
        key: z.string().min(1).max(512),
      })
      .safeParse(
        await this.request('/api/keys', 'POST', {
          isAdmin: false,
          isActive: true,
          session: this.session,
          actions: {
            read: true,
            send: true,
            control: true,
            setting: false,
            app: false,
            delete: false,
          },
        })
      );
    if (!dto.success) throw new WahaFailure('UNAVAILABLE', true);
    return dto.data.key;
  }
  async phoneForLid(lid: string) {
    const parsed = z
      .object({ lid: z.literal(lid), pn: z.string().nullable() })
      .safeParse(
        await this.request(
          '/api/' + encodeURIComponent(this.session) + '/lids/' + encodeURIComponent(lid)
        )
      );
    return parsed.success ? (parsed.data.pn?.match(/^(\d{8,15})@c\.us$/)?.[1] ?? null) : null;
  }
  async status() {
    const dto = z
      .object({
        name: z.literal(this.session),
        status: z.string(),
        me: z
          .object({
            id: z.string(),
            reachoutTimelock: z.object({ isActive: z.boolean() }).nullish(),
            messageCapping: z.object({ cappingStatus: z.string() }).nullish(),
          })
          .nullish(),
      })
      .safeParse(await this.request(this.path));
    if (!dto.success) throw new WahaFailure('UNAVAILABLE', true);
    return {
      status: dto.data.status,
      restriction: dto.data.me?.reachoutTimelock?.isActive
        ? 463
        : dto.data.me?.messageCapping?.cappingStatus === 'CAPPED'
          ? 475
          : null,
      number: dto.data.me?.id.match(/^(\d{8,15})(?::\d+)?@c\.us$/)?.[1] ?? null,
    };
  }
  async qr() {
    const qr = z
      .object({
        mimetype: z.literal('image/png'),
        data: z
          .string()
          .min(1)
          .max(180000)
          .regex(/^[A-Za-z0-9+/]+=*$/),
      })
      .safeParse(
        await this.request('/api/' + encodeURIComponent(this.session) + '/auth/qr?format=image')
      );
    if (!qr.success) throw new WahaFailure('UNAVAILABLE', true);
    return 'data:image/png;base64,' + qr.data.data;
  }
}

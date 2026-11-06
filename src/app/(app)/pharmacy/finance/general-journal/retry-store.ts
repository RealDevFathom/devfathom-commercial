import 'server-only';
import { cookies } from 'next/headers';

const route = '/pharmacy/finance/general-journal';
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

export const RETRY_COOKIE = 'pharmacy-general-journal-retry';
// Submitted values a failed command hands back to the re-rendered page. They
// travel in short-lived, httpOnly, path-scoped cookies keyed by a one-time
// nonce, so business text never lands in a URL or browser history.
const RETAINED_FIELDS = [
  'action',
  'documentId',
  'idempotencyKey',
  'reference',
  'amount',
  'occurredAt',
  'evidence',
  'reason',
  'reversalDate',
  'reversalReason',
] as const;
type RetainedField = (typeof RETAINED_FIELDS)[number];
export type Retained = { nonce: string; branchId: string; message: string } & Partial<
  Record<RetainedField, string>
>;
// Per-field caps match the accepted input sizes, so retention always covers
// what the form allows.
const FIELD_LIMITS: Record<RetainedField, number> = {
  action: 16,
  documentId: 128,
  idempotencyKey: 128,
  reference: 80,
  amount: 32,
  occurredAt: 10,
  evidence: 500,
  reason: 500,
  reversalDate: 10,
  reversalReason: 500,
};
// Only the fields the failed command can show again are kept, which bounds
// the worst case (500-character evidence and reason in 3- or 4-byte UTF-8
// scripts such as Urdu) to two chunks.
const COMMAND_FIELDS: Record<string, readonly RetainedField[]> = {
  create: ['reference', 'amount', 'occurredAt', 'evidence', 'reason'],
  update: ['reference', 'amount', 'occurredAt', 'evidence', 'reason'],
  reverse: ['reversalDate', 'reversalReason'],
};
// The payload is base64url-encoded UTF-8 (4 bytes per 3, instead of up to 9
// bytes per character when percent-encoded) and split across numbered
// cookies, each well under the ~4 KB per-cookie browser limit.
export const RETRY_CHUNK_SIZE = 3800;
export const RETRY_MAX_CHUNKS = 3;
export const retryChunk = (index: number) => `${RETRY_COOKIE}.${index}`;

export function retainedPayload(
  form: FormData,
  base: Pick<Retained, 'nonce' | 'branchId' | 'message'>
): Retained {
  const saved: Retained = { ...base };
  const action = field(form, 'action');
  for (const name of [
    'action',
    'documentId',
    'idempotencyKey',
    ...(COMMAND_FIELDS[action] ?? []),
  ] as const) {
    saved[name] = field(form, name).slice(0, FIELD_LIMITS[name]);
  }
  return saved;
}

export function encodeRetained(saved: Retained): string[] {
  const encoded = Buffer.from(JSON.stringify(saved), 'utf8').toString('base64url');
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += RETRY_CHUNK_SIZE)
    chunks.push(encoded.slice(offset, offset + RETRY_CHUNK_SIZE));
  return chunks;
}

// Cookies are path-scoped, so deletion must name the same path to expire
// them. The unchunked name is the earlier single-cookie format.
export async function clearRetained() {
  const jar = await cookies();
  jar.delete({ name: RETRY_COOKIE, path: route });
  for (let index = 0; index < RETRY_MAX_CHUNKS; index += 1)
    jar.delete({ name: retryChunk(index), path: route });
}

export async function storeRetained(saved: Retained) {
  let chunks = encodeRetained(saved);
  // Unreachable with the field caps above; if it ever happens, keep the
  // request key and message rather than letting the browser drop the cookie.
  if (chunks.length > RETRY_MAX_CHUNKS)
    chunks = encodeRetained({
      nonce: saved.nonce,
      branchId: saved.branchId,
      message: saved.message,
      action: saved.action,
      documentId: saved.documentId,
      idempotencyKey: saved.idempotencyKey,
    });
  const jar = await cookies();
  chunks.forEach((chunk, index) =>
    jar.set(retryChunk(index), chunk, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: route,
      maxAge: 600,
    })
  );
  // Drop leftover chunks from a longer earlier payload and the unchunked name.
  jar.delete({ name: RETRY_COOKIE, path: route });
  for (let index = chunks.length; index < RETRY_MAX_CHUNKS; index += 1)
    jar.delete({ name: retryChunk(index), path: route });
}

export async function retainedValues(
  nonce: string | undefined,
  branchId: string
): Promise<Retained | null> {
  if (!nonce) return null;
  try {
    const jar = await cookies();
    let encoded = '';
    for (let index = 0; index < RETRY_MAX_CHUNKS; index += 1) {
      const chunk = jar.get(retryChunk(index))?.value;
      if (!chunk) break;
      encoded += chunk;
    }
    if (!encoded) return null;
    const saved = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Retained | null;
    return saved && saved.nonce === nonce && saved.branchId === branchId ? saved : null;
  } catch {
    return null;
  }
}

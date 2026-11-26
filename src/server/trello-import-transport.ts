import { TRPCError } from '@trpc/server';

import {
  MAX_TRELLO_REQUEST_BYTES,
  TRELLO_LIMIT_MESSAGE,
  trelloRawLimit,
  trelloRecordLimit,
} from '@/types/trello-import-limits';

import { rateLimit } from '@/lib/rate-limit';

const IMPORT_PATH = 'trelloImport.importBoard';
const IMPORTS_PER_WINDOW = 5;
const IMPORT_WINDOW_MS = 10 * 60_000;

export function admitTrelloImport(userId: string) {
  return rateLimit(`trello-import:user:${userId}`, IMPORTS_PER_WINDOW, IMPORT_WINDOW_MS);
}

function oversized(message = TRELLO_LIMIT_MESSAGE): never {
  throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message });
}

function invalid(): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message: 'Send a valid Trello JSON export.' });
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

/** Path-only validation is safe before authentication. It never opens the body. */
export function trelloImportIndex(req: Request, paths: string[]): number | null {
  if (req.method !== 'POST') return null;
  const index = paths.indexOf(IMPORT_PATH);
  if (index === -1) return null;
  // PostgreSQL advisory locks are reentrant on the same request transaction.
  if (index !== paths.lastIndexOf(IMPORT_PATH)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Send one Trello import per request.' });
  }
  return index;
}

/** Reject malformed headers without reading the body or spending an attempt. */
export function checkTrelloImportHeaders(req: Request) {
  if (Number(req.headers.get('content-length')) > MAX_TRELLO_REQUEST_BYTES) oversized();
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') invalid();
}

/** Check the signed-in, rate-limited import before opening its tenant transaction. */
export async function preflightTrelloImport(req: Request, index: number) {
  const reader = req.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TRELLO_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        oversized();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    invalid();
  }
  const isBatch = new URL(req.url).searchParams.get('batch') === '1';
  const envelope = record(isBatch ? record(body)?.[index] : body);
  // Trello exports and the import options are plain JSON. SuperJSON annotations
  // could change the shape between this check and the tRPC input parser.
  const input = record(envelope?.json);
  if (!input || envelope?.meta !== undefined) invalid();
  // Budget the defaulted flag as the procedure will see it.
  const limit =
    trelloRawLimit({ includeArchived: false, ...input }) ??
    trelloRecordLimit(input.trelloJson, input.includeArchived === true);
  if (limit) oversized(limit);

  // The tRPC JSON adapter uses req.json(). Share the parsed body and allow
  // Next's request proxy to return the method bound to its original Request.
  Object.defineProperty(req, 'json', { configurable: true, value: async () => body });
}

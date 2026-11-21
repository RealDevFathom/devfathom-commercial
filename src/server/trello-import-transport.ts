import { TRPCError } from '@trpc/server';

import {
  MAX_TRELLO_REQUEST_BYTES,
  TRELLO_LIMIT_MESSAGE,
  trelloImportWithinLimits,
} from '@/types/trello-import-limits';

const IMPORT_PATH = 'trelloImport.importBoard';

function oversized(): never {
  throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: TRELLO_LIMIT_MESSAGE });
}

function invalid(): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message: 'Send a valid Trello JSON export.' });
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

/** Preflight Trello POSTs before authentication, tenant lookup, or the request transaction. */
export async function preflightTrelloImport(req: Request, paths: string[]) {
  if (req.method !== 'POST' || !paths.includes(IMPORT_PATH)) return;

  const index = paths.indexOf(IMPORT_PATH);
  // PostgreSQL advisory locks are reentrant on the same request transaction.
  if (index !== paths.lastIndexOf(IMPORT_PATH)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Send one Trello import per request.' });
  }
  if (Number(req.headers.get('content-length')) > MAX_TRELLO_REQUEST_BYTES) oversized();
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') invalid();

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
  if (!trelloImportWithinLimits({ includeArchived: false, ...input })) oversized();

  // The tRPC JSON adapter uses req.json(). Share the parsed body and allow
  // Next's request proxy to return the method bound to its original Request.
  Object.defineProperty(req, 'json', { configurable: true, value: async () => body });
}

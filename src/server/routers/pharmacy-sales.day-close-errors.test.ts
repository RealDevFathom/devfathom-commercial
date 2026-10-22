import { readFileSync } from 'node:fs';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { failDayClose } from './pharmacy-sales';

const routerSource = readFileSync('src/server/routers/pharmacy-sales.ts', 'utf8');

describe('pharmacy day-close error mapping', () => {
  it.each(['closePreview', 'closeDay', 'dailyClose'])(
    'routes %s authorization through the central admin capability guard',
    (procedure) => {
      expect(routerSource).toMatch(new RegExp(`\\b${procedure}: adminProcedure\\b`));
    }
  );

  it.each([
    { code: 'P2010', message: 'Raw query failed', meta: { code: '55000' } },
    new Error('pharmacy_daily_closes is append-only'),
  ])('maps database policy failures to operator-safe copy', (failure) => {
    expect(() => failDayClose(failure)).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        message:
          'The day could not be closed safely. Refresh the preview and try again. If it still fails, ask a supervisor.',
      })
    );
  });

  it('preserves an intentional tRPC error', () => {
    const failure = new TRPCError({ code: 'BAD_REQUEST', message: 'Record a variance note.' });
    expect(() => failDayClose(failure)).toThrow(failure);
  });
});

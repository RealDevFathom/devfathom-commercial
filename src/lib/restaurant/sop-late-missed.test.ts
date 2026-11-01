/**
 * M7-L4 / WHA-226 — SOP late/missed sweep unit tests.
 *
 * Covers: the deterministic MISSED boundary (`missedAt` / `isMissedAt`), the fact
 * that the sweep issues exactly one set-based UPDATE and never writes LATE, the
 * guards that keep submitted-late work out of the sweep, payload schema
 * validation, and the injectable clock.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isMissedAt, missedAt, sopLateMissedHandler } from './sop-late-missed';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const WINDOW_ENDS = new Date('2026-08-20T12:00:00.000Z');

function makeContext(payloadOverride: Record<string, unknown> = {}): {
  ctx: RestaurantJobContext;
  updateMany: ReturnType<typeof vi.fn>;
  executeRaw: ReturnType<typeof vi.fn>;
} {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const executeRaw = vi.fn().mockResolvedValue(0);

  const db = {
    restaurantSopOccurrence: { updateMany },
    $executeRaw: executeRaw,
  } as unknown as ScopedDb;

  const ctx: RestaurantJobContext = {
    db,
    job: {
      id: 'job_1',
      organizationId: 'org_1',
      type: 'sop.sweepLateMissed',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payloadOverride as any,
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'worker_1',
      claimToken: 'sop-sweep-test-claim',
      startedAt: new Date(),
    },
  };

  return { ctx, updateMany, executeRaw };
}

/** The SQL text of the single statement the handler issues. */
function sweepSql(executeRaw: ReturnType<typeof vi.fn>): string {
  const [template] = executeRaw.mock.calls[0] as [TemplateStringsArray];
  return template.join(' ').replace(/\s+/g, ' ');
}

describe('missedAt / isMissedAt', () => {
  it('adds the grace period to the window close', () => {
    expect(missedAt(WINDOW_ENDS, 0).toISOString()).toBe('2026-08-20T12:00:00.000Z');
    expect(missedAt(WINDOW_ENDS, 30).toISOString()).toBe('2026-08-20T12:30:00.000Z');
  });

  it('is not missed at the boundary instant (strict comparison)', () => {
    // The same instant `submitOccurrence` still treats as on-time (`now > windowEndsAt`),
    // so no single instant is claimed by both the request path and the sweep.
    expect(isMissedAt(WINDOW_ENDS, WINDOW_ENDS, 0)).toBe(false);
    expect(isMissedAt(new Date('2026-08-20T12:30:00.000Z'), WINDOW_ENDS, 30)).toBe(false);
  });

  it('is missed one millisecond past the boundary', () => {
    expect(isMissedAt(new Date('2026-08-20T12:00:00.001Z'), WINDOW_ENDS, 0)).toBe(true);
    expect(isMissedAt(new Date('2026-08-20T12:30:00.001Z'), WINDOW_ENDS, 30)).toBe(true);
  });

  it('is not missed before the grace period elapses', () => {
    expect(isMissedAt(new Date('2026-08-20T12:29:59.999Z'), WINDOW_ENDS, 30)).toBe(false);
  });
});

describe('sopLateMissedHandler', () => {
  it('issues exactly one set-based UPDATE', async () => {
    const { ctx, updateMany, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    expect(executeRaw).toHaveBeenCalledOnce();
    // A partially applied sweep must not be observable, so the handler does not
    // pair the raw statement with a second Prisma update.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('never writes LATE — that status belongs to the submit path', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const sql = sweepSql(executeRaw);
    expect(sql).toContain("status = 'MISSED'");
    expect(sql).not.toContain("status = 'LATE'");
  });

  it('only sweeps pre-submission states, and only when nothing was submitted', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const sql = sweepSql(executeRaw);
    expect(sql).toContain("occ.status IN ('SCHEDULED', 'IN_PROGRESS', 'LATE')");
    // The NULL-submission guard — not the status list — is what protects
    // submitted work. A submitted-late occurrence (status LATE, submittedAt set)
    // is awaiting verification and must survive the sweep; a LATE row with no
    // submission was never handed in and is genuinely missed. Dropping this
    // guard would silently rewrite real submissions to MISSED.
    expect(sql).toContain('occ."submittedAt" IS NULL');
  });

  it('applies the grace period with a strict boundary', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const sql = sweepSql(executeRaw);
    expect(sql).toContain('INTERVAL \'1 minute\' * asgn."graceMinutes"');
    expect(sql).toContain('< ');
    expect(sql).not.toContain('<= ');
  });

  it('passes the injected clock through to the statement', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const params = executeRaw.mock.calls[0].slice(1) as unknown[];
    expect(params.every((p) => p instanceof Date)).toBe(true);
    expect((params[0] as Date).toISOString()).toBe('2026-08-20T12:00:00.000Z');
  });

  it('works with an empty payload (uses current time)', async () => {
    const { ctx } = makeContext();
    await expect(sopLateMissedHandler(ctx)).resolves.toBeUndefined();
  });

  it('rejects an unknown payload key (strict zod)', async () => {
    const { ctx } = makeContext({ unknown: true });
    await expect(sopLateMissedHandler(ctx)).rejects.toThrow();
  });
});

import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { adminProcedure, router } from '@/server/trpc';

const opaqueId = z.string().trim().min(1).max(128);
const instant = z.iso.datetime({ offset: true });
const lookupInput = z
  .object({ branchId: opaqueId, entryId: opaqueId, from: instant, to: instant })
  .strict()
  .refine(
    ({ from, to }) => {
      const milliseconds = Date.parse(to) - Date.parse(from);
      return milliseconds > 0 && milliseconds <= 92 * 86_400_000;
    },
    { message: 'Choose a valid period of at most 92 days.' }
  );

type SafeLine = {
  id: string;
  accountCode: string;
  side: 'DEBIT' | 'CREDIT';
  amountMinor: string;
};

export type JournalEntryLookupResult =
  | { status: 'NOT_FOUND' }
  | { status: 'TRUNCATED' }
  | { status: 'INVALID_SOURCE' }
  | {
      status: 'FOUND';
      entry: {
        id: string;
        sourceKind: string;
        sourceId: string;
        currency: string;
        occurredAt: string;
        reversesEntryId: string | null;
        lines: SafeLine[];
        debitMinor: string;
        creditMinor: string;
        differenceMinor: string;
      };
    };

const boundedText = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export const journalEntryLookupRouter = router({
  lookup: adminProcedure.input(lookupInput).query(async ({ ctx, input }) => {
    if (ctx.session.user.role !== 'ADMIN' || !hasModule(ctx.entitlements, 'pharmacy-reports')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Owner financial reports access is required.',
      });
    }
    const subject = subjectFromSession(ctx.session.user);
    for (const action of ['reports:operational', 'reports:financial'] as const) {
      if (
        !(await can(subject, action, undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }))
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Financial report permission is required.',
        });
      }
    }

    const organizationId = ctx.entitlements.organizationId;
    if (!organizationId || organizationId !== ctx.organization?.id) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Organization is outside your report scope.',
      });
    }
    const branch = await ctx.db.pharmacyBranch.findFirst({
      where: { id: input.branchId, organizationId, active: true },
      select: { id: true },
    });
    if (!branch) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
    }

    const source = await ctx.db.financeJournalEntry.findFirst({
      where: {
        id: input.entryId,
        organizationId,
        occurredAt: { gte: new Date(input.from), lt: new Date(input.to) },
        lines: { some: { organizationId, branchId: branch.id } },
      },
      select: {
        id: true,
        sourceKind: true,
        sourceId: true,
        currency: true,
        occurredAt: true,
        reversesEntryId: true,
        lines: {
          where: { organizationId, branchId: branch.id },
          orderBy: { id: 'asc' },
          take: 201,
          select: { id: true, accountCode: true, side: true, amountMinor: true },
        },
      },
    });
    if (!source) return { status: 'NOT_FOUND' } satisfies JournalEntryLookupResult;
    if (source.lines.length === 201)
      return { status: 'TRUNCATED' } satisfies JournalEntryLookupResult;

    const seen = new Set<string>();
    let debit = 0n;
    let credit = 0n;
    const lines: SafeLine[] = [];
    const validHeader =
      boundedText(source.id) &&
      boundedText(source.sourceKind) &&
      boundedText(source.sourceId) &&
      boundedText(source.currency, 16) &&
      (source.reversesEntryId === null || boundedText(source.reversesEntryId));
    if (
      !validHeader ||
      !(source.occurredAt instanceof Date) ||
      !Number.isFinite(source.occurredAt.getTime())
    ) {
      return { status: 'INVALID_SOURCE' } satisfies JournalEntryLookupResult;
    }
    for (const line of source.lines) {
      if (
        !boundedText(line.id) ||
        !boundedText(line.accountCode) ||
        seen.has(line.id) ||
        (line.side !== 'DEBIT' && line.side !== 'CREDIT') ||
        !Number.isInteger(line.amountMinor) ||
        line.amountMinor < 0 ||
        line.amountMinor > 2_147_483_647
      ) {
        return { status: 'INVALID_SOURCE' } satisfies JournalEntryLookupResult;
      }
      seen.add(line.id);
      const amount = BigInt(line.amountMinor);
      if (line.side === 'DEBIT') debit += amount;
      else credit += amount;
      lines.push({ ...line, amountMinor: amount.toString() });
    }
    if (lines.length === 0) return { status: 'INVALID_SOURCE' } satisfies JournalEntryLookupResult;

    return {
      status: 'FOUND',
      entry: {
        id: source.id,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        currency: source.currency,
        occurredAt: source.occurredAt.toISOString(),
        reversesEntryId: source.reversesEntryId,
        lines,
        debitMinor: debit.toString(),
        creditMinor: credit.toString(),
        differenceMinor: (debit - credit).toString(),
      },
    } satisfies JournalEntryLookupResult;
  }),
});

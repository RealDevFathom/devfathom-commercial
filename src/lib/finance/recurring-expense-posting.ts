import type { Prisma, RecurringExpense } from '@/generated/prisma/client';
import { workspaceDateRange, workspaceToday } from '@/lib/timezone';
import {
  billingCalendarDate,
  recurringExpenseSchedule,
  recurringInterval,
} from './recurring-expense';

export async function postDueRecurringExpenses(
  tx: Prisma.TransactionClient,
  organizationId: string,
  zone: string | null | undefined,
  now: Date
) {
  const today = workspaceToday(zone, now);
  // Include both encodings of today: a UTC date label and a workspace instant.
  const end = new Date(
    Math.max(workspaceDateRange(today, today, zone).to.getTime(), Date.parse(today) + 86_400_000)
  );
  const expenses = await tx.$queryRaw<RecurringExpense[]>`
    SELECT * FROM recurring_expenses
    WHERE "organizationId" = ${organizationId} AND active AND "nextDueDate" < ${end}
    ORDER BY id FOR UPDATE SKIP LOCKED
  `;
  const unsupported: Array<{ id: string; name: string; interval: string }> = [];
  let posted = 0;
  const details: Array<{ id: string; name: string; cycles: number }> = [];
  for (const exp of expenses) {
    let due = exp.nextDueDate;
    if (billingCalendarDate(due, zone) > today) continue;
    const interval = recurringInterval.safeParse(exp.interval.toLowerCase());
    if (!interval.success) {
      unsupported.push({ id: exp.id, name: exp.name, interval: exp.interval });
      continue;
    }
    const advance = recurringExpenseSchedule(due, interval.data, zone, exp.billingDay);
    const dates: Date[] = [];
    for (let i = 0; i < 36; i++) {
      const day = billingCalendarDate(due, zone);
      if (day > today) break;
      dates.push(new Date(day));
      due = advance(due);
    }
    if (!dates.length) continue;
    const claims = await tx.recurringExpensePosting.createManyAndReturn({
      data: dates.map((dueDate) => ({ organizationId, recurringExpenseId: exp.id, dueDate })),
      skipDuplicates: true,
      select: { dueDate: true },
    });
    if (claims.length) {
      await tx.transaction.createMany({
        data: claims.map(({ dueDate }) => {
          const day = dueDate.toISOString().slice(0, 10);
          return {
            type: 'EXPENSE',
            organizationId,
            amount: exp.amount,
            currency: exp.currency,
            category: exp.category,
            description: `${exp.name}${exp.vendorName ? ` — ${exp.vendorName}` : ''} (recurring)`,
            date: workspaceDateRange(day, day, zone).from,
          };
        }),
      });
      posted += claims.length;
      details.push({ id: exp.id, name: exp.name, cycles: claims.length });
    }
    await tx.recurringExpense.update({ where: { id: exp.id }, data: { nextDueDate: due } });
  }
  return { posted, details, unsupported };
}

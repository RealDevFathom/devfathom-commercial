'use server';

import { revalidatePath } from 'next/cache';
import { TRPCError } from '@trpc/server';
import { recordAudit } from '@/server/audit';
import {
  bindOfficeScope,
  canPerformOfficeAction,
  UniversityAccessError,
  withUniversityStaff,
} from '@/lib/university/access';

import { universityOffices } from '@/lib/university/offices';

export type OfficeResult = {
  ok: boolean;
  message: string;
  result?: string;
  download?: { name: string; content: string; mimeType: string };
};

export async function performOfficeAction(
  officeKey: string,
  actionKey: string,
  _previous: OfficeResult,
  form: FormData
): Promise<OfficeResult> {
  const office = universityOffices.get(officeKey);
  const action = office?.actions.find((item) => item.key === actionKey);
  if (!office || !action) return { ok: false, message: 'Unknown university operation.' };
  try {
    const result = await withUniversityStaff(async (ctx) => {
      if (!canPerformOfficeAction(ctx, office, action)) throw new UniversityAccessError();
      await bindOfficeScope(ctx, office);
      if (action.confirmation && form.get('confirmed') !== 'yes')
        throw new Error('Confirm this operation before continuing.');
      const input: Record<string, string> = {};
      for (const field of action.fields) {
        const value = form.get(field.name);
        if (value !== null && typeof value !== 'string') throw new Error('Invalid field value.');
        const text =
          officeKey === 'imports' && field.name === 'manifest'
            ? (value ?? '')
            : (value ?? '').trim();
        if (field.required && !text) throw new Error(`Enter ${field.label.toLowerCase()}.`);
        if (text && field.options && !field.options.includes(text))
          throw new Error(`Choose a valid ${field.label.toLowerCase()}.`);
        if (text.length > (field.type === 'textarea' ? 250_000 : 2_000))
          throw new Error(`${field.label} exceeds its size limit.`);
        input[field.name] = text;
      }
      const value = await action.run(ctx, input);
      await recordAudit(
        {
          organizationId: ctx.organizationId,
          actorType: 'USER',
          actorId: ctx.userId,
          source: 'SYSTEM',
          category: 'university',
          action: `university.${officeKey}.${actionKey}`,
          operation: 'EXECUTE',
          path: `/university/${officeKey}`,
          outcome: 'SUCCESS',
        },
        ctx.db
      );
      if (value && typeof value === 'object') {
        const exportFile = value as Record<string, unknown>;
        const name = exportFile.fileName ?? exportFile.filename;
        const content = exportFile.content ?? exportFile.csv;
        if (typeof name === 'string' && typeof content === 'string' && name.endsWith('.csv')) {
          return { download: { name, content, mimeType: 'text/csv;charset=utf-8' } };
        }
      }
      return {
        result: JSON.stringify(
          value,
          (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry),
          2
        ),
      };
    });
    revalidatePath(`/university/${officeKey}`);
    return { ok: true, message: 'Completed.', ...result };
  } catch (error) {
    const message =
      error instanceof Error &&
      (error.constructor === Error ||
        error instanceof UniversityAccessError ||
        (error instanceof TRPCError &&
          ['BAD_REQUEST', 'CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code))) &&
      error.message.length <= 240
        ? error.message
        : 'The operation could not be completed. Check the references and try again.';
    return { ok: false, message };
  }
}

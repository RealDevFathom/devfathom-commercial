'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  consentFeeDelegation,
  DelegationError,
  revokeFeeDelegation,
} from '@/lib/university/delegation';
import { PortalError } from '@/lib/university/portal';
import { withDelegationSession } from './access';

export async function saveDelegation(
  operation: 'consent' | 'revoke',
  _state: { ok: boolean; message: string },
  data: FormData
) {
  try {
    await withDelegationSession(async (ctx) => {
      if (operation === 'revoke')
        return revokeFeeDelegation(ctx, z.string().min(1).max(150).parse(data.get('id')));
      if (operation !== 'consent') throw new DelegationError('Unknown delegation action.');
      return consentFeeDelegation(ctx, {
        email: data.get('email'),
        relationship: data.get('relationship'),
        permission: data.get('permission'),
        challanReference: data.get('challanReference') ?? undefined,
        endsOn: data.get('endsOn'),
        consent: data.get('consent'),
      });
    });
    revalidatePath('/student/delegations');
    return {
      ok: true,
      message:
        operation === 'revoke'
          ? 'Access revoked. رسائی ختم کر دی گئی۔'
          : 'Consent recorded. رضامندی محفوظ ہو گئی۔',
    };
  } catch (error) {
    if (error instanceof z.ZodError)
      return {
        ok: false,
        message:
          'Complete the form and confirm consent. تمام خانے مکمل کریں اور رضامندی کی تصدیق کریں۔',
      };
    if (error instanceof DelegationError || error instanceof PortalError)
      return { ok: false, message: error.message };
    throw error;
  }
}

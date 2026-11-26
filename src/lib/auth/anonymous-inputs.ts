import { z } from 'zod';

import { emailLookupSchema } from '@/lib/email-address';
import { passwordSchema } from '@/lib/password-policy';

export const anonymousTokenInput = z.object({ token: z.string().min(1) });

export const invitationAcceptInput = z.object({
  token: z.string().min(1),
  password: passwordSchema,
  phone: z.string().trim().min(1, 'Phone number is required'),
  bio: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

export const passwordResetRequestInput = z.object({ email: emailLookupSchema });

export const passwordResetInput = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

const supplierId = z.string().trim().min(1).max(200);

export const supplierLinkGetInput = z.object({ token: supplierId }).strict();

export const supplierLinkSubmitInput = z
  .object({
    token: supplierId,
    kind: z.enum([
      'ACKNOWLEDGEMENT',
      'REJECTION',
      'PARTIAL_ACCEPTANCE',
      'ETA',
      'SUBSTITUTION_PROPOSAL',
    ]),
    idempotencyKey: supplierId,
    payload: z.record(z.string(), z.unknown()),
    supersedesId: supplierId.optional(),
  })
  .strict();

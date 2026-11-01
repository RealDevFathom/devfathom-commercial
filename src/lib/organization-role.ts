import { z } from 'zod';

export const organizationRolePermissionsSchema = z
  .array(
    z.object({
      capability: z.string().trim().min(1).max(150),
      effect: z.enum(['ALLOW', 'DENY']),
    })
  )
  .max(250)
  .superRefine((permissions, ctx) => {
    const capabilities = new Set<string>();
    permissions.forEach((permission, index) => {
      if (capabilities.has(permission.capability)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each capability may only appear once.',
          path: [index, 'capability'],
        });
      }
      capabilities.add(permission.capability);
    });
  });

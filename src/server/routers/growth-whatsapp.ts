import { randomBytes } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { CustomerNotFound, RecordedOptOut, setCustomerOptIn } from '@/lib/growth/consent';
import {
  DEFAULT_TEMPLATE_LANGUAGE,
  ensureDefaultTemplates,
  saveTemplateBody,
  TEMPLATE_KEYS,
  MissingStop,
  UnknownTemplateVariable,
} from '@/lib/growth/templates';
import { InvalidWhatsAppPhone, normalizeWhatsAppE164 } from '@/lib/growth/whatsapp/phone';
import { growthStore } from '@/lib/growth/whatsapp/store';
import { sealWebhookSecret } from '@/lib/growth/whatsapp/webhook-secret';
import { annotateAudit } from '@/server/audit';
import {
  adminProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '@/server/trpc';

function assertGrowthEnabled(ctx: TRPCContext) {
  if (!hasModule(ctx.entitlements, 'growth_ai')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The growth_ai module is not enabled for this organization.',
    });
  }
}

function organizationIdFrom(ctx: TRPCContext): string {
  const organizationId = ctx.session?.user?.organizationId;
  if (!organizationId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  }
  return organizationId;
}

function fail(error: unknown): never {
  if (
    error instanceof InvalidWhatsAppPhone ||
    error instanceof MissingStop ||
    error instanceof UnknownTemplateVariable
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof CustomerNotFound) {
    throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  if (error instanceof RecordedOptOut) {
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  }
  throw error;
}

const manage = capabilityProcedure('growth.manage');
const member = protectedProcedure;

async function assertCounterOperator(ctx: TRPCContext) {
  const user = ctx.session?.user;
  if (!user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'You must be logged in.' });
  }
  const subject = subjectFromSession(user);
  const options = { db: ctx.db as never };
  const allowed =
    (await can(subject, 'pharmacy.counter', undefined, options)) ||
    (await can(subject, 'pos:operate', undefined, options));
  if (!allowed) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
}

/** Pharmacy ids and channel ids are distinct. Resolve only within this session's tenant. */
async function counterCustomer(
  ctx: TRPCContext,
  customerId: string,
  create: boolean,
  phone?: string
) {
  const organizationId = organizationIdFrom(ctx);
  const store = growthStore(ctx.db);
  const direct = await store.customer(organizationId, customerId);
  if (direct) return direct;
  const pharmacy = await ctx.db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId },
    select: {
      displayName: true,
      whatsappOptIn: true,
      whatsappOptInChangedAt: true,
      patient: { select: { phone: true } },
    },
  });
  if (!pharmacy) throw new CustomerNotFound();
  const normalized =
    normalizeWhatsAppE164(pharmacy.patient.phone ?? '') ?? normalizeWhatsAppE164(phone ?? '');
  if (!normalized) {
    if (create) throw new InvalidWhatsAppPhone();
    return null;
  }
  const existing = await store.customerByPhone(organizationId, normalized);
  if (existing) return existing;
  if (!create)
    return {
      id: customerId,
      organizationId,
      displayName: pharmacy.displayName,
      whatsappE164: normalized,
      whatsappOptIn: pharmacy.whatsappOptIn === true,
      whatsappOptInAt: pharmacy.whatsappOptIn === true ? pharmacy.whatsappOptInChangedAt : null,
      whatsappOptOutAt: pharmacy.whatsappOptIn === false ? pharmacy.whatsappOptInChangedAt : null,
    };
  const saved = await ctx.db.growthWaCustomer.upsert({
    where: { organizationId_whatsappE164: { organizationId, whatsappE164: normalized } },
    update: {},
    create: {
      // New channel rows keep the counter id, including customers without a patient phone.
      id: customerId,
      organizationId,
      displayName: pharmacy.displayName,
      whatsappE164: normalized,
      whatsappOptIn: pharmacy.whatsappOptIn === true,
      whatsappOptInAt: pharmacy.whatsappOptIn === true ? pharmacy.whatsappOptInChangedAt : null,
      whatsappOptOutAt: pharmacy.whatsappOptIn === false ? pharmacy.whatsappOptInChangedAt : null,
    },
  });
  return saved;
}

export const growthWhatsAppRouter = router({
  templates: router({
    list: manage.query(async ({ ctx }) => {
      assertGrowthEnabled(ctx);
      const organizationId = organizationIdFrom(ctx);
      return ensureDefaultTemplates(growthStore(ctx.db), organizationId);
    }),
    update: manage
      .input(
        z
          .object({
            key: z.enum(TEMPLATE_KEYS),
            language: z.string().trim().min(2).max(16).default(DEFAULT_TEMPLATE_LANGUAGE),
            body: z.string().trim().min(1).max(2000),
          })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        assertGrowthEnabled(ctx);
        try {
          return await saveTemplateBody(growthStore(ctx.db), {
            organizationId: organizationIdFrom(ctx),
            key: input.key,
            language: input.language,
            body: input.body,
          });
        } catch (error) {
          fail(error);
        }
      }),
  }),
  customers: router({
    consent: member
      .input(z.object({ customerId: z.string().trim().min(1).max(200) }).strict())
      .query(async ({ ctx, input }) => {
        assertGrowthEnabled(ctx);
        await assertCounterOperator(ctx);
        try {
          const customer = await counterCustomer(ctx, input.customerId, false);
          return {
            whatsappOptIn: customer?.whatsappOptIn ?? false,
            whatsappE164: customer?.whatsappE164 ?? null,
          };
        } catch (error) {
          fail(error);
        }
      }),
    /** POS consent. Only till roles (pharmacy.counter or pos:operate) may record it. */
    setOptIn: member
      .input(
        z
          .object({
            customerId: z.string().trim().min(1).max(200),
            whatsappOptIn: z.boolean(),
            phone: z.string().trim().max(32).optional(),
          })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        assertGrowthEnabled(ctx);
        await assertCounterOperator(ctx);
        try {
          const customer = await counterCustomer(ctx, input.customerId, true, input.phone);
          if (!customer) throw new CustomerNotFound();
          return await setCustomerOptIn(growthStore(ctx.db), {
            organizationId: organizationIdFrom(ctx),
            customerId: customer.id,
            whatsappOptIn: input.whatsappOptIn,
            phone: input.phone,
            now: new Date(),
          });
        } catch (error) {
          fail(error);
        }
      }),
  }),
  whatsapp: router({
    /** Generates 32 random bytes, returns them once, and stores only the hash and ciphertext. */
    rotateWebhookSecret: adminProcedure.mutation(async ({ ctx }) => {
      assertGrowthEnabled(ctx);
      const organizationId = organizationIdFrom(ctx);
      const secret = randomBytes(32).toString('base64url');
      await growthStore(ctx.db).saveWebhookSecret(organizationId, sealWebhookSecret(secret));
      annotateAudit(ctx, {
        action: 'growth.whatsapp.rotateWebhookSecret',
        targetType: 'GrowthWaSettings',
        targetId: organizationId,
        metadata: { rotated: true },
        skipInput: true,
      });
      return { secret };
    }),
  }),
});

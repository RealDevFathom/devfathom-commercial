import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import {
  INVITATION_GENERIC_MESSAGE,
  RESET_GENERIC_MESSAGE,
  SUPPLIER_LINK_GENERIC_MESSAGE,
} from '@/lib/auth/anonymous-access';
import {
  anonymousTokenInput,
  invitationAcceptInput,
  passwordResetInput,
  passwordResetRequestInput,
  supplierLinkGetInput,
  supplierLinkSubmitInput,
  supplierLinkUploadInput,
} from '@/lib/auth/anonymous-inputs';
import { formatValidationError } from '@/lib/validation-error';

/**
 * The answers an anonymous request gets when it could not be routed to a tenant
 * at all — an unrecognised or unknown token, or a `passwordReset.request` on a
 * shared/unknown host.
 *
 * Why a router rather than a hand-built Response: these replies have to be
 * INDISTINGUISHABLE from the ones the real routers produce, and "indistinguishable"
 * includes the HTTP status, the JSON-RPC error code, the superjson envelope, and
 * the batched-vs-single response shape. Serving them through `fetchRequestHandler`
 * with the same transformer means tRPC produces all of that, so the two paths
 * cannot drift apart as tRPC changes. The procedure shapes mirror the real ones
 * exactly — same paths, same query/mutation kinds, and the same shared input
 * schemas. Validation must happen on both paths so malformed input cannot reveal
 * whether the hostname was routed to a tenant.
 *
 * There is no context and no database handle here. Nothing in this router can
 * touch tenant data, which is the point — it runs precisely when no tenant has
 * been established.
 */
/**
 * The same `errorFormatter` `@/server/trpc` installs, less its production
 * withholding of an unexpected failure's message (this router throws only
 * deliberate refusals), repeated rather than imported: this router is
 * deliberately standalone — no context, no database handle — and importing the
 * tenant-bound instance would give it both. It is repeated because the error
 * SHAPE is part of "indistinguishable"; a response carrying `data.validation`
 * and one omitting it tell an anonymous caller which of the two paths served
 * them. `anonymous-fallback.test.ts` pins exactly that much and no more: it
 * raises the same refusal through each tRPC INSTANCE — the real one against a
 * focused stand-in router — and compares the served bodies, so a formatter that
 * stopped matching is caught here. The test also compares malformed input
 * against the production anonymous routers so their validation behavior cannot
 * drift apart.
 */
const t = initTRPC.create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const validation = error.code === 'BAD_REQUEST' ? formatValidationError(error.cause) : null;
    // As in `@/server/trpc`: never publish the server stack, which tRPC attaches
    // outside production, so both instances serve the same shape.
    const data = { ...shape.data, validation: validation?.fields ?? null };
    delete data.stack;
    return {
      ...shape,
      message: validation?.message ?? shape.message,
      data,
    };
  },
});

const unroutableInvitation = () => {
  throw new TRPCError({ code: 'NOT_FOUND', message: INVITATION_GENERIC_MESSAGE });
};

const unroutableReset = () => {
  throw new TRPCError({ code: 'BAD_REQUEST', message: RESET_GENERIC_MESSAGE });
};
const unroutableSupplierLink = () => {
  throw new TRPCError({ code: 'NOT_FOUND', message: SUPPLIER_LINK_GENERIC_MESSAGE });
};

export const anonymousFallbackRouter = t.router({
  invitations: t.router({
    get: t.procedure.input(anonymousTokenInput).query(unroutableInvitation),
    accept: t.procedure.input(invitationAcceptInput).mutation(unroutableInvitation),
  }),
  passwordReset: t.router({
    // Identical to a successful request for an address that has no account: the
    // endpoint never reveals whether anything was sent.
    request: t.procedure
      .input(passwordResetRequestInput)
      .mutation(() => ({ success: true as const })),
    validate: t.procedure.input(anonymousTokenInput).query(() => ({ valid: false as const })),
    reset: t.procedure.input(passwordResetInput).mutation(unroutableReset),
  }),
  pharmacySupplierLinks: t.router({
    get: t.procedure.input(supplierLinkGetInput).query(unroutableSupplierLink),
    submit: t.procedure.input(supplierLinkSubmitInput).mutation(unroutableSupplierLink),
    uploadDocument: t.procedure.input(supplierLinkUploadInput).mutation(unroutableSupplierLink),
  }),
});

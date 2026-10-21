import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import {
  INVITATION_GENERIC_MESSAGE,
  RESET_GENERIC_MESSAGE,
  SUPPLIER_LINK_GENERIC_MESSAGE,
} from '@/lib/auth/anonymous-access';
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
 * exactly — same paths, same query/mutation kinds.
 *
 * No `.input()` schemas: these resolvers ignore their input, and validating it
 * would answer a malformed payload differently from a well-formed one, which is
 * itself a distinguishable outcome.
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
 * stand-in router that, like this one, declares no `.input()` schemas — and
 * compares the served bodies, so a formatter that stopped matching is caught
 * here. It proves nothing about the production `invitations` and
 * `passwordReset` routers, which do declare `.input()` schemas this router omits;
 * those router-level differences are not covered by that test.
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
    get: t.procedure.query(unroutableInvitation),
    accept: t.procedure.mutation(unroutableInvitation),
  }),
  passwordReset: t.router({
    // Identical to a successful request for an address that has no account: the
    // endpoint never reveals whether anything was sent.
    request: t.procedure.mutation(() => ({ success: true as const })),
    validate: t.procedure.query(() => ({ valid: false as const })),
    reset: t.procedure.mutation(unroutableReset),
  }),
  pharmacySupplierLinks: t.router({
    get: t.procedure.query(unroutableSupplierLink),
    submit: t.procedure.mutation(unroutableSupplierLink),
    uploadDocument: t.procedure.mutation(unroutableSupplierLink),
  }),
});

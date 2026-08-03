import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import { INVITATION_GENERIC_MESSAGE, RESET_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';

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
const t = initTRPC.create({ transformer: superjson });

const unroutableInvitation = () => {
  throw new TRPCError({ code: 'NOT_FOUND', message: INVITATION_GENERIC_MESSAGE });
};

const unroutableReset = () => {
  throw new TRPCError({ code: 'BAD_REQUEST', message: RESET_GENERIC_MESSAGE });
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
});

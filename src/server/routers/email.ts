import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import type { Session } from 'next-auth';
import { router, protectedProcedure } from '../trpc';
import { refuseSupportSession } from '@/lib/tenancy/support-session-rule';
import { adapterForMailbox } from '@/lib/email/adapter';
import { syncMailbox } from '@/lib/email/sync';
import { buildConsentUrl, exchangeCode, isProviderConfigured } from '@/lib/email/oauth';
import { encryptToken, isEmailCryptoConfigured } from '@/lib/email/crypto';

/**
 * Unified-inbox router over the Mailbox abstraction. Provider specifics live
 * entirely in the adapter layer — this router never special-cases Gmail vs
 * Outlook, so a future HOSTED adapter needs no change here.
 *
 * SECURITY: every procedure that touches a mailbox or message re-verifies it
 * belongs to ctx.session.user.id. A user can NEVER reach another user's mailbox
 * or messages. Encrypted credentials are never selected back to the client.
 */

const providerInput = z.enum(['GMAIL', 'OUTLOOK']);

// --- OAuth connect state (F11 / DEV-833) --------------------------------------
//
// The connect `state` is persisted (as a hash) bound to the provider, user,
// tenant and sign-in session that started it, and consumed exactly once before
// any code exchange. An authorization code delivered to anyone else — another
// user, another workspace, another sign-in — is refused before a mailbox row is
// written, so a forged callback cannot attach someone else's mailbox.

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const INVALID_OAUTH_STATE =
  'This connection link is invalid or has expired. Start the connection again from Email.';

function hashOAuthState(state: string) {
  return createHash('sha256').update(state).digest('hex');
}

/** A stable fingerprint of the signed-in session this connect belongs to. */
function oauthSessionBinding(ctx: {
  session: Pick<Session, 'user'>;
  organization: { id: string } | null;
}) {
  const user = ctx.session.user;
  const organizationId = ctx.organization?.id ?? user.organizationId;
  return createHash('sha256')
    .update(
      [
        organizationId,
        user.id,
        user.supportSessionId ?? '',
        user.passwordAuthenticatedAt ?? '',
      ].join('|')
    )
    .digest('hex');
}

function sameBinding(stored: string, current: string) {
  const a = Buffer.from(stored);
  const b = Buffer.from(current);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- ownership guards (the IDOR keystone for email) -------------------------

async function ownedMailbox(db: PrismaClient, userId: string, mailboxId: string) {
  const mb = await db.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mb) throw new TRPCError({ code: 'NOT_FOUND', message: 'Mailbox not found' });
  if (mb.userId !== userId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this mailbox' });
  }
  return mb;
}

async function ownedMessage(db: PrismaClient, userId: string, messageId: string) {
  const msg = await db.emailMessage.findUnique({
    where: { id: messageId },
    include: { mailbox: true },
  });
  if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
  if (msg.mailbox.userId !== userId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this message' });
  }
  return msg;
}

export const emailRouter = router({
  // Which providers are configured server-side (so the UI can enable buttons).
  providers: protectedProcedure.query(() => ({
    GMAIL: isProviderConfigured('GMAIL'),
    OUTLOOK: isProviderConfigured('OUTLOOK'),
  })),

  // Step 1 of connect: hand back a consent URL for the popup. No user config.
  connectStart: protectedProcedure
    .meta(refuseSupportSession)
    .input(z.object({ provider: providerInput }))
    .mutation(async ({ ctx, input }) => {
      const state = `${input.provider}:${randomBytes(32).toString('base64url')}`;
      let url: string;
      try {
        url = buildConsentUrl(input.provider, state);
      } catch (e) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: (e as Error).message,
        });
      }
      // Expired connect states can never be honored again; sweep them so the
      // table does not grow without bound. RLS keeps this inside the tenant.
      await ctx.db.mailboxOAuthState.deleteMany({
        where: {
          organizationId: ctx.organization?.id ?? ctx.session.user.organizationId,
          expiresAt: { lt: new Date() },
        },
      });
      await ctx.db.mailboxOAuthState.create({
        data: {
          userId: ctx.session.user.id,
          provider: input.provider,
          stateHash: hashOAuthState(state),
          sessionBinding: oauthSessionBinding(ctx),
          expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
        },
      });
      return { url, state };
    }),

  // Step 2: exchange the code, store an encrypted refresh token, kick off sync.
  connectCallback: protectedProcedure
    .meta(refuseSupportSession)
    .input(
      z.object({
        provider: providerInput,
        code: z.string().min(1),
        state: z.string().min(1).max(512),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!isEmailCryptoConfigured()) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Email credential encryption is not configured on the server.',
        });
      }

      // F11: the state must be one this user, tenant and session started for
      // this provider, unexpired and unused. Checked and consumed before the
      // code is exchanged or any mailbox is written.
      const pending = await ctx.db.mailboxOAuthState.findFirst({
        where: {
          stateHash: hashOAuthState(input.state),
          userId: ctx.session.user.id,
          provider: input.provider,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!pending || !sameBinding(pending.sessionBinding, oauthSessionBinding(ctx))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: INVALID_OAUTH_STATE });
      }
      const consumed = await ctx.db.mailboxOAuthState.updateMany({
        where: { id: pending.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: INVALID_OAUTH_STATE });
      }

      let exchanged;
      try {
        exchanged = await exchangeCode(input.provider, input.code);
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message });
      }

      const credentials = encryptToken(exchanged.refreshToken);
      const userId = ctx.session.user.id;

      // Reconnecting the same address just refreshes its credentials.
      const existing = await ctx.db.mailbox.findFirst({
        where: { userId, emailAddress: exchanged.emailAddress, type: input.provider },
      });
      const mailbox = existing
        ? await ctx.db.mailbox.update({
            where: { id: existing.id },
            data: { credentials, status: 'active' },
          })
        : await ctx.db.mailbox.create({
            data: {
              userId,
              type: input.provider,
              emailAddress: exchanged.emailAddress,
              credentials,
              status: 'active',
            },
          });

      // Pull the first page now so the inbox renders immediately. Tolerate a
      // sync hiccup — the account is connected and the UI can refresh.
      try {
        await syncMailbox(ctx.db, mailbox, { limit: 30 });
      } catch {
        // leave lastSyncedAt null; surfaced as "no messages yet, try refresh"
      }

      return { mailboxId: mailbox.id, emailAddress: mailbox.emailAddress };
    }),

  // All of the current user's connected accounts (never returns credentials).
  listMailboxes: protectedProcedure.query(({ ctx }) =>
    ctx.db.mailbox.findMany({
      where: { userId: ctx.session.user.id },
      select: {
        id: true,
        type: true,
        emailAddress: true,
        displayName: true,
        status: true,
        lastSyncedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })
  ),

  // Unified message list. mailboxId omitted = across ALL of the user's mailboxes.
  listMessages: protectedProcedure
    .input(z.object({ mailboxId: z.string().optional(), folder: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      let mailboxIds: string[];
      if (input?.mailboxId) {
        await ownedMailbox(ctx.db, userId, input.mailboxId);
        mailboxIds = [input.mailboxId];
      } else {
        const mbs = await ctx.db.mailbox.findMany({
          where: { userId },
          select: { id: true },
        });
        mailboxIds = mbs.map((m) => m.id);
      }
      if (mailboxIds.length === 0) return [];

      return ctx.db.emailMessage.findMany({
        where: { mailboxId: { in: mailboxIds } },
        orderBy: { sentAt: 'desc' },
        take: 100,
        select: {
          id: true,
          mailboxId: true,
          fromAddr: true,
          subject: true,
          snippet: true,
          isRead: true,
          hasAttachments: true,
          sentAt: true,
          threadId: true,
          mailbox: { select: { emailAddress: true, type: true } },
        },
      });
    }),

  // Full message; lazily backfills + caches the body on first open.
  getMessage: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const msg = await ownedMessage(ctx.db, ctx.session.user.id, input.id);

      let bodyHtml = msg.bodyHtml;
      let bodyText = msg.bodyText;
      if (bodyHtml == null && bodyText == null) {
        try {
          const full = await adapterForMailbox(msg.mailbox).getMessage(msg.providerMessageId);
          if (full && (full.bodyHtml || full.bodyText)) {
            bodyHtml = full.bodyHtml;
            bodyText = full.bodyText;
            await ctx.db.emailMessage.update({
              where: { id: msg.id },
              data: { bodyHtml, bodyText },
            });
          }
        } catch {
          // fall back to snippet-only render
        }
      }

      return {
        id: msg.id,
        mailboxId: msg.mailboxId,
        fromAddr: msg.fromAddr,
        toAddrs: msg.toAddrs,
        ccAddrs: msg.ccAddrs,
        subject: msg.subject,
        snippet: msg.snippet,
        bodyHtml,
        bodyText,
        isRead: msg.isRead,
        hasAttachments: msg.hasAttachments,
        sentAt: msg.sentAt,
        mailbox: { emailAddress: msg.mailbox.emailAddress, type: msg.mailbox.type },
      };
    }),

  // Send from a specific connected account.
  sendMessage: protectedProcedure
    .input(
      z.object({
        mailboxId: z.string(),
        to: z.array(z.string().min(3)).min(1),
        cc: z.array(z.string().min(3)).optional(),
        subject: z.string(),
        html: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const mailbox = await ownedMailbox(ctx.db, ctx.session.user.id, input.mailboxId);
      try {
        await adapterForMailbox(mailbox).sendMessage({
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          html: input.html,
        });
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message });
      }
      return { success: true };
    }),

  // Local read-state (minimal scopes — no provider write).
  markRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const msg = await ownedMessage(ctx.db, ctx.session.user.id, input.id);
      await ctx.db.emailMessage.update({ where: { id: msg.id }, data: { isRead: true } });
      return { success: true };
    }),

  // On-demand refresh of one or all of the user's mailboxes.
  refresh: protectedProcedure
    .input(z.object({ mailboxId: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      if (input?.mailboxId) await ownedMailbox(ctx.db, userId, input.mailboxId);
      const mbs = await ctx.db.mailbox.findMany({
        where: input?.mailboxId ? { id: input.mailboxId, userId } : { userId },
        select: { id: true, type: true, credentials: true, emailAddress: true },
      });
      let synced = 0;
      for (const mb of mbs) {
        try {
          synced += await syncMailbox(ctx.db, mb, { limit: 30 });
        } catch {
          // skip a failing mailbox; others still refresh
        }
      }
      return { synced };
    }),

  // One-tap disconnect — cascade removes its synced messages.
  disconnect: protectedProcedure
    .meta(refuseSupportSession)
    .input(z.object({ mailboxId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ownedMailbox(ctx.db, ctx.session.user.id, input.mailboxId);
      await ctx.db.mailbox.delete({ where: { id: input.mailboxId } });
      return { success: true };
    }),
});

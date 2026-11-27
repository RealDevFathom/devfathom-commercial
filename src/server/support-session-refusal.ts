import {
  SUPPORT_SESSION_REFUSED_MESSAGE,
  supportOperatorIdentity,
  type SupportSessionCarrier,
} from '@/lib/tenancy/support-session-rule';
import { type AuditSourceT, ipFromHeaders, recordAudit } from '@/server/audit';

type RefusedActor = SupportSessionCarrier & {
  organizationId: string;
  user: { id?: string; name?: string | null; email?: string | null; role?: string | null };
};

/**
 * DEV-1053: the audit entry for a support-session refusal outside tRPC (a REST route, an
 * assistant tool). Same shape as the central tRPC rule writes: a FAILURE naming the action,
 * the member the session acts as, and the platform operator behind it. Never the request body.
 */
export function recordSupportSessionRefusal(args: {
  actor: RefusedActor;
  source: Extract<AuditSourceT, 'REST_API' | 'SYSTEM'>;
  category: string;
  action: string;
  request?: Request;
  metadata?: Record<string, unknown>;
}): void | Promise<void> {
  const { actor, request } = args;
  const operator = supportOperatorIdentity({
    support: actor.support,
    session: actor.session ?? { user: { id: actor.user.id, isSupportSession: true } },
  });
  return recordAudit({
    organizationId: actor.organizationId,
    actorType: 'USER',
    actorId: actor.user.id ?? null,
    actorName: actor.user.name ?? null,
    actorEmail: actor.user.email ?? null,
    actorRole: actor.user.role ?? null,
    source: args.source,
    category: args.category,
    operation: 'OTHER',
    action: args.action,
    description: 'Refused: a support session may not create or change access.',
    metadata: {
      ...(args.metadata ?? {}),
      supportSessionRefused: true,
      supportSessionId: operator?.supportSessionId ?? null,
      platformUserId: operator?.platformUserId ?? null,
      actingAsTenantUserId: actor.user.id ?? null,
    },
    ...(request
      ? {
          ip: ipFromHeaders(request.headers),
          userAgent: request.headers.get('user-agent'),
          httpMethod: request.method.toUpperCase(),
          path: new URL(request.url).pathname,
          statusCode: 403,
        }
      : {}),
    outcome: 'FAILURE',
    errorCode: 'FORBIDDEN',
    errorMessage: SUPPORT_SESSION_REFUSED_MESSAGE,
  });
}

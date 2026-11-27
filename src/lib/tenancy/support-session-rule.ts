/**
 * DEV-1053: what a platform support session may never do.
 *
 * A support session acts inside a business as one of its members for a short, audited
 * window. Anything that creates or changes a credential, an identity or a privilege would
 * outlive that window, so it is refused for every support session, whoever it acts as:
 * members and their status; roles, permissions and sub-roles; passwords, PINs, two-step
 * verification and authenticators; API tokens, SCIM tokens and SSO connections; webhook and
 * integration secrets; device enrolment and device credentials; whole-business data export.
 *
 * A member's connected mailbox is under the same rule, reads included: it receives the
 * member's sign-in mail, so a session that could read it could reset the member's password
 * and keep the account. For the same reason a support session may neither start nor
 * complete a password reset.
 *
 * One rule, three surfaces: tRPC procedures carry `.meta(refuseSupportSession)` and are
 * refused by the central middleware in `src/server/trpc.ts`; REST routes answer with
 * `SUPPORT_SESSION_REFUSED_MESSAGE` and record the refusal with `recordSupportSessionRefusal`
 * (`src/server/support-session-refusal.ts`); the assistant refuses the tools named in
 * `SUPPORT_REFUSED_ASSISTANT_TOOLS`. Every refusal is audited with the operator's identity.
 */

/** The one message every surface gives. No internals, no hint of what would have run. */
export const SUPPORT_SESSION_REFUSED_MESSAGE =
  'A support session cannot do this. It would create or change sign-in details, staff access, a device or a key, or export the whole business. Ask the business owner to do it from their own account.';

/** The `.meta()` value that puts a procedure under the rule. */
export const refuseSupportSession = { supportSession: 'refuse' } as const;

type SupportSessionUser = {
  id?: string;
  isSupportSession?: boolean;
  supportSessionId?: string;
  platformUserId?: string;
};

export type SupportSessionCarrier = {
  support?: { supportSessionId: string; platformUserId: string } | null;
  session?: { user?: SupportSessionUser | null } | null;
};

/** True for a support session, whichever of the two places says so. */
export function isSupportSessionActor(carrier: SupportSessionCarrier): boolean {
  return Boolean(carrier.support || carrier.session?.user?.isSupportSession);
}

/** Who the operator is, for the audit entry. Null when this is not a support session. */
export function supportOperatorIdentity(carrier: SupportSessionCarrier): {
  supportSessionId: string | null;
  platformUserId: string | null;
  actingAsTenantUserId: string | null;
} | null {
  if (!isSupportSessionActor(carrier)) return null;
  const user = carrier.session?.user;
  return {
    supportSessionId: carrier.support?.supportSessionId ?? user?.supportSessionId ?? null,
    platformUserId: carrier.support?.platformUserId ?? user?.platformUserId ?? null,
    actingAsTenantUserId: user?.id ?? null,
  };
}

/**
 * The notice every administrator gets when support access starts. It is the owner's record
 * that an operator was inside the business, so a support session may not mark it read.
 */
export const SUPPORT_SESSION_STARTED_NOTIFICATION_TYPE = 'support_session_started';

/** What a support session is told when it tries to clear that notice. */
export const SUPPORT_NOTICE_REFUSED_MESSAGE =
  'A support session cannot mark the support access notice as read. It stays for the business owner.';

/**
 * Assistant tools that reach an action under the rule. Each mirrors a refused procedure:
 * `team.inviteMember`, `team.adminUpdateMember`, `team.adminResetPassword`,
 * `team.layOffMember`, `resignations.review`.
 */
export const SUPPORT_REFUSED_ASSISTANT_TOOLS: ReadonlySet<string> = new Set([
  'inviteMember',
  'updateMember',
  'setMemberStatus',
  'layOffMember',
  'resetMemberPassword',
  'reviewResignation',
]);

import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { WhatsAppLintResult } from './compliance-linter';

export type WhatsAppComplianceSubject =
  'MARKETING_TEMPLATE' | 'MARKETING_CAMPAIGN' | 'KHATA_REMINDER';

export const WHATSAPP_COMPLIANCE_BLOCK_ACTION = 'pharmacy.whatsappCompliance.blocked';

/**
 * DEV-29: one audit row per blocked WhatsApp template or send, carrying the linter version
 * and reasons. The raw text and variable values are never stored, only the matched term.
 * Write it in a transaction that commits: a block that rolls back the caller's work must
 * log from a fresh transaction.
 */
export function recordWhatsAppComplianceBlock(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId?: string | null;
    actorId?: string | null;
    subject: WhatsAppComplianceSubject;
    subjectId?: string | null;
    result: WhatsAppLintResult;
  }
) {
  return db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      actorType: input.actorId ? 'USER' : 'SYSTEM',
      source: input.actorId ? 'TRPC' : 'SYSTEM',
      category: 'PHARMACY_MARKETING',
      operation: 'OTHER',
      action: WHATSAPP_COMPLIANCE_BLOCK_ACTION,
      targetType: input.subject,
      targetId: input.subjectId ?? null,
      outcome: 'FAILURE',
      errorCode: 'WHATSAPP_COMPLIANCE_BLOCKED',
      metadata: {
        branchId: input.branchId ?? null,
        linterVersion: input.result.linterVersion,
        outcome: input.result.outcome,
        reasons: input.result.reasons.map((reason) => ({
          code: reason.code,
          outcome: reason.outcome,
          source: reason.source,
          index: reason.index ?? null,
          term: reason.term ?? null,
          match: reason.match ?? null,
        })),
      },
    },
  });
}

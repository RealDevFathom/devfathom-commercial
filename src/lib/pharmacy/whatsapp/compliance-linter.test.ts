import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lintAndLogWhatsAppContent, lintWhatsAppContent } from './compliance-linter';

describe('WhatsApp compliance linter', () => {
  const catalog = { terms: ['Panadol', 'paracetamol', 'پیناڈول', 'panadol goli'] };

  it.each(['Panadol is available', 'Ask about paracetamol', 'پیناڈول دستیاب ہے', 'panadol goli'])(
    'blocks catalog drug text or transliteration: %s',
    (templateText) => {
      expect(lintWhatsAppContent({ templateText, intent: 'MARKETING', catalog })).toMatchObject({
        outcome: 'BLOCK',
        reasons: [{ code: 'REGULATED_TERM' }],
      });
    }
  );

  it('rechecks variables and blocks a drug name at send time', () => {
    expect(
      lintWhatsAppContent({
        templateText: 'Your reminder for {{1}}',
        variables: ['Panadol'],
        intent: 'UTILITY',
        catalog,
      }).outcome
    ).toBe('BLOCK');
  });

  it('warns when utility copy uses promotional wording', () => {
    expect(
      lintWhatsAppContent({
        templateText: 'Your balance is due. Limited time discount.',
        intent: 'UTILITY',
        catalog,
      })
    ).toMatchObject({ outcome: 'WARN', reasons: [{ code: 'UTILITY_PROMOTION' }] });
  });

  it('passes generic utility copy', () => {
    expect(
      lintWhatsAppContent({
        templateText: 'Your account reminder is ready.',
        variables: ['2026-11-01'],
        intent: 'UTILITY',
        catalog,
      }).outcome
    ).toBe('PASS');
  });

  it('writes blocked decisions with the linter version and reason', async () => {
    const create = vi.fn(async ({ data }) => data);
    const db = {
      medicine: {
        findMany: vi.fn(async () => [
          { productName: 'Panadol', brandName: null, aliases: [], strengths: [] },
        ]),
      },
      pharmacyWhatsAppComplianceLog: { create },
    } as unknown as ScopedDb;
    const result = await lintAndLogWhatsAppContent(
      db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
      { templateText: 'Panadol is available', intent: 'MARKETING', subject: 'template:test' }
    );
    expect(result.outcome).toBe('BLOCK');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: 'BLOCK',
        linterVersion: result.version,
        reasons: result.reasons,
      }),
    });
  });
});

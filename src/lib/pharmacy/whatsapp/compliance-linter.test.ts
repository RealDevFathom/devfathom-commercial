import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  lintAndLogWhatsAppContent,
  lintWhatsAppContent,
  readComplianceCatalog,
} from './compliance-linter';

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

  it.each([
    'Tablets available',
    'Antibiotics available',
    'Medicines available',
    'Capsules available',
    'Syrups available',
    'Painkillers available',
    'گولیاں دستیاب ہیں',
    'دوائیں دستیاب ہیں',
    'dawaiyan available',
    'goliyan available',
  ])('blocks ordinary plural categories: %s', (templateText) => {
    expect(lintWhatsAppContent({ templateText, intent: 'MARKETING' }).outcome).toBe('BLOCK');
  });

  it.each(['Panadol 500mg', 'Panadol 500 mg', 'Panadol 0.5g', 'Panadol 250mg/5ml'])(
    'blocks the unqualified name from %s even without optional brand metadata',
    (productName) => {
      expect(
        lintWhatsAppContent({
          templateText: 'Panadol available. Reply STOP.',
          intent: 'MARKETING',
          catalog: { terms: [productName] },
        })
      ).toMatchObject({ outcome: 'BLOCK', reasons: [{ term: 'panadol', source: 'CATALOG' }] });
      expect(
        lintWhatsAppContent({
          templateText: 'Your reminder for {{1}}',
          variables: ['Panadol'],
          intent: 'UTILITY',
          catalog: { terms: [productName] },
        }).outcome
      ).toBe('BLOCK');
    }
  );

  it('preserves word boundaries and does not strip arbitrary numeric brand suffixes', () => {
    expect(
      lintWhatsAppContent({
        templateText: 'Panadols gift set and B vitamins. Reply STOP.',
        intent: 'MARKETING',
        catalog: { terms: ['Panadol 500mg', 'B 12'] },
      }).outcome
    ).toBe('PASS');
  });

  it('excludes front-shop products while keeping regulated catalog names, aliases and salts', async () => {
    const findMany = vi.fn(async ({ where }) =>
      [
        {
          productFamily: 'FRONT_SHOP',
          productName: 'Toothbrush',
          brandName: 'BrushCo',
          aliases: [{ value: 'Soft brush' }],
          strengths: [],
        },
        {
          productFamily: 'PHARMACEUTICAL',
          productName: 'Panadol 500mg',
          brandName: null,
          aliases: [{ value: 'پیناڈول' }],
          strengths: [{ ingredient: { name: 'paracetamol' } }],
        },
      ].filter((medicine) => medicine.productFamily !== where.productFamily?.not)
    );
    const catalog = await readComplianceCatalog(
      { medicine: { findMany } } as unknown as ScopedDb,
      'org-a'
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', productFamily: { not: 'FRONT_SHOP' } },
      })
    );
    expect(catalog.terms).not.toContain('Toothbrush');
    expect(catalog.terms).toEqual(
      expect.arrayContaining(['Panadol 500mg', 'پیناڈول', 'paracetamol'])
    );
    expect(
      lintWhatsAppContent({
        templateText: 'Toothbrush by BrushCo. Soft brush available. Reply STOP.',
        intent: 'MARKETING',
        catalog,
      }).outcome
    ).toBe('PASS');
    expect(
      lintWhatsAppContent({ templateText: 'Panadol available', intent: 'MARKETING', catalog })
        .outcome
    ).toBe('BLOCK');
  });

  it.each([
    'Injections available',
    'Vaccine available today',
    'Inhalers in stock',
    'Ointment available',
    'Eye drops in stock',
    'دوائی دستیاب ہے',
    'm-e-d-i-c-i-n-e available',
    'P a n a d o l available',
  ])('blocks extra categories and letter-spaced evasion: %s', (templateText) => {
    expect(lintWhatsAppContent({ templateText, intent: 'MARKETING', catalog }).outcome).toBe(
      'BLOCK'
    );
  });

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

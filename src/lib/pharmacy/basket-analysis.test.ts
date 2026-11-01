import { describe, expect, it } from 'vitest';
import {
  bundleProposalWhatsAppText,
  mineBundleProposals,
  type BasketMiningConfig,
  type BasketProduct,
} from './basket-analysis';

const products: BasketProduct[] = [
  {
    id: 'soap',
    name: 'Face soap',
    productFamily: 'FRONT_SHOP',
    rx: false,
    otc: false,
    restricted: false,
    controlled: false,
  },
  {
    id: 'cream',
    name: 'Skin cream',
    productFamily: 'FRONT_SHOP',
    rx: false,
    otc: false,
    restricted: false,
    controlled: false,
  },
  {
    id: 'otc',
    name: 'OTC product',
    productFamily: 'PHARMACEUTICAL',
    rx: false,
    otc: true,
    restricted: false,
    controlled: false,
  },
  {
    id: 'rx',
    name: 'Prescription product',
    productFamily: 'PHARMACEUTICAL',
    rx: true,
    otc: false,
    restricted: false,
    controlled: false,
  },
  {
    id: 'restricted',
    name: 'Restricted product',
    productFamily: 'PHARMACEUTICAL',
    rx: false,
    otc: true,
    restricted: true,
    controlled: false,
  },
];

const config: BasketMiningConfig = {
  minimumPairCount: 2,
  minimumSupport: 0.3,
  minimumConfidence: 0.5,
  minimumLift: 1,
  maximumProposals: 5,
};

describe('pharmacy basket bundle proposals', () => {
  it('mines fixture-backed association evidence and leaves every proposal pending owner approval', () => {
    const result = mineBundleProposals(
      [
        { id: 's1', productIds: ['soap', 'cream', 'rx'] },
        { id: 's2', productIds: ['soap', 'cream'] },
        { id: 's3', productIds: ['otc'] },
        { id: 's4', productIds: ['otc'] },
      ],
      products,
      config
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      productIds: ['cream', 'soap'],
      evidence: { basketCount: 4, pairCount: 2, support: 0.5, confidence: 1, lift: 2 },
      status: 'PENDING_OWNER_APPROVAL',
      approvalRequired: true,
    });
  });

  it('excludes Rx and restricted items before counting rules', () => {
    const result = mineBundleProposals(
      [
        { id: 's1', productIds: ['soap', 'rx', 'restricted'] },
        { id: 's2', productIds: ['soap', 'rx', 'restricted'] },
      ],
      products,
      { ...config, minimumSupport: 0, minimumLift: 0 }
    );
    expect(result).toEqual([]);
  });

  it('uses configurable thresholds and limits rather than embedded research estimates', () => {
    const fixtures = [
      { id: 's1', productIds: ['soap', 'cream'] },
      { id: 's2', productIds: ['soap', 'cream'] },
    ];
    expect(mineBundleProposals(fixtures, products, { ...config, minimumPairCount: 3 })).toEqual([]);
    expect(() =>
      mineBundleProposals(fixtures, products, { ...config, minimumSupport: 1.1 })
    ).toThrow('Invalid basket mining configuration.');
  });

  it('keeps WhatsApp copy generic and independent of catalog names and medicine categories', () => {
    const text = bundleProposalWhatsAppText();
    expect(text).toBe(
      'A new in-store retail offer may be available. Ask our team for details. Reply STOP to opt out.'
    );
    for (const forbidden of [
      ...products.map((product) => product.name),
      'drug',
      'medicine',
      'pharmaceutical',
      'OTC',
    ])
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
});

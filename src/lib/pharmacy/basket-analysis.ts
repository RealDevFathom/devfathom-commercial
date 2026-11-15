/**
 * Deterministic market-basket mining for owner-reviewed front-shop offers.
 *
 * This module deliberately does not activate an offer.  Its output is a proposal
 * whose pending state must be consumed by the existing owner-approval workflow.
 */

import { isNonDrugRetail } from './product-class';

export type BasketProduct = {
  id: string;
  name: string;
  productFamily: 'PHARMACEUTICAL' | 'BIOLOGICAL' | 'DEVICE' | 'ALTERNATIVE' | 'FRONT_SHOP';
  rx: boolean;
  otc: boolean;
  restricted: boolean;
  controlled: boolean;
};

export type SalesBasket = { id: string; productIds: string[] };

export type BasketMiningConfig = {
  /** Absolute observations, not an assumed or illustrative business figure. */
  minimumPairCount: number;
  minimumSupport: number;
  minimumConfidence: number;
  minimumLift: number;
  maximumProposals: number;
};

export type BundleProposal = {
  productIds: [string, string];
  productNames: [string, string];
  evidence: {
    basketCount: number;
    pairCount: number;
    support: number;
    confidence: number;
    lift: number;
  };
  status: 'PENDING_OWNER_APPROVAL';
  approvalRequired: true;
};

// #718: only NON_DRUG_RETAIL (FRONT_SHOP) items may be promoted; an OTC medicine is still a medicine.
function eligibleForBundle(product: BasketProduct) {
  if (product.rx || product.restricted || product.controlled) return false;
  return isNonDrugRetail(product.productFamily);
}

function validConfig(config: BasketMiningConfig) {
  return (
    Number.isSafeInteger(config.minimumPairCount) &&
    config.minimumPairCount > 0 &&
    config.minimumSupport >= 0 &&
    config.minimumSupport <= 1 &&
    config.minimumConfidence >= 0 &&
    config.minimumConfidence <= 1 &&
    config.minimumLift >= 0 &&
    Number.isSafeInteger(config.maximumProposals) &&
    config.maximumProposals > 0
  );
}

/** Mine unordered two-item rules from completed-sale baskets supplied by the caller. */
export function mineBundleProposals(
  baskets: readonly SalesBasket[],
  products: readonly BasketProduct[],
  config: BasketMiningConfig
): BundleProposal[] {
  if (!validConfig(config)) throw new Error('Invalid basket mining configuration.');
  if (baskets.length === 0) return [];

  const catalog = new Map(products.map((product) => [product.id, product]));
  const itemCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();

  for (const basket of baskets) {
    const ids = [...new Set(basket.productIds)]
      .filter((id) => {
        const product = catalog.get(id);
        return product !== undefined && eligibleForBundle(product);
      })
      .sort();
    for (const id of ids) itemCounts.set(id, (itemCounts.get(id) ?? 0) + 1);
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const key = `${ids[left]}\u0000${ids[right]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  return [...pairCounts]
    .map(([key, pairCount]): BundleProposal => {
      const [left, right] = key.split('\u0000') as [string, string];
      const leftCount = itemCounts.get(left) ?? 0;
      const rightCount = itemCounts.get(right) ?? 0;
      const support = pairCount / baskets.length;
      const confidence = Math.max(pairCount / leftCount, pairCount / rightCount);
      const lift = support / ((leftCount / baskets.length) * (rightCount / baskets.length));
      return {
        productIds: [left, right],
        productNames: [catalog.get(left)!.name, catalog.get(right)!.name],
        evidence: { basketCount: baskets.length, pairCount, support, confidence, lift },
        status: 'PENDING_OWNER_APPROVAL',
        approvalRequired: true,
      };
    })
    .filter(
      ({ evidence }) =>
        evidence.pairCount >= config.minimumPairCount &&
        evidence.support >= config.minimumSupport &&
        evidence.confidence >= config.minimumConfidence &&
        evidence.lift >= config.minimumLift
    )
    .sort(
      (a, b) =>
        b.evidence.lift - a.evidence.lift ||
        b.evidence.pairCount - a.evidence.pairCount ||
        a.productIds.join(':').localeCompare(b.productIds.join(':'))
    )
    .slice(0, config.maximumProposals);
}

/** Policy-safe outbound copy: product and category data can never enter the text. */
export function bundleProposalWhatsAppText(): string {
  return 'A new in-store retail offer may be available. Ask our team for details. Reply STOP to opt out.';
}

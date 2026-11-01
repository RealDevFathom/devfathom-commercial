import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Recovery = {
  issue: number;
  archive: string;
  tip: string;
  decision: string;
  commits: Array<{
    sha: string;
    disposition: string;
    rationale?: string;
    retiredBehavior?: string[];
    evidence: string[];
  }>;
};

const root = resolve(import.meta.dirname, '..');
const recovery = JSON.parse(
  readFileSync(resolve(root, 'docs/archive-recovery/issue-475.json'), 'utf8')
) as Recovery;

describe('archived AI growth G2 recovery decision', () => {
  it('accounts for every archived commit without reviving the obsolete branch', () => {
    expect(recovery).toMatchObject({
      issue: 475,
      archive: 'archive/improve/ai-growth-g2',
      tip: '304a4aa6',
      decision: 'obsolete',
    });
    expect(recovery.commits.map(({ sha }) => sha)).toEqual([
      '304a4aa6',
      'f6463f25',
      '1378c79e',
      '6e152825',
      '25834be5',
      '646692de',
      'dcbd97cc',
      '67df65b5',
      '97e9d2c4',
      'ecfc2f76',
      'd3e8cdad',
      '7b81f39e',
    ]);
  });

  it('keeps auditable replacement evidence for every disposition', () => {
    for (const commit of recovery.commits) {
      expect(commit.disposition, commit.sha).not.toBe('');
      expect(commit.evidence.length, commit.sha).toBeGreaterThan(0);
      for (const path of commit.evidence) {
        expect(existsSync(resolve(root, path)), `${commit.sha}: ${path}`).toBe(true);
      }
    }
  });

  it('explicitly accounts for the unimplemented receipt loyalty additions as retired', () => {
    const receiptLoyalty = recovery.commits.find(({ sha }) => sha === 'd3e8cdad');

    expect(receiptLoyalty).toMatchObject({
      disposition: 'retired',
      rationale: expect.stringMatching(/\S/),
      retiredBehavior: [
        'receipt.loyalty.pointsBalance',
        'receipt.loyalty.balancePkr',
        'receipt.loyalty.pointsEarned',
        'receipt.loyalty.pointsPerPkr',
        'getLoyaltySummary',
      ],
      evidence: expect.arrayContaining([
        'src/lib/restaurant/checkout-routes.ts',
        'src/components/restaurant/pos/receipt-view.tsx',
        'src/app/api/restaurant/checkout/receipt/receipt-dispatch.ts',
      ]),
    });
  });
});

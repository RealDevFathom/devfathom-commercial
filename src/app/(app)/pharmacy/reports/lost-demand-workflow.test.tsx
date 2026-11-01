import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
  type LostDemandAdvice,
} from '@/lib/pharmacy/lost-demand-procurement';
import { LostDemandWorkflow } from './lost-demand-workflow';

const advice: LostDemandAdvice = {
  id: 'a'.repeat(64),
  organizationId: 'org',
  branchId: 'b1',
  medicineId: 'm1',
  name: 'Requested medicine',
  fired: ['REQUESTS'],
  metrics: { requests: 3, estimatedLossMinor: 1000, walkOuts: 1, visits: 9 },
  quantity: { requiredUnits: 70, orderedPacks: 6, bonusPacks: 1, suppliedUnits: 70 },
  distributors: [
    {
      supplierId: 's1',
      name: 'Licensed distributor',
      lastPricePerPackMinor: 1000,
      quotePricePerPackMinor: 1100,
      scheme: { buyPacks: 5, freePacks: 1 },
      leadTimeDays: 7,
      quantity: { requiredUnits: 70, orderedPacks: 6, bonusPacks: 1, suppliedUnits: 70 },
    },
  ],
  alternates: [
    { medicineId: 'm2', name: 'Equivalent medicine', sameSaltAndStrength: true, marginBps: 2500 },
  ],
  transfers: [
    {
      fromBranchId: 'b2',
      name: 'Surplus branch',
      surplusUnits: 90,
      lines: [
        {
          sourceLotId: 'l1',
          sourceStockLocationId: 'loc1',
          destinationStockLocationId: 'loc2',
          quantityUnits: 70,
        },
      ],
    },
  ],
};
const action = async () => ({ message: 'saved', success: true });
const props = {
  branchId: 'b1',
  config: DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
  financial: true,
  configure: true,
  act: action,
  save: action,
};

describe('connected lost-demand workflow', () => {
  it('offers quantities, terms, ranked equivalents, surplus, PIN actions and branch settings', () => {
    const html = renderToStaticMarkup(<LostDemandWorkflow {...props} advice={[advice]} />);
    for (const value of [
      '70 canonical units',
      'Licensed distributor',
      'lead time 7',
      '6 paid + 1 bonus',
      'buy 5, get 1 free',
      'Equivalent medicine',
      '25.00%',
      '90 surplus units',
      'Your fresh operator PIN',
      'Draft PO',
      'Draft Transfer',
      'Ignore',
      'Save branch thresholds',
      'separate approval',
    ])
      expect(html).toContain(value);
    expect(html).toContain('type="password"');
    expect(html).toContain('name="adviceId"');
    expect(html).toContain('href="/pharmacy/settings/pin"');
  });
  it('renders access, empty and read failure states without exposing financial terms', () => {
    const denied = renderToStaticMarkup(
      <LostDemandWorkflow {...props} advice={[advice]} financial={false} configure={false} />
    );
    expect(denied).toContain('Financial report access is required');
    expect(denied).not.toContain('Licensed distributor');
    expect(renderToStaticMarkup(<LostDemandWorkflow {...props} advice={[]} />)).toContain(
      'No unreviewed procurement advice'
    );
    expect(renderToStaticMarkup(<LostDemandWorkflow {...props} advice={null} />)).toContain(
      'role="alert"'
    );
  });
});

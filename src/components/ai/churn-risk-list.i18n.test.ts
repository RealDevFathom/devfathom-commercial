import { describe, expect, it } from 'vitest';

import { CHURN_RISK_STRINGS } from './churn-risk-list.i18n';

describe('churn risk translations', () => {
  it('provides an Urdu value for every English key', () => {
    expect(Object.keys(CHURN_RISK_STRINGS.ur).sort()).toEqual(
      Object.keys(CHURN_RISK_STRINGS.en).sort()
    );

    for (const key of Object.keys(CHURN_RISK_STRINGS.en) as Array<
      keyof typeof CHURN_RISK_STRINGS.en
    >) {
      expect(CHURN_RISK_STRINGS.ur[key].trim(), `missing Urdu copy for ${key}`).not.toBe('');
    }
  });
});

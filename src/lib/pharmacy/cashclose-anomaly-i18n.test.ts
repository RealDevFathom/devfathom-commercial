import { describe, expect, it } from 'vitest';
import { CASH_CLOSE_ANOMALY_I18N } from './cashclose-anomaly-i18n';

describe('cash-close anomaly translations', () => {
  it('provides an Urdu key for every English key', () => {
    expect(Object.keys(CASH_CLOSE_ANOMALY_I18N.ur.messages).sort()).toEqual(
      Object.keys(CASH_CLOSE_ANOMALY_I18N.en.messages).sort()
    );
  });

  it('marks Urdu copy as right-to-left', () => {
    expect(CASH_CLOSE_ANOMALY_I18N.ur.direction).toBe('rtl');
  });
});


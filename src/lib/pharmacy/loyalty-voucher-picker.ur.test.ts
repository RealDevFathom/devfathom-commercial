import { describe, expect, it } from 'vitest';
import {
  LOYALTY_VOUCHER_PICKER_EN_KEYS,
  LOYALTY_VOUCHER_PICKER_UR,
  LOYALTY_VOUCHER_PICKER_UR_DIRECTION,
} from './loyalty-voucher-picker.ur';

describe('pharmacy loyalty voucher picker Urdu catalogue', () => {
  it('has an Urdu value for every English catalogue key', () => {
    expect(Object.keys(LOYALTY_VOUCHER_PICKER_UR).sort()).toEqual(
      [...LOYALTY_VOUCHER_PICKER_EN_KEYS].sort()
    );

    for (const key of LOYALTY_VOUCHER_PICKER_EN_KEYS) {
      expect(LOYALTY_VOUCHER_PICKER_UR[key].trim(), key).not.toBe('');
    }
  });

  it('declares right-to-left rendering', () => {
    expect(LOYALTY_VOUCHER_PICKER_UR_DIRECTION).toBe('rtl');
  });
});

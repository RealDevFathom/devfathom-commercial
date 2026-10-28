import { describe, expect, it } from 'vitest';

import {
  assertControlledSaleFields,
  controlledRegisterRule,
  isPendingLegalReview,
  missingControlledSaleFields,
  ProvincialRegisterError,
  PROVINCE_BALOCHISTAN,
  PROVINCE_PUNJAB,
  PROVINCE_SINDH,
} from './provincial-register';

describe('controlledRegisterRule', () => {
  it('requires the complete patient address only in Sindh', () => {
    expect(controlledRegisterRule(PROVINCE_SINDH).requiresPatientAddress).toBe(true);
    expect(controlledRegisterRule(PROVINCE_PUNJAB).requiresPatientAddress).toBe(false);
    expect(controlledRegisterRule(PROVINCE_BALOCHISTAN).requiresPatientAddress).toBe(false);
  });

  it('leaves not-obtained and unknown provinces on the base default', () => {
    // KP and the federal CNS Rules 2001 are NOT OBTAINED in the spec.
    expect(controlledRegisterRule('PK-KP').requiresPatientAddress).toBe(false);
    expect(controlledRegisterRule('PK-ICT').requiresPatientAddress).toBe(false);
    expect(controlledRegisterRule(null).requiresPatientAddress).toBe(false);
  });
});

describe('isPendingLegalReview', () => {
  it('treats anything but an explicit provisional:false as pending', () => {
    expect(isPendingLegalReview({ provisional: false })).toBe(false);
    expect(isPendingLegalReview({ provisional: true })).toBe(true);
    expect(isPendingLegalReview({})).toBe(true);
    expect(isPendingLegalReview(null)).toBe(true);
  });
});

describe('missingControlledSaleFields', () => {
  const sindhConfirmed = { provinceCode: PROVINCE_SINDH, pendingLegalReview: false };

  it('flags a Sindh sale that has no complete address once the rules are confirmed', () => {
    expect(missingControlledSaleFields(sindhConfirmed, { patientAddress: '' })).toEqual([
      "the patient's complete address",
    ]);
    expect(missingControlledSaleFields(sindhConfirmed, { patientAddress: '   ' })).toHaveLength(1);
    expect(
      missingControlledSaleFields(sindhConfirmed, { patientAddress: '12 Mall Road, Karachi' })
    ).toEqual([]);
  });

  it('records but does not enforce while the province rules are pending legal review', () => {
    expect(
      missingControlledSaleFields(
        { provinceCode: PROVINCE_SINDH, pendingLegalReview: true },
        { patientAddress: '' }
      )
    ).toEqual([]);
  });

  it('enforces nothing extra for Punjab, Balochistan or a missing profile', () => {
    expect(
      missingControlledSaleFields(
        { provinceCode: PROVINCE_PUNJAB, pendingLegalReview: false },
        { patientAddress: '' }
      )
    ).toEqual([]);
    expect(missingControlledSaleFields(null, { patientAddress: '' })).toEqual([]);
  });
});

describe('assertControlledSaleFields', () => {
  it('throws for a confirmed Sindh sale with no address and is silent otherwise', () => {
    expect(() =>
      assertControlledSaleFields(
        { provinceCode: PROVINCE_SINDH, pendingLegalReview: false },
        { patientAddress: null }
      )
    ).toThrow(ProvincialRegisterError);
    expect(() =>
      assertControlledSaleFields(
        { provinceCode: PROVINCE_SINDH, pendingLegalReview: false },
        { patientAddress: '12 Mall Road, Karachi' }
      )
    ).not.toThrow();
  });
});

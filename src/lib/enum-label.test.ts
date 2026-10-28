import { expect, it } from 'vitest';
import { enumLabel } from './enum-label';
it.each([
  ['FRONT_OF_HOUSE', 'Front of house'],
  ['Front_of_house', 'Front of house'],
  ['HR', 'HR'],
  ['cashier', 'Cashier'],
])('labels %s as %s', (value, label) => {
  expect(enumLabel(value)).toBe(label);
});

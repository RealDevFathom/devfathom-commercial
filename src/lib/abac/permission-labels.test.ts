import { describe, expect, it } from 'vitest';
import { ALL_ACTIONS } from './policies';
import { PERMISSION_LABELS, permissionDisplayName } from './permission-labels';

describe('permission labels in the role editor', () => {
  it('names the DEV-66 discount right in plain words, with its action', () => {
    expect(PERMISSION_LABELS['pharmacy:discount']).toBe('Give discounts without manager approval');
    expect(permissionDisplayName('pharmacy:discount')).toBe(
      'Give discounts without manager approval (pharmacy:discount)'
    );
  });

  it('shows an unlabelled permission by its action name', () => {
    expect(permissionDisplayName('pharmacy:counter')).toBe('pharmacy:counter');
    expect(permissionDisplayName('projects:*')).toBe('projects:*');
  });

  it('labels only real actions', () => {
    for (const action of Object.keys(PERMISSION_LABELS))
      expect(ALL_ACTIONS).toContain(action as (typeof ALL_ACTIONS)[number]);
  });
});

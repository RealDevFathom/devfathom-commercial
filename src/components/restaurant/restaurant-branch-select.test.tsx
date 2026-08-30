import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RestaurantBranchSelect } from './restaurant-branch-select';

describe('RestaurantBranchSelect', () => {
  it('shows readable names and stable codes while keeping opaque ids out of labels', () => {
    render(
      <RestaurantBranchSelect
        branches={[
          {
            id: 'cmtxopaque123',
            name: 'DHA Phase 6',
            code: 'DHA-PH6',
            active: true,
            isDefault: true,
          },
        ]}
      />
    );
    const option = screen.getByRole('option', { name: 'DHA Phase 6 · DHA-PH6 (default)' });
    expect(option).toHaveValue('cmtxopaque123');
    expect(option).not.toHaveTextContent('cmtxopaque123');
  });
});

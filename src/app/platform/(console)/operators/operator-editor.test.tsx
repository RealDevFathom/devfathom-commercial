import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { OperatorEditor } from './operator-editor';

vi.mock('next/dynamic', () => ({
  default: () =>
    function DeferredControl() {
      return <div data-testid="deferred-control" />;
    },
}));

describe('OperatorEditor', () => {
  it('does not render operator controls until the disclosure is opened', () => {
    render(
      <OperatorEditor
        fields={[{ name: 'name', label: 'Name' }]}
        mfaReset={{ id: 'operator-1', email: 'operator@example.com' }}
      >
        <summary>Operator One</summary>
      </OperatorEditor>
    );

    expect(screen.queryByTestId('deferred-control')).not.toBeInTheDocument();

    const disclosure = screen.getByText('Operator One').closest('details');
    expect(disclosure).not.toBeNull();
    disclosure!.open = true;
    fireEvent(disclosure!, new Event('toggle'));

    expect(screen.getAllByTestId('deferred-control')).toHaveLength(2);
  });
});

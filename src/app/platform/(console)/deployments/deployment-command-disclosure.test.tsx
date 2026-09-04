import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeploymentCommandDisclosure } from './deployment-command-disclosure';

vi.mock('next/dynamic', () => ({
  default: () =>
    function DeferredForm({ action }: { action: string }) {
      return <div data-testid="deferred-form">{action}</div>;
    },
}));

const fields = [{ name: 'id', label: 'Deployment', type: 'hidden' as const }];

describe('DeploymentCommandDisclosure', () => {
  it('mounts an update form only after its native disclosure opens', () => {
    render(
      <DeploymentCommandDisclosure
        action="deployment.update"
        submitLabel="Save deployment"
        fields={fields}
      >
        <summary>Edit deployment</summary>
      </DeploymentCommandDisclosure>
    );

    expect(screen.queryByTestId('deferred-form')).not.toBeInTheDocument();

    const summary = screen.getByText('Edit deployment');
    const disclosure = summary.closest('details');
    expect(disclosure).not.toBeNull();
    disclosure!.open = true;
    fireEvent(disclosure!, new Event('toggle'));

    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByTestId('deferred-form')).toHaveTextContent('deployment.update');

    disclosure!.open = false;
    fireEvent(disclosure!, new Event('toggle'));

    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.queryByTestId('deferred-form')).not.toBeInTheDocument();

    disclosure!.open = true;
    fireEvent(disclosure!, new Event('toggle'));

    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByTestId('deferred-form')).toHaveTextContent('deployment.update');
  });

  it('mounts the create form immediately for an organization deep link', () => {
    render(
      <DeploymentCommandDisclosure
        defaultOpen
        action="deployment.create"
        submitLabel="Create deployment"
        fields={fields}
      >
        <summary>Add deployment</summary>
      </DeploymentCommandDisclosure>
    );

    expect(screen.getByText('Add deployment').closest('details')).toHaveAttribute('open');
    expect(screen.getByTestId('deferred-form')).toHaveTextContent('deployment.create');
  });
});

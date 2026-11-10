import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeploymentsPage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn(),
  withPlatformDb: vi.fn(),
}));

vi.mock('@/lib/platform/page-access', () => ({
  requirePlatformRead: mocks.requirePlatformRead,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformRead.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.withPlatformDb.mockImplementation((run: (db: unknown) => Promise<unknown>) =>
    run({
      organizationDeployment: { findMany: vi.fn().mockResolvedValue([]) },
      organization: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'pharmacy_1', displayName: 'Clifton Chemist', slug: 'clifton-chemist' },
        ]),
      },
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pharmacy deployment environment validation', () => {
  it.each([
    ['x', 'Environment must be at least 2 characters.'],
    ['a'.repeat(81), 'Environment must be at most 80 characters.'],
    ['staging test', 'Environment has an invalid format.'],
    ['Staging', 'Environment has an invalid format.'],
    ['-staging', 'Environment has an invalid format.'],
    ['_staging', 'Environment has an invalid format.'],
  ])('rejects environment %s before submitting', async (value, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(await DeploymentsPage({}));
    const environment = screen.getByLabelText('Environment');
    expect(environment).toHaveAttribute('minlength', '2');
    expect(environment).toHaveAttribute('maxlength', '80');
    expect(environment).toHaveAttribute('pattern', '\\s*[a-z0-9][a-z0-9_\\-]*\\s*');
    fireEvent.change(environment, { target: { value } });
    fireEvent.submit(environment.closest('form')!);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(environment).toHaveFocus();
    expect(environment).toHaveAccessibleDescription(message);
  });

  it.each(['qa', 'staging-test_2', 'a'.repeat(80), ' staging-test_2 '])(
    'accepts environment %s',
    async (value) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      render(await DeploymentsPage({}));
      const environment = screen.getByLabelText('Environment');
      fireEvent.change(environment, { target: { value } });

      expect(environment).toBeValid();
      fireEvent.submit(environment.closest('form')!);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
        action: 'deployment.create',
        payload: { organizationId: 'pharmacy_1', environment: value },
      });
      expect(environment).toHaveAttribute('aria-invalid', 'false');
    }
  );
});

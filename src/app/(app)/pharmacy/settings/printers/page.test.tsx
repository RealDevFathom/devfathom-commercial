import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({ resolveTenantActor: vi.fn(), notFound: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/components/pharmacy/printer-settings/printer-settings-console', () => ({
  PharmacyPrinterSettings: () => null,
}));

import PharmacyPrinterSettingsPage from './page';
import { PharmacyPrinterSettings } from '@/components/pharmacy/printer-settings/printer-settings-console';

function actor(vertical?: string, role = 'ADMIN') {
  return { session: { user: { id: 'user-1', role } }, organization: { id: 'org-a', vertical } };
}

function settingsProps(page: ReactElement<{ children: ReactElement[] }>) {
  const child = page.props.children.find((node) => node.type === PharmacyPrinterSettings);
  return child?.props as { canEdit: boolean } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
});

describe('PharmacyPrinterSettingsPage', () => {
  it('lets a pharmacy administrator edit', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor('PHARMACY', 'ADMIN'));
    const page = (await PharmacyPrinterSettingsPage()) as ReactElement<{
      children: ReactElement[];
    }>;
    expect(settingsProps(page)).toEqual({ canEdit: true });
  });

  it('opens read-only with test print for other pharmacy members', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor('PHARMACY', 'EMPLOYEE'));
    const page = (await PharmacyPrinterSettingsPage()) as ReactElement<{
      children: ReactElement[];
    }>;
    expect(settingsProps(page)).toEqual({ canEdit: false });
  });

  // DEV-355: pharmacy printer settings never appear for another vertical.
  it.each(['RESTAURANT', 'HOSPITALITY', 'AGENCY', undefined])(
    'returns not found for vertical %s',
    async (vertical) => {
      mocks.resolveTenantActor.mockResolvedValue(actor(vertical));
      await expect(PharmacyPrinterSettingsPage()).rejects.toThrow('NEXT_NOT_FOUND');
    }
  );

  it('returns not found without a tenant actor', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    await expect(PharmacyPrinterSettingsPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

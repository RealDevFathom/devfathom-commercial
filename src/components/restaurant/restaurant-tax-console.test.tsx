import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PAKISTAN_TAX_PROFILE_CATALOG } from '@/lib/restaurant/pakistan-tax-profiles';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  publishCustom: vi.fn(),
  invalidate: vi.fn(),
  activeProfiles: [] as {
    id: string;
    branch: { name: string; timezone: string };
    effectiveFrom: Date;
    approvalReference: string;
    rules: { paymentCategory: string; rate: string }[];
  }[],
  publicationOptions: {
    onSuccess: () => {},
    onError: (error: Error) => {
      void error;
    },
  },
  previewCustom: vi.fn(() => ({
    data: { net: '1000.00', tax: '0.00', gross: '1000.00' },
  })),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantTax: { configuration: { invalidate: mocks.invalidate } } }),
    restaurantTax: {
      configuration: {
        useQuery: () => ({
          data: {
            branches: [{ id: 'branch_1', name: 'Karachi' }],
            profiles: PAKISTAN_TAX_PROFILE_CATALOG,
            activeProfiles: mocks.activeProfiles,
          },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      previewCustom: {
        useQuery: mocks.previewCustom,
      },
      activate: { useMutation: () => ({ mutate: mocks.activate, isPending: false }) },
      publishCustom: {
        useMutation: (options: typeof mocks.publicationOptions) => {
          mocks.publicationOptions = options;
          return { mutate: mocks.publishCustom, isPending: false };
        },
      },
    },
  },
}));

import { RestaurantTaxConsole } from './restaurant-tax-console';

describe('restaurant tax configuration UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeProfiles.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders on HTTP LAN and retains a failed command key through rerender and retry', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const view = render(<RestaurantTaxConsole />);
    submitCustomRates(['16', '8', '15']);
    const first = mocks.publishCustom.mock.calls[0]![0].idempotencyKey;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    act(() => mocks.publicationOptions.onError(new Error('Response lost')));
    view.rerender(<RestaurantTaxConsole />);
    const form = screen.getByRole('button', { name: 'Publish custom profile' }).closest('form')!;
    fireEvent.submit(form);
    expect(mocks.publishCustom.mock.calls[1]![0].idempotencyKey).toBe(first);
    act(() => mocks.publicationOptions.onSuccess());
    fireEvent.submit(form);
    expect(mocks.publishCustom.mock.calls[2]![0].idempotencyKey).not.toBe(first);
  });

  it('shows an unconfigured fail-closed state and disables unverified presets', () => {
    render(<RestaurantTaxConsole />);
    expect(screen.getByText('No tax profile configured.')).toBeInTheDocument();
    expect(screen.getByText(/checkout remains fail-closed/i)).toBeInTheDocument();
    const punjab = screen.getByRole('option', { name: /Punjab restaurant \(unavailable\)/i });
    expect(punjab).toBeDisabled();
    expect(
      screen.getByRole('option', {
        name: /Sindh restaurant — SRB-approved listed branch \(unavailable\)/i,
      })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Activate tax profile' })).toBeDisabled();
  });

  it('explains why a disabled profile is unavailable and prevents submission', () => {
    render(<RestaurantTaxConsole />);
    const profileSelect = screen.getByLabelText('Jurisdiction and profile');
    const punjab = screen.getByRole('option', { name: /Punjab restaurant \(unavailable\)/i });

    expect(punjab).toBeDisabled();
    expect(profileSelect).toHaveAccessibleDescription(
      expect.stringContaining(
        'Punjab restaurant: A current official PRA rate instrument and accountant approval are required.'
      )
    );

    fireEvent.change(profileSelect, { target: { value: 'PK-PB-RESTAURANT' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Activate tax profile' }).closest('form')!);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('submits explicit branch, profile, date, approval, and eligibility evidence', () => {
    render(<RestaurantTaxConsole />);
    fireEvent.change(screen.getByLabelText('Preset branch'), { target: { value: 'branch_1' } });
    fireEvent.change(screen.getByLabelText('Jurisdiction and profile'), {
      target: { value: 'PK-ICT-RESTAURANT' },
    });
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('Preset accountant approval reference'), {
      target: { value: 'Memo 42' },
    });
    for (const label of [
      /no input tax credit or adjustment/i,
      /no refund/i,
      /I confirm an accountant reviewed/i,
    ])
      fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByRole('button', { name: 'Activate tax profile' }));
    expect(mocks.activate).toHaveBeenCalledWith({
      branchId: 'branch_1',
      profileId: 'PK-ICT-RESTAURANT',
      effectiveFrom: '2026-07-01',
      approvalReference: 'Memo 42',
      accountantConfirmation: true,
      eligibilityConfirmations: ['ictNoInputTaxCreditOrAdjustment', 'ictNoRefund'],
      idempotencyKey: expect.any(String),
    });
  });

  it.each([
    ['Asia/Karachi', '2026-06-30T19:00:00.000Z'],
    ['Pacific/Kiritimati', '2026-06-30T10:00:00.000Z'],
    ['America/New_York', '2026-07-01T04:00:00.000Z'],
  ])('displays the published calendar date in the branch timezone %s', (timezone, instant) => {
    mocks.activeProfiles.push({
      id: 'published_1',
      branch: { name: 'Published branch', timezone },
      effectiveFrom: new Date(instant),
      approvalReference: 'Memo 42',
      rules: [{ paymentCategory: 'CASH', rate: '0.15' }],
    });

    render(<RestaurantTaxConsole />);

    expect(screen.getByText('Effective 01-Jul-2026 · Memo 42')).toBeInTheDocument();
  });

  it('offers all five Pakistan jurisdictions and clearly labels custom evidence', () => {
    render(<RestaurantTaxConsole />);
    expect(screen.getByText('Custom tax profile')).toBeInTheDocument();
    expect(screen.getByText(/customer supplied · not verified by devfathom/i)).toBeInTheDocument();
    const jurisdiction = screen.getByLabelText<HTMLSelectElement>('Pakistan jurisdiction');
    const jurisdictionNames = [
      'Punjab',
      'Sindh',
      'Khyber Pakhtunkhwa',
      'Islamabad Capital Territory',
      'Balochistan',
    ];
    for (const name of jurisdictionNames) expect(jurisdiction).toHaveTextContent(name);
    expect(
      Array.from(jurisdiction.options, (option) => option.text).filter(
        (name) => name !== 'Select jurisdiction'
      )
    ).toEqual(jurisdictionNames);
    expect(screen.getByText(/live calculation preview/i)).toBeInTheDocument();
  });

  function customRateInput(category: 'Cash' | 'Card' | 'Other') {
    return screen.getByLabelText(`${category} tax rate (%)`);
  }

  function submitCustomRates(rates: [string, string, string]) {
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Custom 2026' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    fireEvent.change(screen.getByLabelText('Pakistan jurisdiction'), {
      target: { value: 'PK-SD' },
    });
    fireEvent.change(screen.getByLabelText('Effective date (branch local)'), {
      target: { value: '2026-08-30' },
    });
    fireEvent.change(screen.getByLabelText('Accountant approval reference'), {
      target: { value: 'Memo 93' },
    });
    fireEvent.change(customRateInput('Cash'), { target: { value: rates[0] } });
    fireEvent.change(customRateInput('Card'), { target: { value: rates[1] } });
    fireEvent.change(customRateInput('Other'), { target: { value: rates[2] } });
    fireEvent.click(
      screen.getByLabelText(/I confirm these exact rates were supplied\/reviewed by my accountant/i)
    );
    fireEvent.submit(
      screen.getByRole('button', { name: 'Publish custom profile' }).closest('form')!
    );
  }

  it('converts human and decimal percentages exactly once for preview and publication', () => {
    render(<RestaurantTaxConsole />);
    submitCustomRates(['16', '8', '15.5']);

    expect(mocks.previewCustom).toHaveBeenLastCalledWith(
      { amount: '1000.00', rate: '0.16', priceMode: 'EXCLUSIVE' },
      { enabled: true }
    );
    expect(screen.getByText(/Net 1000.00 · Tax 0.00 · Total 1000.00/)).toBeInTheDocument();
    expect(mocks.publishCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch_1',
        profileName: 'Custom 2026',
        effectiveFrom: '2026-08-30',
        approvalReference: 'Memo 93',
        accountantConfirmation: true,
        rates: [
          { paymentCategory: 'CASH', rate: '0.16' },
          { paymentCategory: 'CARD', rate: '0.08' },
          { paymentCategory: 'OTHER', rate: '0.155' },
        ],
      })
    );
  });

  it.each([
    ['8.25', '0.0825'],
    ['16.67', '0.1667'],
    ['99.99', '0.9999'],
  ])('preserves exact decimal digits when converting %s%%', (percentage, decimal) => {
    render(<RestaurantTaxConsole />);
    submitCustomRates([percentage, '8', '15']);

    expect(mocks.previewCustom).toHaveBeenLastCalledWith(
      { amount: '1000.00', rate: decimal, priceMode: 'EXCLUSIVE' },
      { enabled: true }
    );
    expect(mocks.publishCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        rates: expect.arrayContaining([{ paymentCategory: 'CASH', rate: decimal }]),
      })
    );
  });

  it('rejects more than two decimal places before preview or publication', () => {
    render(<RestaurantTaxConsole />);
    submitCustomRates(['8.251', '8', '15']);

    expect(customRateInput('Cash')).toHaveAttribute('aria-invalid', 'true');
    expect(customRateInput('Cash')).toHaveAccessibleDescription(
      'Tax rate percentage can have at most two decimal places.'
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Tax rate percentage can have at most two decimal places.'
    );
    expect(mocks.previewCustom).toHaveBeenLastCalledWith(
      { amount: '1000.00', rate: '0', priceMode: 'EXCLUSIVE' },
      { enabled: false }
    );
    expect(screen.queryByText(/Net 1000.00 · Tax 0.00 · Total 1000.00/)).not.toBeInTheDocument();
    expect(mocks.publishCustom).not.toHaveBeenCalled();
  });

  it('hides a cached zero-rate preview when the current Cash rate becomes invalid', () => {
    render(<RestaurantTaxConsole />);
    fireEvent.change(customRateInput('Cash'), { target: { value: '0' } });

    expect(mocks.previewCustom).toHaveBeenLastCalledWith(
      { amount: '1000.00', rate: '0', priceMode: 'EXCLUSIVE' },
      { enabled: true }
    );
    expect(screen.getByText(/Net 1000.00 · Tax 0.00 · Total 1000.00/)).toBeInTheDocument();

    fireEvent.change(customRateInput('Cash'), { target: { value: 'not-a-rate' } });
    fireEvent.blur(customRateInput('Cash'));

    expect(mocks.previewCustom).toHaveBeenLastCalledWith(
      { amount: '1000.00', rate: '0', priceMode: 'EXCLUSIVE' },
      { enabled: false }
    );
    expect(customRateInput('Cash')).toHaveAccessibleDescription('Enter a valid number.');
    expect(screen.queryByText(/Net 1000.00 · Tax 0.00 · Total 1000.00/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Enter a valid sample amount and Cash rate to preview settlement.')
    ).toBeInTheDocument();
  });

  it.each([
    ['', 'Enter a tax rate percentage.'],
    ['abc', 'Enter a valid number.'],
    ['-0.1', 'Tax rate percentage cannot be negative.'],
    ['100.01', 'Tax rate percentage cannot exceed 100.'],
  ])('shows accessible inline feedback for invalid rate %j', (value, message) => {
    render(<RestaurantTaxConsole />);
    fireEvent.change(customRateInput('Cash'), { target: { value } });
    fireEvent.blur(customRateInput('Cash'));

    expect(customRateInput('Cash')).toHaveAttribute('aria-invalid', 'true');
    expect(customRateInput('Cash')).toHaveAccessibleDescription(message);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(mocks.publishCustom).not.toHaveBeenCalled();
  });

  it.each(['0', '100', '8.25'])('accepts inclusive boundary or decimal percentage %s', (value) => {
    render(<RestaurantTaxConsole />);
    fireEvent.change(customRateInput('Cash'), { target: { value } });
    fireEvent.blur(customRateInput('Cash'));

    expect(customRateInput('Cash')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

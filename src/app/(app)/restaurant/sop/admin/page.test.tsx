/**
 * WHA-266 — the SOP console must tell "your plan does not include this" apart
 * from "the quota your plan includes is used up". They have different causes,
 * different remedies, and must never render as the same amber warning.
 *
 * These cover the view and the two pure resolvers only; enforcement itself
 * lives in the router/limit catalog and is tested there.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

import {
  SopAdminView,
  resolveSopEntitlement,
  resolveTemplateCapacity,
  type SopAdminViewProps,
} from './page';

vi.mock('@/lib/trpc', () => ({ trpc: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function entitlementView(overrides: Partial<EntitlementView> = {}): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 3,
    enabledModules: [],
    modules: [],
    limits: {},
    ...overrides,
  };
}

const template = {
  id: 'tpl_1',
  organizationId: 'org_1',
  name: 'Opening checklist',
  description: null,
  category: 'Front of house',
  isActive: true,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  versions: [],
} as unknown as SopAdminViewProps['templates'][number];

const archivedTemplate = {
  ...template,
  id: 'tpl_2',
  name: 'Closing checklist',
  isActive: false,
} as unknown as SopAdminViewProps['templates'][number];

function renderView(overrides: Partial<SopAdminViewProps> = {}) {
  const props: SopAdminViewProps = {
    entitlement: { status: 'granted', templateLimit: 25 },
    templates: [],
    assignments: [],
    selectedTemplateId: '',
    selectedVersionId: '',
    version: null,
    state: 'ready',
    onRetry: vi.fn(),
    onSelectTemplate: vi.fn(),
    onSelectVersion: vi.fn(),
    onCreateTemplate: vi.fn(),
    onSetTemplateActive: vi.fn(),
    onCreateDraft: vi.fn(),
    onPublishVersion: vi.fn(),
    onAddStep: vi.fn(),
    onUpdateStep: vi.fn(),
    onRemoveStep: vi.fn(),
    onReorderSteps: vi.fn(),
    onCreateAssignment: vi.fn(),
    onToggleAssignment: vi.fn(),
    ...overrides,
  };
  return render(<SopAdminView {...props} />);
}

describe('resolveSopEntitlement', () => {
  it('reports not-in-plan when the module is absent from the catalog entirely', () => {
    expect(resolveSopEntitlement(entitlementView())).toEqual({
      status: 'unavailable',
      reason: 'not-in-plan',
    });
  });

  it('reports not-in-plan when the module is present but ungranted', () => {
    const view = entitlementView({
      modules: [
        {
          key: 'restaurant-sop',
          name: 'SOP & Compliance',
          enabled: false,
          source: 'NONE',
          seatLimit: null,
          expiresAt: null,
        },
      ],
    });
    expect(resolveSopEntitlement(view)).toEqual({
      status: 'unavailable',
      reason: 'not-in-plan',
    });
  });

  it('distinguishes an administrative override from a plan that never included it', () => {
    const view = entitlementView({
      modules: [
        {
          key: 'restaurant-sop',
          name: 'SOP & Compliance',
          enabled: false,
          source: 'OVERRIDE',
          seatLimit: null,
          expiresAt: null,
        },
      ],
    });
    expect(resolveSopEntitlement(view)).toEqual({
      status: 'unavailable',
      reason: 'administratively-disabled',
    });
  });

  it('returns the published limit when the module is granted', () => {
    const view = entitlementView({
      enabledModules: ['restaurant-sop'],
      limits: { 'sop.templates.max': 25 },
    });
    expect(resolveSopEntitlement(view)).toEqual({ status: 'granted', templateLimit: 25 });
  });

  it('returns a null limit — not 0 — when the module is granted but no limit is published', () => {
    const view = entitlementView({ enabledModules: ['restaurant-sop'] });
    expect(resolveSopEntitlement(view)).toEqual({ status: 'granted', templateLimit: null });
  });
});

describe('resolveTemplateCapacity', () => {
  it('treats an absent limit as unmeasured rather than as a zero quota', () => {
    expect(resolveTemplateCapacity(null, 4)).toEqual({ kind: 'unmeasured' });
  });

  it('reports exhausted once the active count reaches the limit', () => {
    expect(resolveTemplateCapacity(5, 5)).toEqual({ kind: 'exhausted', activeCount: 5, limit: 5 });
  });

  it('reports remaining slots below the limit', () => {
    expect(resolveTemplateCapacity(5, 2)).toEqual({
      kind: 'available',
      activeCount: 2,
      limit: 5,
      remaining: 3,
    });
  });
});

describe('SopAdminView — unavailable is not exhausted', () => {
  it('offers a commercial remedy and denies that a quota is involved when not in plan', () => {
    renderView({ entitlement: { status: 'unavailable', reason: 'not-in-plan' } });

    expect(screen.getByText('SOP & Compliance is not included in your plan')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This feature is not included in your organization’s current plan. Contact your administrator or DevFathom sales to enable it.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/This is not a usage limit/)).toBeInTheDocument();

    // The exhausted vocabulary and the authoring surface must be absent.
    expect(screen.queryByText(/Limit reached/)).not.toBeInTheDocument();
    expect(screen.queryByText(/free a slot/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create template/ })).not.toBeInTheDocument();
  });

  it('uses different copy when a granted module was switched off administratively', () => {
    renderView({ entitlement: { status: 'unavailable', reason: 'administratively-disabled' } });

    expect(
      screen.getByText('SOP & Compliance is turned off for this organization')
    ).toBeInTheDocument();
    expect(screen.getByText(/Contact your platform administrator/)).toBeInTheDocument();
    expect(
      screen.queryByText(/not included in your organization’s current plan/)
    ).not.toBeInTheDocument();
  });

  it('never renders an unavailable plan as the amber warning used for exhaustion', () => {
    const { container: unavailable } = renderView({
      entitlement: { status: 'unavailable', reason: 'not-in-plan' },
    });
    const unavailableTones = Array.from(
      unavailable.querySelectorAll('[data-slot="status-pill"]')
    ).map((pill) => pill.getAttribute('data-tone'));
    expect(unavailableTones).not.toContain('warning');
    expect(unavailableTones).toContain('neutral');

    const { container: exhausted } = renderView({
      entitlement: { status: 'granted', templateLimit: 1 },
      templates: [template],
    });
    const exhaustedTones = Array.from(exhausted.querySelectorAll('[data-slot="status-pill"]')).map(
      (pill) => pill.getAttribute('data-tone')
    );
    expect(exhaustedTones).toContain('warning');
  });
});

describe('SopAdminView — exhausted quota', () => {
  it('names the limit and points at the in-app remedy', () => {
    renderView({ entitlement: { status: 'granted', templateLimit: 1 }, templates: [template] });

    const note = screen.getByText(/Create is disabled/);
    expect(note).toHaveTextContent(
      'Create is disabled: the 1 active template slot included in your plan is in use. Archive an active template below to free a slot.'
    );
    expect(screen.getAllByText(/Limit reached · 1 of 1 active/).length).toBeGreaterThan(0);
  });

  it('uses the plural slot noun above a limit of one', () => {
    renderView({
      entitlement: { status: 'granted', templateLimit: 2 },
      templates: [template, { ...template, id: 'tpl_3', name: 'Prep checklist' }],
    });
    expect(screen.getByText(/Create is disabled/)).toHaveTextContent(
      'Create is disabled: all 2 active template slots included in your plan are in use. Archive an active template below to free a slot.'
    );
  });

  it('disables the create form and blocks reactivating an archived template', () => {
    renderView({
      entitlement: { status: 'granted', templateLimit: 1 },
      templates: [template, archivedTemplate],
    });

    expect(screen.getByRole('button', { name: 'Create template' })).toBeDisabled();
    const reactivate = screen.getByRole('button', { name: 'Reactivate' });
    expect(reactivate).toBeDisabled();
    expect(reactivate).toHaveAttribute('aria-describedby', 'template-limit-note');
  });
});

describe('SopAdminView — unpublished limit', () => {
  it('never claims 0 active · 0 allowed when no limit is published', () => {
    const { container } = renderView({
      entitlement: { status: 'granted', templateLimit: null },
      templates: [],
    });

    expect(container.textContent).not.toContain('0 active · 0 allowed');
    expect(container.textContent).not.toContain('0 of 0 active');
    expect(screen.queryByText(/Limit reached/)).not.toBeInTheDocument();

    expect(screen.getAllByText('Capacity unknown').length).toBeGreaterThan(0);
    expect(screen.getByText(/Create is disabled/)).toHaveTextContent(
      'Create is disabled: your plan has not published an active-template limit, so capacity cannot be confirmed. Contact your administrator to publish sop.templates.max.'
    );
  });

  it('fails closed on an unpublished limit, matching the router', () => {
    renderView({ entitlement: { status: 'granted', templateLimit: null }, templates: [] });
    expect(screen.getByRole('button', { name: 'Create template' })).toBeDisabled();
  });
});

describe('SopAdminView — available capacity', () => {
  it('reports remaining slots and keeps create enabled', () => {
    renderView({ entitlement: { status: 'granted', templateLimit: 3 }, templates: [template] });

    expect(screen.getByText('2 active template slots remaining.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create template' })).toBeEnabled();
    expect(screen.getAllByText('1 of 3 active').length).toBeGreaterThan(0);
  });

  it('uses the singular slot noun at one remaining', () => {
    renderView({ entitlement: { status: 'granted', templateLimit: 2 }, templates: [template] });
    expect(screen.getByText('1 active template slot remaining.')).toBeInTheDocument();
  });

  it('states the capacity in words so the pill is not colour-only', () => {
    const { container } = renderView({
      entitlement: { status: 'granted', templateLimit: 3 },
      templates: [template],
    });
    const pill = container.querySelector('[data-slot="status-pill"]');
    expect(pill).toHaveAttribute('data-tone', 'success');
    expect(within(pill as HTMLElement).getByText('1 of 3 active')).toBeInTheDocument();
  });
});

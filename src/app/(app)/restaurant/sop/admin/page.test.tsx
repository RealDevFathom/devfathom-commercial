import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantStaff: {
      listBranches: {
        useQuery: () => ({
          data: [
            {
              id: 'branch_1',
              name: 'Downtown',
              timezone: 'Asia/Karachi',
              active: true,
              isDefault: true,
            },
          ],
          error: null,
          isLoading: false,
        }),
      },
      listDirectory: {
        useQuery: () => ({
          data: [{ id: 'staff_1', displayName: 'Shift Lead', role: 'Manager' }],
          error: null,
          isLoading: false,
        }),
      },
    },
  },
}));
vi.mock('@/components/entitlements-provider', () => ({ useEntitlements: () => ({}) }));

import { SopAdminView, type SopAdminViewProps } from './sop-admin';

type Template = SopAdminViewProps['templates'][number];

function template(overrides: Partial<Template> = {}): Template {
  return {
    id: 'tpl_1',
    name: 'Opening checklist',
    category: 'Front of house',
    description: 'Daily open',
    isActive: true,
    versions: [],
    ...overrides,
  } as Template;
}

const noop = () => {};

function renderView(overrides: Partial<SopAdminViewProps> = {}) {
  const props: SopAdminViewProps = {
    moduleEnabled: true,
    moduleSource: 'PACKAGE',
    templateLimit: 10,
    templates: [],
    assignments: [],
    jobRoles: [],
    selectedTemplateId: '',
    selectedVersionId: '',
    version: null,
    state: 'ready',
    onRetry: noop,
    onSelectTemplate: noop,
    onSelectVersion: noop,
    onCreateTemplate: noop,
    onSetTemplateActive: noop,
    onCreateDraft: noop,
    onPublishVersion: noop,
    onAddStep: noop,
    onUpdateStep: noop,
    onRemoveStep: noop,
    onReorderSteps: noop,
    onCreateAssignment: noop,
    onToggleAssignment: noop,
    ...overrides,
  };
  return render(<SopAdminView {...props} />);
}

function limitNote() {
  const note = document.getElementById('template-limit-note');
  if (!note) throw new Error('template-limit-note is missing');
  return note;
}

/** The create-template fieldset, disambiguated from other groups on the page. */
function createFieldset() {
  const fieldset = document.querySelector('#new-template fieldset');
  if (!fieldset) throw new Error('create-template fieldset is missing');
  return fieldset;
}

/** StatusPill renders `label` in place of `status`, so assert on the pill node. */
function pill(text: string | RegExp) {
  return screen.getByText(text, { selector: '[data-slot="status-pill"]' });
}

function pills(text: string | RegExp) {
  return screen.getAllByText(text, { selector: '[data-slot="status-pill"]' });
}

describe('SOP admin entitlement states', () => {
  describe('unavailable — the plan does not include the module', () => {
    it('names the plan boundary and offers a route to obtain the module', () => {
      renderView({ moduleEnabled: false, moduleSource: 'NONE' });

      expect(screen.getByText('SOP & Compliance is not in this plan')).toBeInTheDocument();
      expect(pill('Not in plan')).toHaveAttribute('data-tone', 'neutral');
      expect(
        screen.getByText(/current plan does not include SOP & Compliance/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/DevFathom sales/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /review plan & modules/i })).toHaveAttribute(
        'href',
        '/organization'
      );
    });

    it('does not reuse the exhausted-quota vocabulary', () => {
      renderView({ moduleEnabled: false, moduleSource: 'NONE' });

      expect(screen.queryByText(/quota is fully used/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/limit reached/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/0 allowed/i)).not.toBeInTheDocument();
    });

    it('treats a granted-then-disabled module as a separate administrative state', () => {
      renderView({ moduleEnabled: false, moduleSource: 'OVERRIDE' });

      expect(screen.getByText('SOP & Compliance is turned off')).toBeInTheDocument();
      expect(pill('Disabled')).toHaveAttribute('data-tone', 'warning');
      expect(
        screen.getByText(/included in your plan but is currently switched off/i)
      ).toBeVisible();
      expect(screen.queryByText('Not in plan')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: /review plan & modules/i })
      ).not.toBeInTheDocument();
    });
  });

  describe('exhausted — the included quota is used up', () => {
    it('reports the used quota with an in-product remedy, not a sales remedy', () => {
      renderView({ templateLimit: 2, templates: [template({ id: 'a' }), template({ id: 'b' })] });

      expect(pill(/^Limit reached · 2 \/ 2 active$/)).toHaveAttribute('data-tone', 'warning');
      expect(pill(/^Quota used · 2 of 2 allowed$/)).toHaveAttribute('data-tone', 'warning');
      expect(limitNote()).toHaveTextContent(
        /quota is fully used \(2 of 2\)\. Archive an active template below to free a slot\./i
      );
      expect(screen.queryByText(/not in this plan/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/DevFathom sales/i)).not.toBeInTheDocument();
    });

    it('reports remaining capacity while the quota still has room', () => {
      renderView({ templateLimit: 3, templates: [template()] });

      expect(pill(/^Capacity · 1 \/ 3 active$/)).toHaveAttribute('data-tone', 'info');
      expect(pill(/^Available · 1 of 3 allowed$/)).toHaveAttribute('data-tone', 'success');
      expect(limitNote()).toHaveTextContent('2 active template slots remaining.');
    });
  });

  describe('disabled — the plan explicitly grants zero templates', () => {
    it('presents a deliberate plan disable without the exhausted-quota remedy', () => {
      renderView({ templateLimit: 0, templates: [template()] });

      expect(pill('Plan allowance · 0 allowed')).toHaveAttribute('data-tone', 'neutral');
      expect(pill('Disabled · 1 active · 0 allowed')).toHaveAttribute('data-tone', 'neutral');
      expect(createFieldset()).toBeDisabled();
      expect(limitNote()).toHaveAttribute('data-capacity', 'disabled');
      expect(limitNote()).toHaveTextContent(/plan deliberately disables active SOP templates/i);
      expect(limitNote()).not.toHaveTextContent(/archive an active template/i);
      expect(screen.queryByText(/not configured/i)).not.toBeInTheDocument();
    });
  });

  describe('unconfigured — the platform never set the limit', () => {
    it('never renders a missing limit as a zero allowance', () => {
      renderView({ templateLimit: undefined, templates: [] });

      expect(screen.queryByText(/0 active · 0 allowed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/0 \/ 0 active/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/allowed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Limit reached/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Quota used/i)).not.toBeInTheDocument();
    });

    it('presents the absent limit as a configuration fault with its own tone', () => {
      renderView({ templateLimit: undefined, templates: [template()] });

      expect(pill(/^Limit not set · 1 active$/)).toHaveAttribute('data-tone', 'danger');
      expect(pill(/^Not configured · 1 active$/)).toHaveAttribute('data-tone', 'danger');
      expect(limitNote()).toHaveTextContent(
        /not configured for this plan.*this is a configuration fault, not a used-up quota/i
      );
    });

    it('fails closed without claiming the quota was spent', () => {
      renderView({ templateLimit: undefined, templates: [template({ isActive: false })] });

      expect(screen.getByRole('textbox', { name: /name/i })).toBeDisabled();
      const row = screen.getByRole('button', { name: /reactivate/i });
      expect(row).toBeDisabled();
      expect(row).toHaveAttribute('aria-describedby', 'template-limit-note');
      expect(limitNote()).toHaveTextContent(/configuration fault/i);
    });
  });

  describe('state separation', () => {
    it('gives unavailable, exhausted, and unconfigured three different tones', () => {
      const tones = new Set<string>();

      const unavailable = renderView({ moduleEnabled: false, moduleSource: 'NONE' });
      tones.add(pill('Not in plan').getAttribute('data-tone') ?? '');
      unavailable.unmount();

      const exhausted = renderView({ templateLimit: 1, templates: [template()] });
      tones.add(pill(/^Limit reached/).getAttribute('data-tone') ?? '');
      exhausted.unmount();

      renderView({ templateLimit: undefined, templates: [template()] });
      tones.add(pills(/not set|not configured/i)[0]!.getAttribute('data-tone') ?? '');

      expect(tones).toEqual(new Set(['neutral', 'warning', 'danger']));
    });

    it('keeps the create form usable only when the plan actually grants room', () => {
      const { unmount } = renderView({ templateLimit: 5, templates: [template()] });
      expect(createFieldset()).not.toBeDisabled();
      unmount();

      renderView({ templateLimit: 1, templates: [template()] });
      expect(createFieldset()).toBeDisabled();
    });
  });
});

describe('SOP interval recurrence authoring', () => {
  it('shows unit, weekday, minimum, end-time, and preview controls', () => {
    renderView({
      templates: [template()],
      selectedTemplateId: 'tpl_1',
      jobRoles: [{ id: 'role_1', key: 'manager', name: 'Manager' }],
    });

    fireEvent.change(selectFieldControl(screen.getByLabelText('Frequency', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'INTERVAL' } });

    expect(screen.getByLabelText('Every', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('min', '15');
    expect(selectFieldControl(screen.getByLabelText('Interval unit', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('minutes');
    expect(screen.getByText('Days of week · required')).toBeVisible();
    expect(screen.getByLabelText('Start time', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeRequired();
    expect(screen.getByLabelText('End time', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeRequired();
    expect(screen.getByRole('button', { name: 'Preview schedule' })).toBeEnabled();
  });

  it('renders the exact concise branch-timezone preview line', () => {
    renderView({
      templates: [template()],
      selectedTemplateId: 'tpl_1',
      previewBranchId: 'branch_1',
      schedulePreview: Array.from({ length: 14 }, (_, index) => ({
        businessDate: '2026-01-01',
        dueAt: new Date(Date.UTC(2026, 0, 1, 5 + index)),
        windowEndsAt: new Date(Date.UTC(2026, 0, 1, 6 + index)),
        adjustment: 'none' as const,
      })),
    });
    expect(screen.getByText('Next: 10:00, 11:00, 12:00 … (14 today) · Asia/Karachi')).toBeVisible();
  });
});

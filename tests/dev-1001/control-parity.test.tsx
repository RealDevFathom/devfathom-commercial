import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState, type ChangeEvent, type SelectHTMLAttributes } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { computeAccessibleName } from 'dom-accessibility-api';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelectField } from '@/components/ui/select-field';
import manifest from './control-fixtures.json';

type Fixture = (typeof manifest.controls)[number];
const sourceFiles = new Map<string, ts.JsxElement[]>();
for (const { file } of manifest.controls) {
  if (sourceFiles.has(file)) continue;
  const parsed = ts.createSourceFile(
    file,
    readFileSync(join(process.cwd(), file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const controls: ts.JsxElement[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxElement(node) &&
      ['select', 'StudioSelect'].includes(node.openingElement.tagName.getText(parsed))
    ) {
      controls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  sourceFiles.set(file, controls);
}

function normalized(source: string) {
  const parsed = ts.createSourceFile(
    'control.tsx',
    source.replace(/<(\/?)StudioSelect\b/g, '<$1select'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  function shape(node: ts.Node): unknown {
    const children: unknown[] = [];
    ts.forEachChild(node, (child) => {
      children.push(shape(child));
    });
    const text = ts.isJsxText(node)
      ? node.text.replace(/\s+/g, ' ').trim()
      : ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
        ? node.text
        : undefined;
    // JSX indentation/line wrapping is presentation-neutral. Preserve string
    // literal values exactly, including whitespace inside value/name strings.
    return [
      node.kind,
      text,
      ...children.filter((child) => {
        const entry = child as unknown[];
        return !(entry[0] === ts.SyntaxKind.JsxText && entry[1] === '');
      }),
    ];
  }
  return shape(parsed);
}

function associatedLabel(node: ts.JsxElement) {
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor) {
    if (
      ts.isJsxElement(ancestor) &&
      ['label', 'Field'].includes(ancestor.openingElement.tagName.getText())
    )
      return ancestor;
    ancestor = ancestor.parent;
  }
  const attr = (element: ts.JsxElement, name: string) =>
    element.openingElement.attributes.properties.find(
      (attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText() === name
    );
  const id = attr(node, 'id')?.initializer?.getText();
  if (!id) return undefined;
  let found: ts.JsxElement | undefined;
  function visit(current: ts.Node) {
    if (
      ts.isJsxElement(current) &&
      current.openingElement.tagName.getText() === 'label' &&
      attr(current, 'htmlFor')?.initializer?.getText() === id
    )
      found ??= current;
    ts.forEachChild(current, visit);
  }
  visit(node.getSourceFile());
  return found;
}

function ControlFixture({
  fixture,
  shared,
  changed,
  captureRef,
}: {
  fixture: Fixture;
  shared: boolean;
  changed: (event: ChangeEvent<HTMLSelectElement>) => void;
  captureRef?: (element: HTMLSelectElement | null) => void;
}) {
  const [value, setValue] = useState(fixture.initial);
  const props: SelectHTMLAttributes<HTMLSelectElement> = {
    ...(fixture.props as SelectHTMLAttributes<HTMLSelectElement>),
    ...(fixture.controlled
      ? { value }
      : fixture.defaulted
        ? { defaultValue: fixture.initial }
        : {}),
    onChange(event) {
      changed(event);
      if (fixture.controlled) setValue(event.currentTarget.value);
    },
  };
  const children = fixture.options.map((option) => (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  ));
  const control = shared ? (
    <SelectField {...props} ref={fixture.referenced ? captureRef : undefined}>
      {children}
    </SelectField>
  ) : (
    <select {...props} ref={fixture.referenced ? captureRef : undefined}>
      {children}
    </select>
  );
  return (
    <form id="fixture-form" aria-label="Control boundary fixture">
      <button type="button">Before control</button>
      {fixture.label.mode === 'wrapped' ? (
        <label>
          <span>{fixture.label.text}</span>
          {control}
        </label>
      ) : (
        <>
          {fixture.label.mode === 'for' && <label htmlFor={props.id}>{fixture.label.text}</label>}
          {fixture.label.mode === 'aria-labelledby' && (
            <label id="fixture-label">{fixture.label.text}</label>
          )}
          {control}
        </>
      )}
      {props['aria-describedby'] && <p id="fixture-help">Local validation help</p>}
      <button type="button">After control</button>
      <button type="reset">Reset</button>
    </form>
  );
}

function formValues() {
  return Array.from(new FormData(screen.getByRole('form') as HTMLFormElement).entries());
}

afterEach(cleanup);

// These fixtures exercise each actual call site's boundary contract using local data.
// The frozen JSX guard also protects expressions/callbacks that require page context;
// this suite deliberately does not claim to exercise server actions or page data loading.
describe('DEV-1001: every baseline native select is accounted for', () => {
  it('covers 377 in-scope controls with 367 migrations and 10 explicit native exceptions', () => {
    expect(manifest.base).toBe('002b84ee1ca72880cee1f0ffebf4cdd79d343236');
    expect(manifest.controls).toHaveLength(377);
    expect(manifest.controls.filter((fixture) => fixture.disposition === 'migrated')).toHaveLength(
      367
    );
    expect(manifest.controls.filter((fixture) => fixture.disposition === 'retained')).toHaveLength(
      10
    );
  });

  for (const fixture of manifest.controls) {
    it(`${fixture.key}: preserves all original props, option templates and callbacks`, () => {
      const node = sourceFiles.get(fixture.file)?.[fixture.ordinal];
      expect(node, fixture.key).toBeDefined();
      const tag = node!.openingElement.tagName.getText();
      expect(tag).toBe(fixture.disposition === 'migrated' ? 'StudioSelect' : 'select');
      expect(normalized(node!.getText())).toEqual(normalized(fixture.source));
      if (fixture.labelSource) {
        expect(normalized(associatedLabel(node!)!.getText())).toEqual(
          normalized(fixture.labelSource)
        );
      }
    });
  }
});

describe('DEV-1001: per-control native/shared value, label and keyboard parity', () => {
  for (const fixture of manifest.controls.filter((entry) => entry.disposition === 'migrated')) {
    it(`${fixture.key}: ${fixture.label.text || 'unnamed control'}`, async () => {
      const nativeChanged = vi.fn();
      const captureRef = vi.fn();
      const before = render(
        <ControlFixture
          fixture={fixture}
          shared={false}
          changed={nativeChanged}
          captureRef={captureRef}
        />
      );
      const native = screen.getByRole('combobox') as HTMLSelectElement;
      if (fixture.referenced) expect(captureRef).toHaveBeenLastCalledWith(native);
      const expectedName = computeAccessibleName(native);
      const initialValue = native.value;
      const initialLabel = native.selectedOptions[0]?.textContent ?? '';
      const initialFormData = formValues();
      const initialValidity = native.validity.valid;
      const initialDisabled = native.disabled;
      const expectedOptions = Array.from(native.options).map((option) => ({
        value: option.value,
        label: option.textContent,
        disabled: option.disabled,
      }));
      const target = [...expectedOptions].reverse().find((option) => !option.disabled)!;
      expect(target, `Selectable option for ${fixture.key}`).toBeDefined();
      if (!initialDisabled) fireEvent.change(native, { target: { value: target.value } });
      const selectedFormData = formValues();
      act(() => (screen.getByRole('form') as HTMLFormElement).reset());
      const resetValue = native.value;
      const resetLabel = native.selectedOptions[0]?.textContent ?? '';
      const resetFormData = formValues();
      before.unmount();

      const changed = vi.fn();
      const after = render(
        <ControlFixture fixture={fixture} shared changed={changed} captureRef={captureRef} />
      );
      const trigger = screen.getByRole('combobox');
      const bridge = after.container.querySelector<HTMLSelectElement>(
        'select[data-slot="select-native-control"]'
      );
      expect(bridge).not.toBeNull();
      if (fixture.referenced) {
        expect(captureRef).toHaveBeenLastCalledWith(bridge);
        act(() => bridge!.focus());
        expect(trigger).toHaveFocus();
      }
      expect(trigger).toHaveAccessibleName(expectedName);
      expect(trigger).toHaveTextContent(initialLabel);
      expect(bridge).toHaveValue(initialValue);
      expect(formValues()).toEqual(initialFormData);
      expect(bridge!.validity.valid).toBe(initialValidity);
      expect(trigger).toHaveClass('min-h-11', 'min-w-11');
      expect(bridge).toHaveAttribute('aria-hidden', 'true');
      expect(bridge).toHaveAttribute('tabindex', '-1');
      if (fixture.props['aria-describedby']) {
        expect(trigger).toHaveAccessibleDescription('Local validation help');
      }

      if (initialDisabled) {
        expect(trigger).toBeDisabled();
        fireEvent.keyDown(trigger, { key: 'ArrowDown' });
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
        expect(formValues()).toEqual(initialFormData);
      } else {
        act(() => trigger.focus());
        expect(trigger).toHaveFocus();
        fireEvent.keyDown(trigger, { key: 'ArrowDown' });
        await screen.findByRole('listbox');
        const visibleOptions = screen.getAllByRole('option');
        expect(visibleOptions.map((option) => option.textContent)).toEqual(
          expectedOptions.map((option) => option.label)
        );
        for (let index = 0; index < expectedOptions.length; index++) {
          if (expectedOptions[index].disabled)
            expect(visibleOptions[index]).toHaveAttribute('aria-disabled', 'true');
        }
        // End is keyboard navigation. jsdom requires the browser-synthesized
        // Enter click explicitly, matching the repository's shared Select test.
        await waitFor(() => expect(visibleOptions).toContain(document.activeElement));
        fireEvent.keyDown(document.activeElement!, { key: 'End' });
        const targetIndex = expectedOptions.findIndex((option) => option.value === target.value);
        const targetOption = visibleOptions[targetIndex];
        await waitFor(() => expect(targetOption).toHaveFocus());
        fireEvent.keyDown(targetOption, { key: 'Enter' });
        fireEvent.click(targetOption, { detail: 0 });
        await waitFor(() => expect(bridge).toHaveValue(target.value));
        expect(trigger).toHaveTextContent(target.label ?? '');
        expect(formValues()).toEqual(selectedFormData);
        expect(changed).toHaveBeenCalledTimes(target.value !== initialValue ? 1 : 0);
        if (target.value !== initialValue) {
          expect(changed.mock.calls[0][0].target).toBe(bridge);
        }
        fireEvent.keyDown(trigger, { key: 'ArrowDown' });
        await screen.findByRole('listbox');
        fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
        await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
        await waitFor(() => expect(trigger).toHaveFocus());
        expect(trigger).toHaveAccessibleName(expectedName);
      }
      act(() => (screen.getByRole('form') as HTMLFormElement).reset());
      await waitFor(() => {
        expect(bridge).toHaveValue(resetValue);
        expect(formValues()).toEqual(resetFormData);
        expect(trigger).toHaveTextContent(resetLabel);
      });
    });
  }
});

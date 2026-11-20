'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './select';

type SelectFieldProps = React.ComponentPropsWithRef<'select'>;

type Option = {
  value: string;
  label: string;
  disabled: boolean;
  hidden: boolean;
  group: string | null;
};

type Snapshot = {
  options: Option[];
  value: string;
  disabled: boolean;
  label: string;
  aria: Record<string, string>;
};

// Technical hiding geometry, not a field appearance recipe. Auth/platform
// styles target native inputs/selects and set logical sizes and minimums; those
// must not enlarge either form bridge after it is visually hidden.
const hiddenControlDimensions: React.CSSProperties = {
  width: '1px',
  height: '1px',
  minWidth: '0px',
  minHeight: '0px',
  maxWidth: '1px',
  maxHeight: '1px',
  inlineSize: '1px',
  blockSize: '1px',
  minInlineSize: '0px',
  minBlockSize: '0px',
  maxInlineSize: '1px',
  maxBlockSize: '1px',
  padding: '0px',
  paddingInline: '0px',
  paddingBlock: '0px',
  borderWidth: '0px',
};

const hiddenNativeStyle: React.CSSProperties = {
  ...hiddenControlDimensions,
  position: 'absolute',
  margin: '-1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

function constrainHiddenInput(input: HTMLInputElement | null) {
  if (input) Object.assign(input.style, hiddenControlDimensions);
}

function labelText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (
    node instanceof Element &&
    (/^(BUTTON|INPUT|SELECT|TEXTAREA|METER|OUTPUT|PROGRESS)$/.test(node.tagName) ||
      node.hasAttribute('data-select-field-error'))
  )
    return '';
  return Array.from(node.childNodes, labelText).join('');
}

/**
 * The Studio Select presentation for existing single-select form controls.
 *
 * The native control remains the single successful form control: it owns native
 * validation, reset, default selection, external form association and change
 * events. This also keeps imperative form helpers working without fabricated
 * React events. Before hydration it is visible and works without JavaScript.
 * After hydration only the shared Select participates in accessibility/focus.
 * Multiple/listbox selects should continue to use their native interaction.
 */
export function SelectField(allProps: SelectFieldProps) {
  const {
    children,
    id,
    className,
    style,
    autoFocus,
    tabIndex,
    title,
    accessKey,
    dir,
    lang,
    onChange,
    onClick,
    onInvalid,
    onFocus,
    ref: forwardedRef,
    ...props
  } = allProps;
  const nativeRef = React.useRef<HTMLSelectElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const generatedId = React.useId();
  const nativeId = id ?? `${generatedId}-native`;
  const errorId = `${generatedId}-error`;
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const snapshotRef = React.useRef<Snapshot | null>(null);
  const [validationMessage, setValidationMessage] = React.useState('');
  const validationMessageRef = React.useRef('');
  const resetSelection = React.useRef<{ value: string; props: SelectFieldProps } | null>(null);
  const resetPending = React.useRef(false);
  const currentProps = React.useRef(allProps);
  React.useImperativeHandle(forwardedRef, () => nativeRef.current!, []);

  const updateValidation = React.useCallback(
    (message: string) => {
      if (validationMessageRef.current === message) return;
      validationMessageRef.current = message;
      setValidationMessage(message);
    },
    [setValidationMessage]
  );

  const sync = React.useCallback(() => {
    const native = nativeRef.current;
    if (!native || resetPending.current) return;
    const next: Snapshot = {
      value: native.value,
      disabled: native.matches(':disabled'),
      label: Array.from(native.labels ?? [])
        .map((label) => labelText(label).trim())
        .join(' '),
      aria: Object.fromEntries(
        Array.from(native.attributes)
          .filter(
            (attribute) => attribute.name.startsWith('aria-') && attribute.name !== 'aria-hidden'
          )
          .map((attribute) => [attribute.name, attribute.value])
      ),
      options: Array.from(native.options, (option) => {
        const group = option.parentElement;
        const inGroup = group instanceof HTMLOptGroupElement;
        return {
          value: option.value,
          label: option.label,
          disabled: option.disabled || (inGroup && group.disabled),
          hidden: option.hidden || (inGroup && group.hidden),
          group: inGroup ? group.label : null,
        };
      }),
    };
    if (JSON.stringify(snapshotRef.current) !== JSON.stringify(next)) {
      snapshotRef.current = next;
      setSnapshot(next);
    }
    if (native.validity.valid) updateValidation('');
  }, [setSnapshot, updateValidation]);

  // Read the actual browser selection, including native fallback to the first
  // enabled option when value/defaultValue is absent or no longer available.
  React.useLayoutEffect(() => {
    currentProps.current = allProps;
    // A parent's opening-focus effect can run while the initial native fallback
    // is still visible. Hand that existing focus to the trigger once it mounts;
    // focusing an already-focused native element would not emit another event.
    if (nativeRef.current === document.activeElement) triggerRef.current?.focus();
    // React normally leaves a controlled native select at its reset selection
    // until its owner renders again. Internal presentation renders must not
    // accidentally reapply the controlled prop earlier than the native control.
    if (resetSelection.current?.props === allProps && nativeRef.current) {
      nativeRef.current.value = resetSelection.current.value;
    } else {
      resetSelection.current = null;
    }
    sync();
  });

  React.useEffect(() => {
    const native = nativeRef.current;
    if (!native) return;
    const form = native.form;
    // A browser reset button can run microtasks before restoring defaultSelected.
    // Read in the next task, after the native default action (also for React's
    // automatic reset after a successful form action).
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const reset = (event: Event) => {
      clearTimeout(resetTimer);
      resetPending.current = true;
      resetTimer = setTimeout(() => {
        resetPending.current = false;
        if (event.defaultPrevented) return;
        updateValidation('');
        resetSelection.current = { value: native.value, props: currentProps.current };
        sync();
      }, 0);
    };
    form?.addEventListener('reset', reset);
    const observer = new MutationObserver(sync);
    observer.observe(native, { childList: true, subtree: true, attributes: true });
    native.labels?.forEach((label) =>
      observer.observe(label, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    );
    return () => {
      clearTimeout(resetTimer);
      resetPending.current = false;
      form?.removeEventListener('reset', reset);
      observer.disconnect();
    };
  }, [props.form, sync, updateValidation]);

  const triggerAttributes = Object.fromEntries(
    Object.entries(props).filter(([key]) => key.startsWith('aria-') || key.startsWith('data-'))
  );
  const nativeProps = Object.fromEntries(
    Object.entries(props).filter(([key]) => !key.startsWith('data-'))
  );
  const describedBy =
    [
      snapshot?.aria['aria-describedby'] ?? props['aria-describedby'],
      validationMessage ? errorId : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const selectedLabel = snapshot?.options.find((option) => option.value === snapshot.value)?.label;

  const items = snapshot?.options.map((option, index) =>
    option.hidden ? null : (
      <SelectItem
        key={`${index}:${option.value}`}
        value={option.value}
        disabled={option.disabled}
        data-value={option.value}
      >
        {option.label}
      </SelectItem>
    )
  );
  const groupedItems: React.ReactNode[] = [];
  snapshot?.options.forEach((option, index) => {
    if (option.group === null) {
      groupedItems.push(items?.[index]);
      return;
    }
    if (index > 0 && snapshot.options[index - 1].group === option.group) return;
    let end = index + 1;
    while (end < snapshot.options.length && snapshot.options[end].group === option.group) end++;
    groupedItems.push(
      <SelectGroup key={`group:${index}`}>
        <SelectLabel>{option.group}</SelectLabel>
        {items?.slice(index, end)}
      </SelectGroup>
    );
  });

  return (
    <>
      <select
        id={nativeId}
        {...(snapshot ? nativeProps : props)}
        ref={nativeRef}
        className={snapshot ? 'sr-only' : className}
        style={snapshot ? hiddenNativeStyle : style}
        autoFocus={snapshot ? undefined : autoFocus}
        tabIndex={snapshot ? -1 : tabIndex}
        title={snapshot ? undefined : title}
        accessKey={snapshot ? undefined : accessKey}
        dir={dir}
        lang={lang}
        aria-hidden={snapshot ? true : props['aria-hidden']}
        data-slot="select-native-control"
        data-select-field-native="true"
        onChange={(event) => {
          resetSelection.current = null;
          onChange?.(event);
          sync();
        }}
        onClick={(event) => {
          onClick?.(event);
          // Label activation still targets the native form control. Focus is
          // redirected below; suppress its browser picker after enhancement.
          if (snapshot) event.preventDefault();
        }}
        onFocus={(event) => {
          if (snapshot && document.activeElement === event.currentTarget) {
            triggerRef.current?.focus();
          }
          onFocus?.(event);
        }}
        onInvalid={(event) => {
          onInvalid?.(event);
          if (!snapshot || event.defaultPrevented) return;
          event.preventDefault();
          updateValidation(event.currentTarget.validationMessage);
          const form = event.currentTarget.form;
          const firstInvalid =
            form &&
            Array.from(form.elements).find(
              (control) =>
                'willValidate' in control &&
                control.willValidate &&
                'validity' in control &&
                !(control.validity as ValidityState).valid
            );
          if (!form || firstInvalid === event.currentTarget) triggerRef.current?.focus();
        }}
      >
        {children}
      </select>
      {snapshot && (
        <Select
          inputRef={constrainHiddenInput}
          value={snapshot.value}
          items={snapshot.options}
          disabled={snapshot.disabled}
          onValueChange={(value) => {
            const native = nativeRef.current;
            if (!native || value === null || native.matches(':disabled') || native.value === value)
              return;
            native.value = value;
            native.dispatchEvent(new Event('input', { bubbles: true }));
            native.dispatchEvent(new Event('change', { bubbles: true }));
            sync();
          }}
        >
          <SelectTrigger
            {...triggerAttributes}
            {...snapshot.aria}
            id={`${generatedId}-trigger`}
            ref={triggerRef}
            className={cn(className, 'min-h-11 min-w-11')}
            style={style}
            autoFocus={autoFocus}
            tabIndex={tabIndex}
            title={title}
            accessKey={accessKey}
            dir={dir}
            lang={lang}
            aria-label={
              snapshot.aria['aria-label'] ??
              (snapshot.aria['aria-labelledby'] ? undefined : snapshot.label || undefined)
            }
            aria-required={props.required || undefined}
            aria-invalid={
              (snapshot.aria['aria-invalid'] as React.AriaAttributes['aria-invalid']) ||
              !!validationMessage ||
              undefined
            }
            aria-describedby={describedBy}
            data-select-field-trigger="true"
            data-native-control={nativeId}
          >
            <SelectValue>{selectedLabel ?? ''}</SelectValue>
          </SelectTrigger>
          <SelectContent
            onKeyDownCapture={(event) => {
              // Base UI intentionally lets disabled menu items receive focus.
              // Native single selects skip them; preserve that navigation here.
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const options = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')
              );
              const current = options.indexOf(event.target as HTMLElement);
              const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
              let next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? options.length - 1
                    : current + direction;
              if (!options[next] || options[next].getAttribute('aria-disabled') !== 'true') return;
              while (
                options[next] &&
                (options[next].getAttribute('aria-disabled') === 'true' || options[next].hidden)
              )
                next += direction;
              event.preventDefault();
              event.stopPropagation();
              options[next]?.focus();
            }}
          >
            {groupedItems}
          </SelectContent>
        </Select>
      )}
      {validationMessage && (
        <span
          id={errorId}
          role="alert"
          className="text-sm text-destructive"
          data-select-field-error
        >
          {validationMessage}
        </span>
      )}
    </>
  );
}

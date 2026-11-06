'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A clean, accessible time picker that replaces the native `<input type="time">`
 * three-column spinner. Value is a 24h `HH:mm` string (matching the native
 * input), but the UI shows friendly 12h labels like "2:00 PM".
 *
 * Times are offered on a 15-minute grid; an off-grid current value is preserved
 * and shown in the list so editing existing data never loses precision.
 */

const STEP_MINUTES = 15;
const MENU_MAX_HEIGHT = 264;

function pad(n: number) {
  return n.toString().padStart(2, '0');
}

/** "14:00" -> "2:00 PM". Returns null for empty/invalid input. */
export function formatTime12h(value: string): string | null {
  if (!value) return null;
  const [hStr, mStr] = value.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${h12}:${pad(m)} ${period}`;
}

function buildOptions(current: string): string[] {
  const opts: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += STEP_MINUTES) {
      opts.push(`${pad(h)}:${pad(m)}`);
    }
  }
  // Preserve a current value that doesn't fall on the 15-minute grid.
  if (current && !opts.includes(current)) {
    opts.push(current);
    opts.sort();
  }
  return opts;
}

interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
  /** Classes for the trigger button so callers can match nearby inputs. */
  className?: string;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  disabled?: boolean;
}

export function TimePicker({
  value,
  onChange,
  className,
  placeholder = 'Select time',
  id,
  disabled,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const options = useMemo(() => buildOptions(value), [value]);
  const selectedIndex = options.indexOf(value);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const placeAbove = spaceBelow < MENU_MAX_HEIGHT + 8 && r.top > spaceBelow;
    setCoords({
      left: r.left,
      width: r.width,
      ...(placeAbove ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, []);

  // Position synchronously before opening so the panel never paints stale.
  const openMenu = useCallback(() => {
    updatePosition();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [updatePosition, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updatePosition();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, updatePosition]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const commit = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (options[activeIndex]) commit(options[activeIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const label = formatTime12h(value);

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-option-${activeIndex}` : undefined}
        onClick={() => !disabled && (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={cn(
          'flex w-full items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      >
        <span className={cn('truncate', !label && 'text-muted-foreground')}>
          {label ?? placeholder}
        </span>
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{
              position: 'fixed',
              left: coords.left,
              width: coords.width,
              top: coords.top,
              bottom: coords.bottom,
              maxHeight: MENU_MAX_HEIGHT,
            }}
            className="z-50 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg ring-1 ring-foreground/5"
          >
            {options.map((opt, i) => {
              const isSelected = opt === value;
              const isActive = i === activeIndex;
              return (
                <button
                  key={opt}
                  type="button"
                  role="option"
                  id={`${listId}-option-${i}`}
                  tabIndex={-1}
                  aria-selected={isSelected}
                  data-index={i}
                  onClick={() => commit(opt)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-sm transition-colors',
                    isActive ? 'bg-secondary' : 'bg-transparent',
                    isSelected ? 'font-semibold text-primary' : 'text-foreground'
                  )}
                >
                  {formatTime12h(opt)}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

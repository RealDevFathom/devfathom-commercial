import { type FormEvent, type KeyboardEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

export type EffectiveMenuItem = {
  id: string;
  displayName: string | null;
  product: { name: string };
  price: string | null;
  available: boolean;
  barcode?: string | null;
  modifierGroups?: Array<{
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number | null;
    options: Array<{ id: string; name: string; priceDelta: string }>;
  }>;
};

export type EffectiveMenuSection = {
  id: string;
  name: string;
  items: EffectiveMenuItem[];
};

export type EffectiveMenu = {
  version?: string;
  publicationId: string;
  channelOpen: boolean;
  menu: { id: string; name: string };
  sections: EffectiveMenuSection[];
};

export type AddMenuItemInput = {
  menuItemId: string;
  quantity: number;
  course: number;
  seatNumber: number | null;
  modifierOptionIds: string[];
};

type MenuGridProps = {
  menu: EffectiveMenu | null;
  pending: boolean;
  onAdd: (input: AddMenuItemInput) => void;
  cacheState?: 'live' | 'cached' | 'stale';
};

export function MenuGrid({ menu, pending, onAdd, cacheState = 'live' }: MenuGridProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [course, setCourse] = useState('1');
  const [seat, setSeat] = useState('');
  const [modifierIds, setModifierIds] = useState<string[]>([]);
  const [modifierError, setModifierError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const sections = (menu?.sections ?? [])
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (!needle) return true;
        const name = (item.displayName ?? item.product.name).toLowerCase();
        return (
          name.includes(needle) || item.barcode?.trim().toLowerCase().includes(needle) === true
        );
      }),
    }))
    .filter((section) => !needle || section.items.length > 0);

  const selected = menu?.sections
    .flatMap((section) => section.items)
    .find((item) => item.id === selectedId);

  function modifierProblem(item: EffectiveMenuItem, modifiers: string[]) {
    for (const group of item.modifierGroups ?? []) {
      const count = group.options.filter((option) => modifiers.includes(option.id)).length;
      if (count < group.minSelect || (group.maxSelect !== null && count > group.maxSelect)) {
        return `${group.name} requires ${group.maxSelect === group.minSelect ? group.minSelect : `${group.minSelect}–${group.maxSelect ?? 'any'}`} selection${group.maxSelect === 1 ? '' : 's'}.`;
      }
    }
    return null;
  }

  function commit(item: EffectiveMenuItem, modifiers: string[]) {
    if (!menu?.channelOpen || !item.available || item.price === null || pending) return;
    const problem = modifierProblem(item, modifiers);
    if (problem) {
      setSelectedId(item.id);
      setModifierError(problem);
      return;
    }
    setModifierError(null);
    onAdd({
      menuItemId: item.id,
      quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
      course: Math.max(1, Number.parseInt(course, 10) || 1),
      seatNumber: seat ? Math.max(1, Number.parseInt(seat, 10) || 1) : null,
      modifierOptionIds: modifiers,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    commit(selected, modifierIds);
  }

  function itemName(item: EffectiveMenuItem) {
    return (item.displayName ?? item.product.name).trim().toLowerCase();
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const visible = sections.flatMap((section) => section.items);
    const selectedVisible = visible.find((candidate) => candidate.id === selectedId);
    if (selectedVisible) {
      commit(selectedVisible, modifierIds);
      return;
    }
    const exact = needle
      ? visible.filter(
          (item) => itemName(item) === needle || item.barcode?.trim().toLowerCase() === needle
        )
      : [];
    if (exact.length === 1) {
      const item = exact[0]!;
      setSelectedId(item.id);
      setModifierIds([]);
      setModifierError(null);
      commit(item, []);
      return;
    }
    const next = visible[0];
    if (!next) return;
    setSelectedId(next.id);
    setModifierIds([]);
    setModifierError(null);
  }

  return (
    <SectionCard
      data-tour="pos-order"
      eyebrow="Effective menu"
      title={menu?.menu.name ?? 'Menu'}
      actions={
        menu ? (
          <div className="flex flex-wrap gap-2">
            <StatusPill
              status={cacheState}
              tone={cacheState === 'live' ? 'success' : 'warning'}
              label={
                cacheState === 'live'
                  ? 'Live catalog'
                  : cacheState === 'cached'
                    ? 'Cached catalog'
                    : 'Stale catalog'
              }
            />
            <StatusPill
              status={menu.channelOpen ? 'open' : 'closed'}
              tone={menu.channelOpen ? 'success' : 'danger'}
              label={menu.channelOpen ? 'Channel open' : 'Channel closed'}
            />
          </div>
        ) : null
      }
      compact
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {!menu ? (
        <p className="text-sm text-text-muted">Unlock terminal to load current published menu.</p>
      ) : menu.sections.length === 0 ? (
        <p className="text-sm text-text-muted">Published menu has no sections.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="shrink-0 space-y-1">
            <Label htmlFor="pos-menu-search">Menu search</Label>
            <Input
              id="pos-menu-search"
              autoFocus
              autoComplete="off"
              value={filter}
              placeholder="Type a dish, then Enter"
              aria-describedby="pos-menu-search-help"
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={onSearchKeyDown}
              className="h-11"
            />
            <p id="pos-menu-search-help" className="text-xs text-text-muted">
              F2 search · Enter add · F9 pay
            </p>
          </div>
          <div className="min-h-24 flex-1 space-y-2 overflow-y-auto">
            {sections.length === 0 ? (
              <p className="text-sm text-text-muted">No dishes match “{filter.trim()}”.</p>
            ) : (
              sections.map((section) => (
                <section key={section.id} aria-labelledby={`menu-section-${section.id}`}>
                  <h3
                    id={`menu-section-${section.id}`}
                    className="mb-1 font-mono text-xs font-semibold tracking-wide text-text-muted uppercase"
                  >
                    {section.name}
                  </h3>
                  {section.items.length === 0 ? (
                    <p className="text-sm text-text-faint">No items in section.</p>
                  ) : (
                    <div className="grid grid-cols-2 items-start gap-1 sm:grid-cols-3 lg:grid-cols-4">
                      {section.items.map((item) => {
                        const name = item.displayName ?? item.product.name;
                        return (
                          <Button
                            data-demo-modifier-item={
                              (item.modifierGroups?.length ?? 0) > 0 ? 'true' : undefined
                            }
                            key={item.id}
                            type="button"
                            variant={selectedId === item.id ? 'default' : 'outline'}
                            aria-pressed={selectedId === item.id}
                            disabled={
                              !item.available || item.price === null || pending || !menu.channelOpen
                            }
                            onClick={() => {
                              setSelectedId(item.id);
                              setModifierIds([]);
                              setModifierError(null);
                            }}
                            className="h-11 min-w-0 justify-between gap-2 px-2 text-left text-sm font-medium shadow-none hover:translate-y-0 active:translate-y-0"
                          >
                            <span className="min-w-0 truncate">{name}</span>
                            <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
                              {!item.available ? '86' : (item.price ?? 'N/A')}
                            </span>
                          </Button>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))
            )}
          </div>

          <form onSubmit={submit} className="shrink-0 space-y-2 border-t border-border-subtle pt-2">
            <p className="text-sm font-semibold text-text-strong">
              {selected ? (selected.displayName ?? selected.product.name) : 'Select an item'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 space-y-1">
                <Label htmlFor="pos-quantity">Quantity</Label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-border-subtle text-sm"
                    onClick={() =>
                      setQuantity((current) =>
                        String(Math.max(1, (Number.parseInt(current, 10) || 1) - 1))
                      )
                    }
                  >
                    −
                  </button>
                  <Input
                    id="pos-quantity"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    className="h-11 text-center tabular-nums"
                  />
                  <button
                    type="button"
                    aria-label="Increase quantity"
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-border-subtle text-sm"
                    onClick={() =>
                      setQuantity((current) => String((Number.parseInt(current, 10) || 1) + 1))
                    }
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pos-course">Course</Label>
                <Input
                  id="pos-course"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={course}
                  onChange={(event) => setCourse(event.target.value)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pos-seat">Seat</Label>
                <Input
                  id="pos-seat"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  placeholder="Optional"
                  value={seat}
                  onChange={(event) => setSeat(event.target.value)}
                  className="h-11"
                />
              </div>
            </div>
            {(selected?.modifierGroups ?? []).map((group) => (
              <fieldset
                data-demo-modifier-group="true"
                key={group.id}
                className="space-y-1 rounded-md border border-border-subtle p-2"
              >
                <legend className="px-1 text-sm font-semibold text-text-strong">
                  {group.name}
                </legend>
                <p className="text-xs text-text-muted">
                  {group.minSelect > 0 ? 'Required' : 'Optional'} · Choose {group.minSelect}
                  {group.maxSelect === group.minSelect ? '' : `–${group.maxSelect ?? 'any'}`}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.options.map((option) => {
                    const checked = modifierIds.includes(option.id);
                    const atMax =
                      group.maxSelect !== null &&
                      group.options.filter((candidate) => modifierIds.includes(candidate.id))
                        .length >= group.maxSelect;
                    return (
                      <label
                        key={option.id}
                        className="flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-2 py-1 text-sm focus-within:ring-3 focus-within:ring-ring/50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={pending || (!checked && atMax)}
                          onChange={() =>
                            setModifierIds((current) =>
                              checked
                                ? current.filter((id) => id !== option.id)
                                : [...current, option.id]
                            )
                          }
                        />
                        <span className="flex-1">{option.name}</span>
                        {option.priceDelta !== '0' && option.priceDelta !== '0.00' ? (
                          <span className="font-mono text-xs tabular-nums">
                            +{option.priceDelta}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            {modifierError ? (
              <p role="alert" className="text-sm text-destructive">
                {modifierError}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={
                !selected?.available || selected.price === null || pending || !menu.channelOpen
              }
              className="h-11 w-full shadow-none hover:translate-y-0 active:translate-y-0"
            >
              {pending ? 'Adding item…' : 'Add to order'}
            </Button>
          </form>
        </div>
      )}
    </SectionCard>
  );
}

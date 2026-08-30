import { type FormEvent, useState } from 'react';

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

  const selected = menu?.sections
    .flatMap((section) => section.items)
    .find((item) => item.id === selectedId);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.available || selected.price === null || pending) return;
    for (const group of selected.modifierGroups ?? []) {
      const count = group.options.filter((option) => modifierIds.includes(option.id)).length;
      if (count < group.minSelect || (group.maxSelect !== null && count > group.maxSelect)) {
        setModifierError(
          `${group.name} requires ${group.maxSelect === group.minSelect ? group.minSelect : `${group.minSelect}–${group.maxSelect ?? 'any'}`} selection${group.maxSelect === 1 ? '' : 's'}.`
        );
        return;
      }
    }
    setModifierError(null);
    onAdd({
      menuItemId: selected.id,
      quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
      course: Math.max(1, Number.parseInt(course, 10) || 1),
      seatNumber: seat ? Math.max(1, Number.parseInt(seat, 10) || 1) : null,
      modifierOptionIds: modifierIds,
    });
  }

  return (
    <SectionCard
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
      className="min-w-0"
    >
      {!menu ? (
        <p className="text-sm text-text-muted">Unlock terminal to load current published menu.</p>
      ) : menu.sections.length === 0 ? (
        <p className="text-sm text-text-muted">Published menu has no sections.</p>
      ) : (
        <div className="space-y-5">
          <div className="space-y-5">
            {menu.sections.map((section) => (
              <section key={section.id} aria-labelledby={`menu-section-${section.id}`}>
                <h3
                  id={`menu-section-${section.id}`}
                  className="mb-2 font-mono text-xs font-semibold tracking-wide text-text-muted uppercase"
                >
                  {section.name}
                </h3>
                {section.items.length === 0 ? (
                  <p className="text-sm text-text-faint">No items in section.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
                    {section.items.map((item) => {
                      const name = item.displayName ?? item.product.name;
                      return (
                        <Button
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
                          className="min-h-11 h-auto min-w-0 justify-between gap-2 px-3 py-2 text-left whitespace-normal"
                        >
                          <span className="min-w-0 truncate">{name}</span>
                          <span className="shrink-0 font-mono text-xs tabular-nums">
                            {!item.available ? '86' : (item.price ?? 'N/A')}
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                )}
              </section>
            ))}
          </div>

          <form onSubmit={submit} className="border-border-subtle space-y-3 border-t pt-4">
            <p className="text-sm font-semibold text-text-strong">
              {selected ? (selected.displayName ?? selected.product.name) : 'Select an item'}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="pos-quantity">Quantity</Label>
                <Input
                  id="pos-quantity"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
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
              <div className="space-y-1.5">
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
                key={group.id}
                className="space-y-2 rounded-lg border border-border-subtle p-3"
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
                        className="flex min-h-11 items-center gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm focus-within:ring-3 focus-within:ring-ring/50"
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
              className="h-11 w-full"
            >
              {pending ? 'Adding item…' : 'Add to order'}
            </Button>
          </form>
        </div>
      )}
    </SectionCard>
  );
}

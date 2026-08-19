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
};

export type EffectiveMenuSection = {
  id: string;
  name: string;
  items: EffectiveMenuItem[];
};

export type EffectiveMenu = {
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
};

function ids(value: string) {
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function MenuGrid({ menu, pending, onAdd }: MenuGridProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [course, setCourse] = useState('1');
  const [seat, setSeat] = useState('');
  const [modifierIds, setModifierIds] = useState('');

  const selected = menu?.sections
    .flatMap((section) => section.items)
    .find((item) => item.id === selectedId);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.available || selected.price === null || pending) return;
    onAdd({
      menuItemId: selected.id,
      quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
      course: Math.max(1, Number.parseInt(course, 10) || 1),
      seatNumber: seat ? Math.max(1, Number.parseInt(seat, 10) || 1) : null,
      modifierOptionIds: ids(modifierIds),
    });
  }

  return (
    <SectionCard
      eyebrow="Effective menu"
      title={menu?.menu.name ?? 'Menu'}
      actions={
        menu ? (
          <StatusPill
            status={menu.channelOpen ? 'open' : 'closed'}
            tone={menu.channelOpen ? 'success' : 'danger'}
            label={menu.channelOpen ? 'Channel open' : 'Channel closed'}
          />
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
                          onClick={() => setSelectedId(item.id)}
                          className="min-h-11 h-auto min-w-0 justify-between gap-2 px-3 py-2 text-left whitespace-normal"
                        >
                          <span className="min-w-0 truncate">{name}</span>
                          <span className="shrink-0 font-mono text-xs tabular-nums">
                            {item.price ?? 'N/A'}
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
            <div className="space-y-1.5">
              <Label htmlFor="pos-modifiers">Modifier option IDs</Label>
              <Input
                id="pos-modifiers"
                value={modifierIds}
                onChange={(event) => setModifierIds(event.target.value)}
                placeholder="option-id-1, option-id-2"
                className="h-11"
              />
              <p className="text-xs leading-5 text-text-faint">
                Modifier option IDs may be entered when supplied by the menu setup.
              </p>
            </div>
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

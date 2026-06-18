'use client';

import Link from 'next/link';
import { useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { FathomMark, Logo } from '@/components/brand/logo';
import { Reveal, Stagger, StaggerItem } from '@/components/motion/reveal';
import { CountUp } from '@/components/motion/count-up';
import { Magnetic } from '@/components/motion/magnetic';

const TRAITS = [
  { k: 'Understated', v: 'We state; we don’t sell. The work speaks.' },
  { k: 'Serious', v: 'Precise, considered, dependable — professional services, not spectacle.' },
  { k: 'Deep', v: 'A fathom is a measure of depth — and of understanding a problem fully.' },
  { k: 'Quietly confident', v: 'Calm on the surface, vast underneath.' },
];

const BRAND_RAMP = [
  { name: 'Abyss', hex: '#0C2E2C', sub: 'deep teal · primary' },
  { name: 'Abyss deep', hex: '#08221F', sub: 'pressed · canvas' },
  { name: 'Brass', hex: '#BC8850', sub: 'the single accent' },
  { name: 'Paper', hex: '#F7F5EF', sub: 'warm neutral · page' },
];

const NEUTRALS = [
  { name: 'Ink', hex: '#161A19', sub: 'foreground' },
  { name: 'Slate', hex: '#6E7570', sub: 'muted text' },
  { name: 'Paper 100', hex: '#EFEBE1', sub: 'sunken / lines' },
  { name: 'Paper white', hex: '#FDFCF8', sub: 'card surface' },
];

const STATS: { value: number; decimals?: number; suffix?: string; label: string }[] = [
  { value: 4, label: 'Movements — Sound · Map · Build · Advise' },
  { value: 3, label: 'Core brand colours — Abyss · Paper · Brass' },
  { value: 2, label: 'Typefaces — Oxanium + IBM Plex' },
  { value: 1.8288, decimals: 4, suffix: ' m', label: 'One fathom, exactly' },
];

export function BrandShowcase() {
  const heroRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.from('[data-b="mark"]', { scale: 0.8, opacity: 0, duration: 0.9 })
        .from('[data-b="title"]', { y: 16, opacity: 0, duration: 0.7 }, '-=0.5')
        .from('[data-b="tag"]', { y: 14, opacity: 0, duration: 0.7 }, '-=0.5');
      gsap.to('[data-b="glow"]', {
        scale: 1.1,
        opacity: 0.85,
        repeat: -1,
        yoyo: true,
        duration: 11,
        ease: 'sine.inOut',
      });
    },
    { scope: heroRef }
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Logo variant="brand" size="sm" />
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back to hub
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section ref={heroRef} className="relative overflow-hidden border-b border-border/60">
        <div
          data-b="glow"
          className="pointer-events-none absolute left-1/2 top-[-4rem] h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]"
        />
        <div className="absolute inset-0 bg-grid opacity-50" />
        <div className="relative mx-auto max-w-5xl px-6 py-24 text-center">
          <div data-b="mark" className="mx-auto mb-8 w-fit">
            <FathomMark className="h-20 w-20" variant="brand" />
          </div>
          <h1
            data-b="title"
            className="font-display text-5xl font-bold tracking-[-0.04em] sm:text-6xl"
          >
            DevFathom
          </h1>
          <p data-b="tag" className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
            Depth in everything we build. A premium software services and consultancy firm —
            understated, serious, quietly confident.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-5xl space-y-24 px-6 py-20">
        {/* 01 — Essence */}
        <Section label="01 — Essence" title="Quiet confidence, by design">
          <Stagger className="grid gap-4 sm:grid-cols-2">
            {TRAITS.map((t) => (
              <StaggerItem key={t.k}>
                <div className="h-full rounded-2xl border border-border bg-card p-6">
                  <h3 className="font-display text-lg font-semibold">{t.k}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t.v}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </Section>

        {/* 02 — Mark */}
        <Section label="02 — The mark" title="A forward chevron, descending into depth">
          <Stagger className="grid gap-4 sm:grid-cols-3">
            {[
              {
                label: 'App icon',
                node: <FathomMark className="h-16 w-16" variant="brand" />,
                bg: 'bg-card',
              },
              {
                label: 'On abyss',
                node: <FathomMark className="h-16 w-16" variant="white" />,
                bg: 'bg-[#0C2E2C]',
              },
              {
                label: 'On paper',
                node: <FathomMark className="h-16 w-16" variant="dark" />,
                bg: 'bg-[#F7F5EF]',
              },
            ].map((m) => (
              <StaggerItem key={m.label}>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <div className={`flex h-36 items-center justify-center rounded-xl ${m.bg}`}>
                    {m.node}
                  </div>
                  <p className="mt-3 text-center text-xs text-muted-foreground">{m.label}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            A connected chevron of chunky rounded blocks steps down to the lower-left — forward
            motion descending into depth. A detached node rests in the chevron&apos;s mouth,
            carrying the single <span className="text-foreground">brass</span> accent.
          </p>
        </Section>

        {/* 03 — Colour */}
        <Section label="03 — Colour" title="Abyss, paper, and a little brass">
          <Stagger className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {BRAND_RAMP.map((c) => (
              <Swatch key={c.hex} {...c} />
            ))}
          </Stagger>
          <Stagger className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {NEUTRALS.map((c) => (
              <Swatch key={c.hex} {...c} />
            ))}
          </Stagger>
        </Section>

        {/* 04 — Typography */}
        <Section label="04 — Typography" title="Oxanium · IBM Plex Sans">
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card p-8">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
                Display — Oxanium
              </p>
              <p className="mt-3 font-display text-5xl font-bold tracking-[-0.04em]">
                Depth in everything we build.
              </p>
              <p className="mt-4 font-display text-lg text-muted-foreground">
                ABCDEFGHIJKLM · abcdefghijklm · 0123456789
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-8">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
                Body — IBM Plex Sans
              </p>
              <p className="mt-3 max-w-2xl leading-relaxed text-foreground">
                We design, build, and advise on complex software, pairing hands-on engineering with
                deep strategic insight. The work is careful; the surface is calm.
              </p>
            </div>
          </div>
        </Section>

        {/* 05 — Motion */}
        <Section label="05 — Motion" title="It orients, it never performs">
          <Stagger className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {STATS.map((s) => (
              <StaggerItem key={s.label}>
                <div className="h-full rounded-2xl border border-border bg-card p-6">
                  <p className="font-display text-4xl font-bold tracking-tight text-gradient">
                    <CountUp value={s.value} decimals={s.decimals ?? 0} suffix={s.suffix ?? ''} />
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.label}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            GSAP drives ambient timelines; Motion handles component reveals, the sliding sidebar
            indicator, and page transitions. Everything honours{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              prefers-reduced-motion
            </code>
            .
          </p>
          <div className="mt-8">
            <Magnetic className="inline-block">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-[#0C2E2C]"
              >
                Enter the hub <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Magnetic>
          </div>
        </Section>
      </div>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-6 py-12 text-center">
          <FathomMark className="h-8 w-8" variant="brand" />
          <p className="text-sm text-muted-foreground">DevFathom · Depth in everything we build.</p>
        </div>
      </footer>
    </main>
  );
}

function Section({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Reveal>
      <section>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">{label}</p>
        <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">{title}</h2>
        <div className="mt-8">{children}</div>
      </section>
    </Reveal>
  );
}

function Swatch({ name, hex, sub }: { name: string; hex: string; sub: string }) {
  return (
    <StaggerItem>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="h-24" style={{ backgroundColor: hex }} />
        <div className="p-4">
          <p className="text-sm font-semibold">{name}</p>
          <p className="font-mono text-xs text-muted-foreground">{hex}</p>
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>
    </StaggerItem>
  );
}

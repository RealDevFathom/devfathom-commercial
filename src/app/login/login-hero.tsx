'use client';

import { useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { cn } from '@/lib/utils';
import { FathomMark } from '@/components/brand/logo';

const HEADLINE = ['Depth in', 'everything', 'we build.'];

export function LoginHero() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }

      // Calm, restrained entrance — confidence, not spectacle.
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.from('[data-hero="mark"]', { scale: 0.85, opacity: 0, duration: 0.9 })
        .from('[data-hero="word"]', { y: 14, opacity: 0, duration: 0.7 }, '-=0.6')
        .from('[data-hero="badge"]', { y: -10, opacity: 0, duration: 0.6 }, '<')
        .from(
          '[data-hero="line"]',
          { yPercent: 60, opacity: 0, duration: 0.8, stagger: 0.08 },
          '-=0.35'
        )
        .from('[data-hero="sub"]', { y: 12, opacity: 0, duration: 0.7 }, '-=0.45')
        .from('[data-hero="status"]', { y: 10, opacity: 0, duration: 0.6 }, '-=0.45');

      // Slow ambient drift — barely-there movement.
      gsap.to('[data-hero="aurora-1"]', {
        xPercent: 8,
        yPercent: -7,
        scale: 1.08,
        repeat: -1,
        yoyo: true,
        duration: 13,
        ease: 'sine.inOut',
      });
      gsap.to('[data-hero="aurora-2"]', {
        xPercent: -7,
        yPercent: 8,
        scale: 1.06,
        repeat: -1,
        yoyo: true,
        duration: 16,
        ease: 'sine.inOut',
      });
    },
    { scope: root }
  );

  return (
    <div
      ref={root}
      className="relative hidden w-[46%] overflow-hidden border-r border-white/5 lg:flex"
    >
      {/* Aurora — restrained, deep teal */}
      <div className="pointer-events-none absolute inset-0">
        <div
          data-hero="aurora-1"
          className="absolute left-[-12%] top-1/4 h-96 w-96 rounded-full bg-primary/20 blur-[130px]"
        />
        <div
          data-hero="aurora-2"
          className="absolute bottom-[8%] right-[-6%] h-80 w-80 rounded-full bg-[#BC8850]/12 blur-[130px]"
        />
      </div>

      {/* Grid */}
      <div className="absolute inset-0 bg-grid opacity-60" />

      {/* Watermark mark */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <FathomMark className="h-[440px] w-[440px] opacity-[0.05]" variant="white" />
      </div>

      {/* Content */}
      <div className="relative z-10 flex w-full flex-col justify-between p-12">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div data-hero="mark">
              <FathomMark className="h-11 w-11" variant="white" />
            </div>
            <span
              data-hero="word"
              className="font-display text-xl font-semibold tracking-tight text-white"
            >
              DevFathom
            </span>
          </div>
          <span
            data-hero="badge"
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-[#8A97A1]"
          >
            v1.0
          </span>
        </div>

        <div className="max-w-md">
          <h1 className="font-display text-[2.7rem] font-bold leading-[1.05] tracking-[-0.03em] text-white xl:text-[3.1rem]">
            {HEADLINE.map((line, i) => (
              <span key={i} className="block overflow-hidden">
                <span
                  data-hero="line"
                  className={cn('block', i === HEADLINE.length - 1 && 'text-gradient')}
                >
                  {line}
                </span>
              </span>
            ))}
          </h1>
          <p data-hero="sub" className="mt-6 max-w-sm text-base leading-relaxed text-[#8A97A1]">
            Projects, finance, clients, people, and real-time collaboration — one calm workspace for
            the team that designs, builds, and advises.
          </p>
        </div>

        <div data-hero="status" className="flex items-center gap-6 text-sm text-[#5A6670]">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <span>All systems operational</span>
          </div>
          <span>DevFathom · Company hub</span>
        </div>
      </div>
    </div>
  );
}

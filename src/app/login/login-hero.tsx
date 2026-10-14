import { cn } from '@/lib/utils';
import { FathomMark } from '@/components/brand/logo';

const HEADLINE = ['Work with', 'the whole', 'picture.'];

export function LoginHero() {
  return (
    <div className="fieldbook-login-hero animate-fade-in relative hidden min-h-dvh overflow-hidden text-sidebar-accent-foreground lg:flex">
      <div className="fieldbook-login-grid pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute bottom-[-5rem] right-[-6rem] h-[30rem] w-[30rem] border border-white/15" />
      <div className="pointer-events-none absolute bottom-[-1rem] right-[-2rem] h-[18rem] w-[18rem] border border-white/10" />

      {/* Content */}
      <div className="relative z-10 flex w-full flex-col justify-between p-12 xl:p-16">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div data-hero="mark">
              <FathomMark className="h-11 w-11" variant="white" />
            </div>
            <span
              data-hero="word"
              className="font-display text-xl font-semibold tracking-[-0.03em] text-white"
            >
              DevFathom
            </span>
          </div>
          <span
            data-hero="badge"
            className="border border-white/20 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/70"
          >
            Fieldbook / 01
          </span>
        </div>

        <div className="max-w-lg">
          <p className="mb-6 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-sidebar-primary">
            The delivery desk
          </p>
          {/* Brand positioning copy, not the page heading. The single <h1> is the
              sign-in panel's title, which is what the page is actually FOR — and
              this panel is only hidden visually, so a second <h1> here would be
              announced on every viewport. */}
          <p
            aria-hidden="true"
            className="font-display text-[clamp(3rem,5vw,5.5rem)] font-semibold leading-[0.91] tracking-[-0.065em] text-white"
          >
            {HEADLINE.map((line, i) => (
              <span key={i} className="block overflow-hidden">
                <span
                  data-hero="line"
                  className={cn('block', i === HEADLINE.length - 1 && 'text-sidebar-primary')}
                >
                  {line}
                </span>
              </span>
            ))}
          </p>
          <p data-hero="sub" className="mt-7 max-w-sm text-base leading-relaxed text-white/65">
            Projects, finance, clients, and people — each moving part visible before it becomes a
            decision.
          </p>
        </div>

        <div data-hero="status" className="flex items-center gap-6 text-sm text-white/55">
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

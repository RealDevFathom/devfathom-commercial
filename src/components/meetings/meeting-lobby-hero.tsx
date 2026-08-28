import { FathomMark } from '@/components/brand/logo';

/**
 * The ink brand panel of the Studio §7 Authentication split. Desktop only; the
 * lobby collapses to the form on mobile without losing the logo or product
 * context, which the form column renders for small viewports.
 *
 * Everything here is decorative and `aria-hidden` where it would otherwise be
 * announced: the page's single <h1> is the join panel's heading, because that
 * is what the page is FOR. This panel is hidden visually, not from assistive
 * technology, so a second heading here would be read on every viewport.
 *
 * It deliberately says nothing about the meeting. The public id is a locator,
 * not authorization, and this surface renders before any credential is proven.
 */
export function MeetingLobbyHero() {
  return (
    <div className="fieldbook-login-hero relative hidden min-h-dvh overflow-hidden text-sidebar-accent-foreground lg:flex">
      <div className="fieldbook-login-grid pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute right-[-6rem] bottom-[-5rem] h-[30rem] w-[30rem] border border-white/15" />
      <div className="pointer-events-none absolute right-[-2rem] bottom-[-1rem] h-[18rem] w-[18rem] border border-white/10" />

      <div className="relative z-10 flex w-full flex-col justify-between p-12 xl:p-16">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FathomMark className="h-11 w-11" variant="white" />
            <span className="font-display text-xl font-semibold tracking-[-0.03em] text-white">
              DevFathom
            </span>
          </div>
          <span className="border border-white/20 px-3 py-1 font-mono text-[10px] font-semibold tracking-[0.16em] text-white/70 uppercase">
            Fieldbook / meet
          </span>
        </div>

        <div className="max-w-lg">
          <p className="mb-6 font-mono text-[10px] font-semibold tracking-[0.2em] text-sidebar-primary uppercase">
            Secure rooms
          </p>
          <p
            aria-hidden="true"
            className="font-display text-[clamp(3rem,5vw,5.5rem)] leading-[0.91] font-semibold tracking-[-0.065em] text-white"
          >
            <span className="block overflow-hidden">
              <span className="block">Every room</span>
            </span>
            <span className="block overflow-hidden">
              <span className="block text-sidebar-primary">is its own.</span>
            </span>
          </p>
          <p className="mt-7 max-w-sm text-base leading-relaxed text-white/65">
            One link, one occurrence. Access codes expire with the meeting they were issued for.
          </p>
        </div>

        <p className="text-sm text-white/55">DevFathom · Company hub</p>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from 'motion/react';
import { easeOutExpo } from '@/lib/motion';

function easeExpo(t: number) {
  // Mirrors the CSS/Motion expo-out used across DevFathom.
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/**
 * CountUp — animates a number from 0 to `value` when scrolled into view.
 * Uses Motion's useInView to trigger; tweens via rAF for crisp formatting.
 */
export function CountUp({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  duration = 1.4,
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    // Reduced-motion + not-yet-in-view are handled by deriving `shown` during
    // render — no synchronous setState in the effect body.
    if (reduce || !inView) return;

    let raf = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const t = Math.min((now - start) / (duration * 1000), 1);
      setDisplay(value * easeExpo(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, duration, reduce]);

  // Reduced motion shows the final value immediately; otherwise the tweened value.
  const shown = reduce ? value : display;
  const formatted = shown.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span ref={ref} className={className}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

// Keep the ease export referenced for consumers tuning custom tweens.
export { easeOutExpo };

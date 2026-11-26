'use client';

import { useEffect, useRef, useState } from 'react';
import type { PrinterTestFormat } from '@/lib/pharmacy/counter-browser-print';

/** Keep the print document's viewport at paper width, scaling only its on-screen frame. */
export function ReceiptPaperPreview({
  html,
  format,
  title,
}: {
  html: string;
  format: PrinterTestFormat;
  title: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const mm = format === 'A4' ? 210 : format === 'THERMAL_58' ? 58 : 80;
  const scale = available ? Math.min(1, available / ((mm * 96) / 25.4)) : 1;
  return (
    <div
      ref={box}
      className="h-[36rem] w-full overflow-hidden rounded-md border border-border-default bg-surface-sunken"
    >
      <iframe
        sandbox=""
        title={title}
        srcDoc={html}
        className="origin-top-left border-0"
        style={{
          width: mm + 'mm',
          maxWidth: 'none',
          height: 36 / scale + 'rem',
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}

# GitHub issue #255 is already fixed

Verified against the current code at `5a7c353`.

## Evidence

- `src/components/pharmacy/counter/counter-console.tsx:944-947` creates the reproduced
  “1 × … added.” notice with the `success` tone.
- `src/components/pharmacy/counter/counter-console.tsx:1794-1801` gives that success notice a
  `bg-success/10` background, but gives the message itself the `text-text-body` utility rather
  than the insufficient `text-text-muted` color reported in the issue.
- `src/app/globals.css:923-932` defines the relevant light-theme colors as page background
  `#f6f6f3`, body text `#333330`, and muted text `#6c6c68`.
- `src/app/globals.css:272` maps the success color to `--green-600`, which is `#42624a` at
  `src/app/globals.css:221`.

Compositing the 10% success tint (`#42624a`) over the page (`#f6f6f3`) produces the reported
notice background, `#e4e7e2` (allowing for per-channel rounding). The current message foreground
is `#333330`, not `#6c6c68`; its WCAG relative-luminance contrast against `#e4e7e2` is
approximately **10.16:1**, exceeding the required 4.5:1.

No runtime code or migration change is needed.

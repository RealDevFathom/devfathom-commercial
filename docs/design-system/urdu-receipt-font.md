# Urdu receipt font

Noto Nastaliq Urdu variable font, weights 400–700, unmodified upstream TTF.

- Source: https://github.com/google/fonts/blob/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notonastaliqurdu/NotoNastaliqUrdu%5Bwght%5D.ttf
- Revision: `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5`
- Retrieved: 2026-11-17 UTC
- SHA-256: `98a4787f34eb6fde57fb9a1121a8f216301196ab0da98ea110cad581be8abbcd`
- License: SIL Open Font License 1.1; full notice in `public/licenses/noto-nastaliq-urdu-OFL.txt`.

A receipt-only `@font-face` in the root stylesheet serves the app preview. Isolated browser receipts
use the same public asset and wait for `document.fonts.load` before requesting print.
No third-party font request occurs in either flow. English typography is unchanged.
Physical printer acceptance remains outside automated verification.

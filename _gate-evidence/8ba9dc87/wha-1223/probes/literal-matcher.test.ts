import { expect, it } from 'vitest';
import { pharmacyChecklistLinkName } from '../e2e/fixtures/pharmacy-first-sale';
it('escapes literal regex characters in both link and gate', () => {
 const gate='Gate [A]+ (B)? $'; const link='Open .* (setup) [x] + $ ^ | {a} \\';
 const match=pharmacyChecklistLinkName(gate,link);
 expect(match.test(`${link} — ${gate}`)).toBe(true);
 expect(match.test(`${link}—${gate}`)).toBe(true);
 expect(match.test(`Other ${link} — ${gate}`)).toBe(false);
 expect(match.test(`${link} — ${gate} extra`)).toBe(false);
 expect(match.test(`Open anything — ${gate}`)).toBe(false);
});

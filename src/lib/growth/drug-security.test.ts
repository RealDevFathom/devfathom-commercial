import { describe, expect, it } from 'vitest';
import { PROHIBITED_DRUG_NAMES } from './prohibited-drugs';
import { assertMarketingCopyAllowed, bodyNamesProhibitedDrug } from './templates';

const blocked = [
  'Xan٤x', 'Xan۴x', 'Tramadօl', 'Xᴀnax', 'Ꮯodeine', 'Rıtalın', 'Tramadoł',
  'زینیکس', 'treemadol', 'Ativan', '𝐗𝐚𝐧𝐚𝐱', 'Ⓧⓐⓝⓐⓧ', 'Xаnаx',
  'X-a-n-a-x', 'X·a·n·a·x', 'Ⅹanax',
  'Xаnax',
  'Tramadοl',
  'Xánax',
  'Xánax',
  'Tram@d|l',
  'Tramado1',
  'Xannax',
  'Xanaxing',
  'xanaxes',
  'superxanax',
  'زاناكس',
  'زانـاکس',
  'zanax',
  'tramadal',
  'lyreeka',
  'Alprax',
  'Neurontin',
  'Codrex',
  'MS Contin',
  'xan ax',
  'Calmese',
  'Lexotanil',
  'Rivotril',
  'Gabica',
  'Lyrica',
  'Tramal',
  'Ultram',
  'Lithium',
  'Xa\u200bnax',
  'Xa\u200dnax',
  'Xa\u00adnax',
  'Xa\u00a0nax',
  'Xa\u2060nax',
  'Ｘａｎａｘ',
  'X.a.n.a.x',
  'X_a_n_a_x',
  'X💊a💊n💊a💊x',
  'Xa nax',
  'Xa\nnax',
  'زَانَاکس',
  'xan4x',
  'Tramadol',
  'Tramadoi',
  'Tramadol',
  'N€ur0ntin',
  'm$ contin',
  'الپرازولم',
  'ويليم',
  'انسولين',
  'insulin',
  'Kodeen', 'زانیکس', 'لیریکا',
];
describe('PR 175 regression corpus', () => {
  it.each(blocked)('blocks %s', (body) => {
    expect(bodyNamesProhibitedDrug(body, PROHIBITED_DRUG_NAMES)).toBe(true);
  });
  it.each(['Insulated', 'Lyrical', 'ergonomic', 'trams/Dolmen', 'Valiant', 'Medium', 'Codeword', 'Morphing', 'Paracetamol'])('allows %s', (body) => {
    expect(bodyNamesProhibitedDrug(body, PROHIBITED_DRUG_NAMES)).toBe(false);
  });
  it.each([
    ['زانيىكس', 'زانییکس'],
    ['زانةكس', 'زانہکس'],
  ])('folds Arabic keyboard forms %s', (body, name) => {
    expect(bodyNamesProhibitedDrug(body, [name])).toBe(true);
  });
  it('normalizes repeated letters on the list side and keeps short boundaries', () => {
    expect(bodyNamesProhibitedDrug('Xanax', ['Xannax'])).toBe(true);
    expect(bodyNamesProhibitedDrug('scatters', ['cat'])).toBe(false);
  });
  const db = { medicine: { findMany: async () => [] } };
  it.each(['insulin pen needles', 'insulin cooler bag', 'insulin syringes', 'Lithium batteries for glucometers', 'lithium cell', 'Insulin ka pen', 'insulin ka cooler'])(
    'allows device accessory %s',
    async (body) => {
      await expect(assertMarketingCopyAllowed(db, 'tenant', body)).resolves.toBeUndefined();
    }
  );
  it.each([
    'Rx discount', 'prescription', 'nuskha', 'dawai discount', 'dawa discount',
    'دوائی کی رعایت', 'ask your doctor', 'medicine sale', 'نسخہ پر رعایت',
    '℞ discount', 'tablets', 'pills', 'syrup', 'antibiotics', 'زانیکس', 'لیریکا',
    'دوا کی رعایت', 'ڈاکٹر سے پوچھیں', 'xan ax',
  ])('refuses generic medicine or split drug promo: %s', async (body) => {
    await expect(assertMarketingCopyAllowed(db, 'tenant', body)).rejects.toThrow();
  });
  it.each(['Medicine box organizer', 'Prescription glasses', 'Nuskhay ki kitaab'])(
    'allows non-medicine product %s', async (body) => {
      await expect(assertMarketingCopyAllowed(db, 'tenant', body)).resolves.toBeUndefined();
      await expect(assertMarketingCopyAllowed(db, 'tenant', `${body} and medicine sale`)).rejects.toThrow();
    }
  );
  it('still blocks insulin outside the accessory phrase', async () => {
    await expect(
      assertMarketingCopyAllowed(db, 'tenant', 'insulin pen needles and insulin')
    ).rejects.toThrow();
  });
});

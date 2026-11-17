import { describe, expect, it } from 'vitest';

import { encodeQr, qrPenaltyScore, qrSvgPath } from './qr-code';

/**
 * DEV-748: the symbol for a loyalty card code, as decoded back to the same text by an
 * independent reader (OpenCV's QR detector) when this encoder was written. The encoder is
 * deterministic, so any change to it that alters a card's symbol fails here.
 */
const GOLDEN_CARD = [
  '#######.....##..#.....#######',
  '#.....#.#.....###..#..#.....#',
  '#.###.#..#...##.#..##.#.###.#',
  '#.###.#......###.####.#.###.#',
  '#.###.#.##..#.#.......#.###.#',
  '#.....#.....##...####.#.....#',
  '#######.#.#.#.#.#.#.#.#######',
  '...........#.##.##.#.........',
  '#.#.#.#..##.#.##........#..#.',
  '##..##.#.#.#..##.#####...#.#.',
  '.#.##.##.#.###......#...##.##',
  '####.#..#......#.###...##..#.',
  '#.##.####.#.....#....##.#.##.',
  '..###..###..##.#######...#.#.',
  '.#....##...#..####.....#.####',
  '.##..#..####.##.##..###....##',
  '#.#.#.#.####..##...####.#.###',
  '.....#..#.....##.#####...#.#.',
  '#..##.#.#.#.##...#..#......##',
  '.#.###..#.#....#.##.#.#....#.',
  '#..#.#####.##...#..######.###',
  '........###.##.##.###...##.#.',
  '#######..#.##.###.#.#.#.##.##',
  '#.....#..#..###.##..#...#..##',
  '#.###.#.###.#.###...#####.##.',
  '#.###.#....#####..#....#.....',
  '#.###.#.##.####.#.##..###.#.#',
  '#.....#..##.#....###..#....#.',
  '#######.########...##.###.###',
];

const render = (modules: boolean[][]) =>
  modules.map((row) => row.map((d) => (d ? '#' : '.')).join(''));

describe('DEV-748 QR encoder', () => {
  it('encodes a loyalty card code to the verified symbol', () => {
    expect(render(encodeQr('DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ'))).toEqual(GOLDEN_CARD);
  });

  it('picks the smallest version that holds the text, up to version 10', () => {
    expect(encodeQr('a')).toHaveLength(21);
    expect(encodeQr('x'.repeat(14))).toHaveLength(21);
    expect(encodeQr('x'.repeat(15))).toHaveLength(25);
    expect(encodeQr('DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ')).toHaveLength(29);
    expect(encodeQr('x'.repeat(213))).toHaveLength(57);
    expect(() => encodeQr('x'.repeat(214))).toThrow(RangeError);
  });

  it('draws the three finder patterns and the timing lines', () => {
    const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
    for (const text of ['a', 'x'.repeat(100), 'x'.repeat(200)]) {
      const modules = encodeQr(text);
      const size = modules.length;
      for (const [x0, y0] of [
        [0, 0],
        [size - 7, 0],
        [0, size - 7],
      ] as const)
        expect(render(modules.slice(y0, y0 + 7).map((row) => row.slice(x0, x0 + 7)))).toEqual(
          finder
        );
      for (let i = 8; i < size - 8; i++) {
        expect(modules[6]![i]).toBe(i % 2 === 0);
        expect(modules[i]![6]).toBe(i % 2 === 0);
      }
      // The dark module beside the bottom-left finder.
      expect(modules[size - 8]![8]).toBe(true);
    }
  });

  it('is deterministic and scores its chosen mask', () => {
    const text = 'DFLC7Q2MZXK4HNVB3LWRT5YPGCJD6E';
    expect(encodeQr(text)).toEqual(encodeQr(text));
    expect(qrPenaltyScore(encodeQr(text))).toBeGreaterThan(0);
  });

  it('renders dark modules as unit squares inside the quiet zone', () => {
    expect(
      qrSvgPath(
        [
          [true, false],
          [false, true],
        ],
        4
      )
    ).toBe('M4 4h1v1h-1zM5 5h1v1h-1z');
  });
});

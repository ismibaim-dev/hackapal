import { describe, expect, it } from 'vitest';
import {
  formatUsd,
  multiplyCents,
  parseDecimalString,
  sumCents,
  toDecimalString,
} from '../src/money.js';

describe('toDecimalString', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [100, '1.00'],
    [1200, '12.00'],
    [123456, '1234.56'],
  ])('%i cents -> "%s"', (cents, expected) => {
    expect(toDecimalString(cents)).toBe(expected);
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (bad) => {
      expect(() => toDecimalString(bad)).toThrow(RangeError);
    },
  );
});

describe('parseDecimalString', () => {
  it.each([
    ['12.00', 1200],
    ['12', 1200],
    ['12.5', 1250],
    ['0.05', 5],
    ['1234.56', 123456],
  ])('"%s" -> %i cents', (value, expected) => {
    expect(parseDecimalString(value)).toBe(expected);
  });

  it.each(['12.345', '-1.00', '1,000.00', '', ' 12.00', '1e3', '12.', '.50', 'USD 12'])(
    'rejects "%s"',
    (bad) => {
      expect(() => parseDecimalString(bad)).toThrow(RangeError);
    },
  );

  it('round-trips every amount up to $500', () => {
    for (let cents = 0; cents <= 50_000; cents++) {
      expect(parseDecimalString(toDecimalString(cents))).toBe(cents);
    }
  });
});

describe('cents arithmetic', () => {
  it('avoids the float trap that decimal dollars fall into', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toDecimalString(sumCents([10, 20]))).toBe('0.30');
  });

  it('multiplies and sums whole cents', () => {
    expect(multiplyCents(600, 2)).toBe(1200);
    expect(sumCents([1200, 800, 3600])).toBe(5600);
    expect(sumCents([])).toBe(0);
  });

  it('rejects fractional cents or quantities', () => {
    expect(() => multiplyCents(600.5, 2)).toThrow(RangeError);
    expect(() => multiplyCents(600, 1.5)).toThrow(RangeError);
    expect(() => sumCents([100, 0.5])).toThrow(RangeError);
  });

  it('formats for people', () => {
    expect(formatUsd(1200)).toBe('$12.00');
    expect(formatUsd(5)).toBe('$0.05');
  });
});

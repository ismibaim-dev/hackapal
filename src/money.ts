/**
 * Money is always an integer number of cents inside this service. Decimal strings
 * ("12.00") exist only at the edges: PayPal's amount.value and text shown to people.
 * Floats never touch money (0.1 + 0.2 !== 0.3).
 */
export type Currency = 'USD';

export function assertCents(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative whole number of cents, got ${value}`);
  }
}

/** 1200 -> "12.00": the format PayPal expects for USD amount.value. */
export function toDecimalString(cents: number): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** "12.00" -> 1200. Strict: digits with at most two decimals, nothing else. */
export function parseDecimalString(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new RangeError(`Not a valid USD amount: "${value}"`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  assertCents(cents);
  return cents;
}

/** 1200 -> "$12.00" for buyers, sellers and agents. */
export function formatUsd(cents: number): string {
  return `$${toDecimalString(cents)}`;
}

export function multiplyCents(unitCents: number, quantity: number): number {
  assertCents(unitCents, 'unit price');
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`quantity must be a non-negative whole number, got ${quantity}`);
  }
  const total = unitCents * quantity;
  assertCents(total, 'line total');
  return total;
}

export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertCents(value);
    total += value;
  }
  assertCents(total, 'total');
  return total;
}

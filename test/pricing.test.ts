import { describe, expect, it } from 'vitest';
import { AUNTIES_KITCHEN, createCatalog } from '../src/catalog.js';
import { toDecimalString } from '../src/money.js';
import { CartInputSchema, MAX_LINES, priceCart, type CartInput } from '../src/pricing.js';

const catalog = () => createCatalog();

/** Catalog with custom stock levels for out-of-stock cases. */
function catalogWithStock(stock: Record<string, number>) {
  return createCatalog({
    ...AUNTIES_KITCHEN,
    products: AUNTIES_KITCHEN.products.map((p) => ({ ...p, stock: stock[p.id] ?? p.stock })),
  });
}

function quote(input: CartInput, cat = catalog()) {
  const result = priceCart(cat, input);
  if (!result.ok) throw new Error(`expected a quote, got: ${JSON.stringify(result.issues)}`);
  return result.quote;
}

function issues(input: CartInput, cat = catalog()) {
  const result = priceCart(cat, input);
  if (result.ok) throw new Error('expected pricing issues, got a quote');
  return result.issues;
}

describe('priceCart: happy path', () => {
  it('prices 2 boxes of cookies at $12.00 from the catalog', () => {
    const q = quote({ items: [{ product_id: 'choc-chip-cookies', quantity: 2 }] });
    expect(q.lines).toEqual([
      {
        productId: 'choc-chip-cookies',
        name: 'Chocolate chip cookies',
        unit: 'box of 10',
        quantity: 2,
        unitPriceCents: 600,
        lineTotalCents: 1200,
      },
    ]);
    expect(q.itemTotalCents).toBe(1200);
    expect(q.totalCents).toBe(1200);
    expect(toDecimalString(q.totalCents)).toBe('12.00');
    expect(q.currency).toBe('USD');
  });

  it('sums a mixed cart in whole cents', () => {
    const q = quote({
      items: [
        { product_id: 'choc-chip-cookies', quantity: 2 },
        { product_id: 'kuih-lapis', quantity: 1 },
        { product_id: 'pineapple-tarts', quantity: 3 },
      ],
    });
    expect(q.lines.map((l) => l.lineTotalCents)).toEqual([1200, 800, 3600]);
    expect(q.totalCents).toBe(5600);
  });

  it('combines duplicate lines for the same product', () => {
    const q = quote({
      items: [
        { product_id: 'kuih-lapis', quantity: 3 },
        { product_id: 'kuih-lapis', quantity: 4 },
      ],
    });
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]).toMatchObject({ quantity: 7, lineTotalCents: 5600 });
  });

  it('is read-only: pricing does not take stock', () => {
    const cat = catalog();
    quote({ items: [{ product_id: 'pineapple-tarts', quantity: 10 }] }, cat);
    expect(cat.getProduct('pineapple-tarts')?.stock).toBe(10);
  });
});

describe('prices never come from the caller', () => {
  it('strips any price-like fields a model or client sends', () => {
    const parsed = CartInputSchema.parse({
      total: 1,
      items: [{ product_id: 'choc-chip-cookies', quantity: 2, unit_price: 0.01, price: '0.01' }],
    });
    expect(parsed).toEqual({ items: [{ product_id: 'choc-chip-cookies', quantity: 2 }] });
    expect(quote(parsed).totalCents).toBe(1200);
  });
});

describe('validation', () => {
  it('reports unknown products with the valid ids, so an agent can recover', () => {
    const [issue] = issues({ items: [{ product_id: 'mystery-box', quantity: 1 }] });
    expect(issue).toMatchObject({ code: 'UNKNOWN_PRODUCT', productId: 'mystery-box' });
    expect(issue?.message).toContain('choc-chip-cookies, kuih-lapis, pineapple-tarts');
  });

  it.each([0, 11, 1.5, -1])('schema rejects quantity %s', (quantity) => {
    const result = CartInputSchema.safeParse({ items: [{ product_id: 'kuih-lapis', quantity }] });
    expect(result.success).toBe(false);
  });

  it('schema rejects missing or non-numeric quantities and empty or oversized carts', () => {
    expect(CartInputSchema.safeParse({ items: [{ product_id: 'kuih-lapis' }] }).success).toBe(false);
    expect(CartInputSchema.safeParse({ items: [{ product_id: 'kuih-lapis', quantity: '2' }] }).success).toBe(
      false,
    );
    expect(CartInputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(CartInputSchema.safeParse({}).success).toBe(false);
    const tooMany = Array.from({ length: MAX_LINES + 1 }, () => ({ product_id: 'kuih-lapis', quantity: 1 }));
    expect(CartInputSchema.safeParse({ items: tooMany }).success).toBe(false);
  });

  it('caps a product at 10 per order even across duplicate lines', () => {
    const [issue] = issues({
      items: [
        { product_id: 'choc-chip-cookies', quantity: 6 },
        { product_id: 'choc-chip-cookies', quantity: 5 },
      ],
    });
    expect(issue).toMatchObject({ code: 'INVALID_QUANTITY', quantity: 11 });
    expect(issue?.message).toContain('after combining duplicate lines');
  });

  it('re-checks quantities for callers that skipped the schema', () => {
    const unvalidated = {
      items: [
        { product_id: 'choc-chip-cookies', quantity: -3 },
        { product_id: 'choc-chip-cookies', quantity: 5 },
        { product_id: 'kuih-lapis', quantity: 0 },
      ],
    } as CartInput;
    const found = issues(unvalidated);
    expect(found.map((i) => [i.code, i.productId])).toEqual([
      ['INVALID_QUANTITY', 'choc-chip-cookies'],
      ['INVALID_QUANTITY', 'kuih-lapis'],
    ]);
  });

  it('reports sold-out products', () => {
    const [issue] = issues(
      { items: [{ product_id: 'pineapple-tarts', quantity: 1 }] },
      catalogWithStock({ 'pineapple-tarts': 0 }),
    );
    expect(issue).toMatchObject({ code: 'OUT_OF_STOCK', requested: 1, available: 0 });
    expect(issue?.message).toBe('"Pineapple tarts" is sold out.');
  });

  it('reports how many are left when stock is short', () => {
    const [issue] = issues(
      { items: [{ product_id: 'pineapple-tarts', quantity: 5 }] },
      catalogWithStock({ 'pineapple-tarts': 3 }),
    );
    expect(issue).toMatchObject({ code: 'OUT_OF_STOCK', requested: 5, available: 3 });
    expect(issue?.message).toBe('Only 3 left of "Pineapple tarts" (asked for 5).');
  });

  it('collects every problem at once instead of stopping at the first', () => {
    const found = issues(
      {
        items: [
          { product_id: 'mystery-box', quantity: 1 },
          { product_id: 'pineapple-tarts', quantity: 2 },
          { product_id: 'choc-chip-cookies', quantity: 1 },
        ],
      },
      catalogWithStock({ 'pineapple-tarts': 0 }),
    );
    expect(found.map((i) => i.code)).toEqual(['UNKNOWN_PRODUCT', 'OUT_OF_STOCK']);
  });
});

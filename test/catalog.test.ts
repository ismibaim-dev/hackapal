import { describe, expect, it } from 'vitest';
import { AUNTIES_KITCHEN, createCatalog } from '../src/catalog.js';

describe("Auntie's Kitchen catalog", () => {
  it('has the menu at the agreed prices', () => {
    const catalog = createCatalog();
    expect(catalog.shop).toMatchObject({ name: "Auntie's Kitchen", currency: 'USD' });
    expect(
      catalog.listProducts().map((p) => ({ id: p.id, unit: p.unit, priceCents: p.priceCents })),
    ).toEqual([
      { id: 'choc-chip-cookies', unit: 'box of 10', priceCents: 600 },
      { id: 'kuih-lapis', unit: '12 pieces', priceCents: 800 },
      { id: 'pineapple-tarts', unit: 'jar of 20', priceCents: 1200 },
      { id: 'kuih-seri-muka', unit: '12 pieces', priceCents: 900 },
      { id: 'onde-onde', unit: '15 pieces', priceCents: 700 },
      { id: 'curry-puffs', unit: 'box of 6', priceCents: 800 },
      { id: 'kuih-bahulu', unit: 'tub of 30', priceCents: 1000 },
      { id: 'pandan-chiffon', unit: '8-inch cake', priceCents: 1500 },
    ]);
    for (const product of catalog.listProducts()) {
      expect(product.description.length).toBeGreaterThan(10);
      expect(Number.isSafeInteger(product.stock) && product.stock > 0).toBe(true);
    }
  });

  it('sets stock to an absolute level and rejects bad input', () => {
    const catalog = createCatalog();
    catalog.setStock('kuih-lapis', 40);
    expect(catalog.getProduct('kuih-lapis')?.stock).toBe(40);
    expect(() => catalog.setStock('caviar', 1)).toThrow(/Unknown product/);
    expect(() => catalog.setStock('kuih-lapis', -1)).toThrow(RangeError);
    expect(() => catalog.setStock('kuih-lapis', 1.5)).toThrow(RangeError);
  });

  it('hands out copies, so callers cannot change prices or stock', () => {
    const catalog = createCatalog();
    const [first] = catalog.listProducts();
    first!.priceCents = 1;
    first!.stock = 999;
    const fresh = catalog.getProduct('choc-chip-cookies');
    expect(fresh?.priceCents).toBe(600);
    expect(fresh?.stock).toBe(24);
  });

  it('takes stock after a sale, clamping at zero and reporting any shortfall', () => {
    const catalog = createCatalog();
    expect(catalog.takeStock('pineapple-tarts', 3)).toEqual({ remaining: 7, shortBy: 0 });
    expect(catalog.takeStock('pineapple-tarts', 9)).toEqual({ remaining: 0, shortBy: 2 });
    expect(catalog.getProduct('pineapple-tarts')?.stock).toBe(0);
  });

  it('rejects unknown products and bad quantities when taking stock', () => {
    const catalog = createCatalog();
    expect(() => catalog.takeStock('mystery-box', 1)).toThrow(/Unknown product/);
    expect(() => catalog.takeStock('kuih-lapis', -1)).toThrow(RangeError);
  });

  it('never mutates the seed data', () => {
    createCatalog().takeStock('choc-chip-cookies', 5);
    expect(AUNTIES_KITCHEN.products[0]?.stock).toBe(24);
    expect(createCatalog().getProduct('choc-chip-cookies')?.stock).toBe(24);
  });
});

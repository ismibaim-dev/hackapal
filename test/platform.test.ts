import { describe, expect, it } from 'vitest';
import { AUNTIES_KITCHEN, createCatalog, KAMPUNG_FRESH_MART, SHOPS } from '../src/catalog.js';
import { createPlatform, platformFromCatalogs, PlatformConfigError, publicShop } from '../src/platform.js';

describe('demo shops', () => {
  it('are three shops with unique product ids and complete shop details', () => {
    const platform = createPlatform();
    expect(platform.shops().map((s) => s.id)).toEqual(['aunties-kitchen', 'kampung-fresh-mart', 'kilat-home-cleaning']);
    const ids = SHOPS.flatMap((s) => s.products.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const shop of SHOPS) {
      expect(shop.category && shop.area && shop.fulfilment).toBeTruthy();
      for (const p of shop.products) {
        expect(Number.isSafeInteger(p.priceCents) && p.priceCents > 0).toBe(true);
        expect(Number.isSafeInteger(p.stock) && p.stock >= 0).toBe(true);
      }
    }
  });

  it('route the grocer and the cleaner to their own PayPal account', () => {
    const platform = createPlatform();
    expect(platform.shop('aunties-kitchen')?.payeeEmail).toBeUndefined();
    expect(platform.shop('kampung-fresh-mart')?.payeeEmail).toBe('sb-cjqou53656464@business.example.com');
    expect(platform.shop('kilat-home-cleaning')?.payeeEmail).toBe('sb-cjqou53656464@business.example.com');
  });
});

describe('platformFromCatalogs', () => {
  it('finds the shop of a product and delegates stock to the owning catalog', () => {
    const platform = createPlatform();
    expect(platform.shopOfProduct('eggs-30')?.name).toBe('Kampung Fresh Mart');
    expect(platform.shopOfProduct('caviar')).toBeUndefined();
    expect(platform.inventory.productIds()).toHaveLength(18);

    expect(platform.inventory.takeStock('eggs-30', 5)).toEqual({ remaining: 35, shortBy: 0 });
    expect(platform.catalog('kampung-fresh-mart')?.getProduct('eggs-30')?.stock).toBe(35);
    platform.inventory.setStock('deep-clean-6h', 2);
    expect(platform.catalog('kilat-home-cleaning')?.getProduct('deep-clean-6h')?.stock).toBe(2);
    expect(() => platform.inventory.takeStock('caviar', 1)).toThrow(/Unknown product/);
  });

  it('refuses duplicate shop ids and product ids shared between shops', () => {
    expect(() => platformFromCatalogs([createCatalog(AUNTIES_KITCHEN), createCatalog(AUNTIES_KITCHEN)])).toThrow(PlatformConfigError);
    const copycat = { ...KAMPUNG_FRESH_MART, id: 'copycat', products: [AUNTIES_KITCHEN.products[0]!] };
    expect(() => platformFromCatalogs([createCatalog(AUNTIES_KITCHEN), createCatalog(copycat)])).toThrow(/choc-chip-cookies/);
    expect(() => platformFromCatalogs([])).toThrow(PlatformConfigError);
  });

  it("publicShop leaves out the seller's PayPal account", () => {
    expect(publicShop(KAMPUNG_FRESH_MART)).not.toHaveProperty('payeeEmail');
    expect(publicShop(KAMPUNG_FRESH_MART).name).toBe('Kampung Fresh Mart');
  });
});

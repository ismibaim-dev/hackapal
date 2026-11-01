import type { Currency } from './money.js';

export interface Product {
  /** Stable id that agents pass to create_order. */
  id: string;
  name: string;
  description: string;
  /** What one unit is, e.g. "box of 10". */
  unit: string;
  priceCents: number;
  /** Units available right now. */
  stock: number;
}

export interface ShopInfo {
  id: string;
  name: string;
  description: string;
  /** How the buyer gets their order; there is no shipping step at checkout. */
  fulfilment: string;
  currency: Currency;
}

export interface ShopSeed extends ShopInfo {
  products: readonly Product[];
}

/** The demo seller. Hardcoded for the spike; prices are the single source of truth. */
export const AUNTIES_KITCHEN: Readonly<ShopSeed> = Object.freeze({
  id: 'aunties-kitchen',
  name: "Auntie's Kitchen",
  description: 'A home baker selling cookies and traditional kuih, baked to order.',
  fulfilment:
    'Baked to order. After payment the seller contacts the buyer to arrange pickup or local delivery.',
  currency: 'USD',
  products: Object.freeze([
    {
      id: 'choc-chip-cookies',
      name: 'Chocolate chip cookies',
      description: 'Chewy, buttery chocolate chip cookies, baked fresh to order. One box holds 10 cookies.',
      unit: 'box of 10',
      priceCents: 600,
      stock: 24,
    },
    {
      id: 'kuih-lapis',
      name: 'Kuih lapis',
      description: 'Steamed rainbow layer cake made with coconut milk, soft and lightly sweet. 12 pieces.',
      unit: '12 pieces',
      priceCents: 800,
      stock: 15,
    },
    {
      id: 'pineapple-tarts',
      name: 'Pineapple tarts',
      description: 'Butter pastry topped with slow-cooked pineapple jam. One jar holds 20 tarts.',
      unit: 'jar of 20',
      priceCents: 1200,
      stock: 10,
    },
  ]),
});

export interface StockResult {
  remaining: number;
  /** Units we could not cover (oversold). 0 in the normal case. */
  shortBy: number;
}

export interface Catalog {
  readonly shop: Readonly<ShopInfo>;
  /** Copies, so callers can't change prices or stock by accident. */
  listProducts(): Product[];
  getProduct(id: string): Product | undefined;
  productIds(): string[];
  /**
   * Remove sold units after a capture completes. Money has already moved by then,
   * so this never refuses: it clamps at zero and reports any shortfall.
   */
  takeStock(productId: string, quantity: number): StockResult;
}

export function createCatalog(seed: Readonly<ShopSeed> = AUNTIES_KITCHEN): Catalog {
  const { products: seedProducts, ...shop } = seed;
  const products = new Map(seedProducts.map((p) => [p.id, { ...p }]));

  return {
    shop: Object.freeze({ ...shop }),
    listProducts: () => [...products.values()].map((p) => ({ ...p })),
    getProduct: (id) => {
      const product = products.get(id);
      return product ? { ...product } : undefined;
    },
    productIds: () => [...products.keys()],
    takeStock: (productId, quantity) => {
      const product = products.get(productId);
      if (!product) throw new Error(`Unknown product: ${productId}`);
      if (!Number.isSafeInteger(quantity) || quantity < 0) {
        throw new RangeError(`quantity must be a non-negative whole number, got ${quantity}`);
      }
      const shortBy = Math.max(0, quantity - product.stock);
      product.stock = Math.max(0, product.stock - quantity);
      return { remaining: product.stock, shortBy };
    },
  };
}

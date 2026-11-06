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
  description: 'A home baker selling cookies, traditional kuih and cakes, baked to order.',
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
    {
      id: 'kuih-seri-muka',
      name: 'Kuih seri muka',
      description: 'Two-layer kuih: steamed glutinous rice under a silky pandan custard. 12 pieces.',
      unit: '12 pieces',
      priceCents: 900,
      stock: 20,
    },
    {
      id: 'onde-onde',
      name: 'Onde-onde',
      description: 'Pandan glutinous rice balls filled with molten palm sugar and rolled in fresh coconut. 15 pieces.',
      unit: '15 pieces',
      priceCents: 700,
      stock: 25,
    },
    {
      id: 'curry-puffs',
      name: 'Curry puffs',
      description: 'Flaky spiral pastry filled with spiced potato and chicken curry. Box of 6.',
      unit: 'box of 6',
      priceCents: 800,
      stock: 30,
    },
    {
      id: 'kuih-bahulu',
      name: 'Kuih bahulu',
      description: 'Light mini sponge cakes with crisp edges, baked in traditional moulds. Tub of 30.',
      unit: 'tub of 30',
      priceCents: 1000,
      stock: 20,
    },
    {
      id: 'pandan-chiffon',
      name: 'Pandan chiffon cake',
      description: 'Tall, airy chiffon cake made with fresh pandan juice and coconut milk. One 8-inch cake.',
      unit: '8-inch cake',
      priceCents: 1500,
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
  /** Set a product's stock to an absolute level (seller restock). */
  setStock(productId: string, stock: number): void;
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
    setStock: (productId, stock) => {
      const product = products.get(productId);
      if (!product) throw new Error(`Unknown product: ${productId}`);
      if (!Number.isSafeInteger(stock) || stock < 0) {
        throw new RangeError(`stock must be a non-negative whole number, got ${stock}`);
      }
      product.stock = stock;
    },
  };
}

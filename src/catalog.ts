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
  /** What kind of seller this is, e.g. "Home bakery". Helps agents pick a shop. */
  category: string;
  /** Where the seller operates (pickup, delivery or service area). */
  area: string;
  /** How the buyer gets their order; there is no shipping step at checkout. */
  fulfilment: string;
  currency: Currency;
  /**
   * The seller's PayPal account (option B, design decision 16). Orders for this shop name it
   * as purchase_units[0].payee, so PayPal pays the seller directly; the platform never holds
   * the money. Omitted: the account that owns our REST app receives it.
   */
  payeeEmail?: string;
}

export interface ShopSeed extends ShopInfo {
  products: readonly Product[];
}

/** Demo sellers. Defined in code for the hackathon; prices here are the single source of truth. */
export const AUNTIES_KITCHEN: Readonly<ShopSeed> = Object.freeze({
  id: 'aunties-kitchen',
  name: "Auntie's Kitchen",
  description: 'A home baker selling cookies, traditional kuih and cakes, baked to order.',
  category: 'Home bakery',
  area: 'Shah Alam, Selangor',
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

/**
 * A neighbourhood grocer with its own payee setting. Note: johndblend@business.example.com turned out
 * to be the account that owns our REST app (BUILD_LOG M2), so until a second sandbox merchant
 * exists this pays the same account as Auntie's Kitchen.
 */
export const KAMPUNG_FRESH_MART: Readonly<ShopSeed> = Object.freeze({
  id: 'kampung-fresh-mart',
  name: 'Kampung Fresh Mart',
  description: 'A neighbourhood grocer delivering daily essentials and fresh produce.',
  category: 'Groceries',
  area: 'Shah Alam, Selangor',
  fulfilment:
    'Same-day delivery within 5 km, or pickup at the shop. After payment the grocer confirms the delivery time.',
  currency: 'USD',
  payeeEmail: 'johndblend@business.example.com',
  products: Object.freeze([
    { id: 'eggs-30', name: 'Grade A eggs', description: 'Fresh grade A chicken eggs from a local farm. Tray of 30.', unit: 'tray of 30', priceCents: 550, stock: 40 },
    { id: 'jasmine-rice-5kg', name: 'Jasmine rice', description: 'Fragrant long-grain jasmine rice. 5 kg bag.', unit: '5 kg bag', priceCents: 900, stock: 30 },
    { id: 'whole-chicken', name: 'Fresh whole chicken', description: 'Fresh whole chicken, about 1.5 kg, cleaned and ready to cook.', unit: 'about 1.5 kg', priceCents: 800, stock: 20 },
    { id: 'veg-bundle', name: 'Kampung vegetable bundle', description: 'Kangkung, bayam and sawi picked this morning. About 1.5 kg in total.', unit: 'bundle', priceCents: 400, stock: 25 },
    { id: 'cooking-oil-2l', name: 'Cooking oil', description: 'Refined palm cooking oil. 2 litre bottle.', unit: '2 L bottle', priceCents: 600, stock: 30 },
    { id: 'fresh-santan-1kg', name: 'Fresh santan', description: 'Coconut milk squeezed fresh the same day. 1 kg pack.', unit: '1 kg pack', priceCents: 350, stock: 20 },
  ]),
});

/** A home-cleaning service. Each "unit" is one booked visit; stock is open slots this week. */
export const KILAT_HOME_CLEANING: Readonly<ShopSeed> = Object.freeze({
  id: 'kilat-home-cleaning',
  name: 'Kilat Home Cleaning',
  description: 'Vetted home cleaners for apartments and terrace houses. All supplies brought along.',
  category: 'Home cleaning',
  area: 'Petaling Jaya and Shah Alam, Selangor',
  fulfilment:
    'Each unit is one booked visit, and stock is the number of open slots this week. After payment the team contacts the buyer to confirm the date, time and address.',
  currency: 'USD',
  payeeEmail: 'johndblend@business.example.com',
  products: Object.freeze([
    { id: 'standard-clean-3h', name: 'Standard home clean', description: 'One cleaner for 3 hours: dusting, mopping, kitchen and bathrooms.', unit: '1 visit, 3 hours', priceCents: 4500, stock: 12 },
    { id: 'deep-clean-6h', name: 'Deep clean', description: 'Two cleaners for 6 hours, including inside cabinets, windows and grout.', unit: '1 visit, 6 hours', priceCents: 12000, stock: 6 },
    { id: 'move-out-clean', name: 'Move-in or move-out clean', description: 'Full clean of an empty unit up to 1,200 sq ft, ready for handover.', unit: '1 visit', priceCents: 15000, stock: 4 },
    { id: 'sofa-shampoo', name: 'Sofa shampoo', description: 'Fabric sofa shampoo and vacuum, up to a 3-seater.', unit: '1 sofa', priceCents: 4000, stock: 10 },
  ]),
});

/** Every shop on the platform, in the order agents see them. */
export const SHOPS: readonly Readonly<ShopSeed>[] = Object.freeze([AUNTIES_KITCHEN, KAMPUNG_FRESH_MART, KILAT_HOME_CLEANING]);

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
